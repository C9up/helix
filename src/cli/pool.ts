/**
 * Worker pool — spawns a Node child process per file and collects the
 * framed result from the worker's stderr.
 *
 * Robustness features (2026-04-24 review pass):
 *   - UTF-8 safe chunking via `node:string_decoder`
 *   - Drains stdout so chatty `console.log` can't fill the pipe buffer
 *   - SIGTERM → SIGKILL escalation after a grace window
 *   - Process groups (`detached: true`) so grand-children die with the parent
 *   - SIGINT handler that kills every in-flight worker cleanly
 *   - Nonce in the frame instruction prevents a test file from spoofing results
 *   - Reporter callbacks wrapped in try/catch so a buggy reporter can't crash the run
 *   - Argv / config validation (threads, timeout) happens upstream; pool normalises
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import type { FileResult } from "../runtime/run.js";
import type { Reporter } from "./reporter.js";

export interface PoolConfig {
	/** Absolute path to the CLI worker entry (cli-worker.ts). */
	workerEntry: string;
	/** Node executable to spawn. Default: `process.execPath`. */
	nodeBin?: string;
	/** Extra args before the worker entry, e.g. `["--import", "<tsx-loader>"]`. */
	nodeArgs?: string[];
	/** Concurrent workers. Default: `os.cpus().length`. */
	threads?: number;
	/** Per-file timeout (ms). Default 60 000. */
	timeoutMs?: number;
	/**
	 * Grace period (ms) between SIGTERM and SIGKILL when killing a hanging
	 * worker. Default 2 000.
	 */
	killGraceMs?: number;
	/**
	 * Extra environment variables merged into every spawned worker's env.
	 * Used by coverage to forward `NODE_V8_COVERAGE=<tmp-dir>`.
	 */
	extraEnv?: NodeJS.ProcessEnv;
}

export interface WorkerErrorMessage {
	file: string | undefined;
	message: string;
	stack?: string;
}

export type FileOutcome =
	| { kind: "result"; result: FileResult }
	| { kind: "error"; error: WorkerErrorMessage };

const FRAME_PREFIX = "__HELIX_RESULT__";
/** Maximum stderr buffering before we give up and mark the file errored. */
const MAX_STDERR_BUFFER_BYTES = 4 * 1024 * 1024; // 4 MiB
/**
 * Magic nonce the worker uses for errors it emits BEFORE receiving the
 * instruction (so before it knows the real nonce). Accepted by the parent
 * only for `type === "error"` frames so a fixture can't spoof results.
 */
const PRE_HANDSHAKE_NONCE = "__helix_pre_handshake__";

interface ActiveChild {
	kill(): void;
}

/** Tracks every spawned worker so SIGINT can tear them all down. */
const activeChildren = new Set<ActiveChild>();
let sigintInstalled = false;

function installSigintHandlerOnce(): void {
	if (sigintInstalled) return;
	sigintInstalled = true;
	const tearDown = (signal: NodeJS.Signals): void => {
		for (const child of activeChildren) {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
		}
		process.off(signal, tearDown);
		process.kill(process.pid, signal);
	};
	process.once("SIGINT", tearDown);
	process.once("SIGTERM", tearDown);
}

/**
 * FIFO counting semaphore. Waiters resolve in the order they called
 * `acquire()` when a permit is released.
 */
class Semaphore {
	#permits: number;
	readonly #waiters: Array<() => void> = [];
	constructor(initial: number) {
		if (!Number.isFinite(initial) || initial < 1) {
			throw new Error(
				`Semaphore: initial permits must be a finite number >= 1, got ${initial}`,
			);
		}
		this.#permits = Math.floor(initial);
	}
	async acquire(): Promise<() => void> {
		if (this.#permits > 0) {
			this.#permits -= 1;
			return this.#makeRelease();
		}
		return new Promise((resolve) => {
			this.#waiters.push(() => resolve(this.#makeRelease()));
		});
	}
	#makeRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#waiters.shift();
			if (next) {
				next();
			} else {
				this.#permits += 1;
			}
		};
	}
}

function safeCall<T>(fn: () => T, context: string): T | undefined {
	try {
		return fn();
	} catch (err) {
		process.stderr.write(
			`helix: reporter.${context} threw — ${err instanceof Error ? err.message : String(err)}\n`,
		);
		return undefined;
	}
}

const LOADER_FLAG_PREFIXES = [
	"--import",
	"--loader",
	"--experimental-loader",
	"--experimental-vm-modules",
	"--experimental-specifier-resolution",
	"--conditions",
];

function inheritedLoaderArgs(): string[] {
	const out: string[] = [];
	const argv = process.execArgv;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined) continue;
		const prefix = LOADER_FLAG_PREFIXES.find(
			(p) => arg === p || arg.startsWith(`${p}=`),
		);
		if (prefix === undefined) continue;
		out.push(arg);
		// Flags written as `--import tsx` (space-separated) consume the next argv entry.
		if (arg === prefix) {
			const next = argv[i + 1];
			if (next !== undefined) {
				out.push(next);
				i += 1;
			}
		}
	}
	return out;
}

export async function runPool(
	files: string[],
	cfg: PoolConfig,
	reporter: Reporter,
): Promise<{ results: FileResult[]; errors: WorkerErrorMessage[] }> {
	installSigintHandlerOnce();

	const effectiveThreads = Math.max(
		1,
		Math.min(
			cfg.threads ?? os.cpus().length,
			files.length > 0 ? files.length : 1,
		),
	);
	const sem = new Semaphore(effectiveThreads);
	const results: FileResult[] = [];
	const errors: WorkerErrorMessage[] = [];

	await Promise.all(
		files.map(async (file) => {
			const absFile = path.isAbsolute(file) ? file : path.resolve(file);
			const release = await sem.acquire();
			try {
				safeCall(() => reporter.onFileStart(absFile), "onFileStart");
				const outcome = await runOne(absFile, cfg);
				if (outcome.kind === "result") {
					safeCall(() => reporter.onFileResult(outcome.result), "onFileResult");
					results.push(outcome.result);
				} else {
					safeCall(() => reporter.onFileError(outcome.error), "onFileError");
					errors.push(outcome.error);
				}
			} finally {
				release();
			}
		}),
	);

	return { results, errors };
}

function runOne(file: string, cfg: PoolConfig): Promise<FileOutcome> {
	return new Promise((resolve) => {
		const nodeBin = cfg.nodeBin ?? process.execPath;
		// Inherit the parent process's --import / --loader / --experimental-*
		// flags by default. This is what keeps the spawned worker able to
		// execute the .ts worker entry when the parent runs under a TS loader
		// (@swc-node/register, tsx, ts-node/esm, …). Callers that want the
		// child to run with a clean argv pass `nodeArgs: []` explicitly.
		const nodeArgs = cfg.nodeArgs ?? inheritedLoaderArgs();
		const timeoutMs =
			Number.isFinite(cfg.timeoutMs) && (cfg.timeoutMs ?? 0) > 0
				? Math.floor(cfg.timeoutMs as number)
				: 60_000;
		const killGraceMs =
			Number.isFinite(cfg.killGraceMs) && (cfg.killGraceMs ?? 0) > 0
				? Math.floor(cfg.killGraceMs as number)
				: 2_000;
		// Per-invocation nonce — the worker echoes it inside every frame so
		// malicious or confused test code can't spoof a `__HELIX_RESULT__` line.
		const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

		const child = spawn(nodeBin, [...nodeArgs, cfg.workerEntry], {
			stdio: ["pipe", "pipe", "pipe"],
			// `detached: true` on POSIX creates a new process group. On
			// termination we kill the whole group so grand-children die too.
			detached: process.platform !== "win32",
			env: cfg.extraEnv ? { ...process.env, ...cfg.extraEnv } : process.env,
		});

		const registration: ActiveChild = {
			kill: () => killChild(child, killGraceMs),
		};
		activeChildren.add(registration);

		let settled = false;
		let pendingOutcome: FileOutcome | undefined;
		const settle = (outcome: FileOutcome): void => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog);
			activeChildren.delete(registration);
			resolve(outcome);
		};
		/**
		 * Schedule resolution. On a `result` or `error` frame from the
		 * worker (`forceKill = false`) we wait for `child.on("exit")` so
		 * `atExit` hooks (e.g. V8 coverage writer) finish flushing before
		 * we let downstream code read the coverage dir. On a timeout or
		 * spawn error (`forceKill = true`) we kill it now and resolve
		 * immediately — there's no useful flush to wait for.
		 */
		const finish = (outcome: FileOutcome, forceKill = false): void => {
			if (settled) return;
			if (forceKill) {
				killChild(child, killGraceMs);
				settle(outcome);
				return;
			}
			// Defer resolution until exit — but if the child has already
			// exited (race), settle now.
			if (child.exitCode !== null || child.signalCode !== null) {
				settle(outcome);
				return;
			}
			pendingOutcome = outcome;
		};

		const watchdog = setTimeout(() => {
			// The worker already emitted a valid result/error frame and we're
			// only waiting on its (slow) exit to flush coverage — kill it to
			// reclaim the slot but settle the REAL outcome. Without this guard
			// the still-armed watchdog would overwrite a passing file with a
			// spurious timeout failure.
			if (pendingOutcome !== undefined) {
				killChild(child, killGraceMs);
				settle(pendingOutcome);
				return;
			}
			finish(
				{
					kind: "error",
					error: {
						file,
						message: `worker timed out after ${timeoutMs}ms`,
					},
				},
				true,
			);
		}, timeoutMs + killGraceMs);
		watchdog.unref?.();

		// UTF-8-safe accumulator for stderr frame parsing.
		const decoder = new StringDecoder("utf8");
		let stderrBuffer = "";

		const processLine = (line: string): void => {
			if (!line.startsWith(FRAME_PREFIX)) {
				if (process.env.HELIX_DEBUG_POOL) {
					process.stderr.write(`[helix-debug] worker stderr: ${line}\n`);
				}
				return;
			}
			const payload = line.slice(FRAME_PREFIX.length);
			let msg: unknown;
			try {
				msg = JSON.parse(payload);
			} catch {
				return;
			}
			if (!msg || typeof msg !== "object") return;
			const m = msg as {
				nonce?: unknown;
				type?: unknown;
				result?: FileResult;
				file?: string;
				message?: string;
				stack?: string;
			};
			// Reject frames without the matching nonce — prevents a fixture
			// that writes `__HELIX_RESULT__...` on stderr from spoofing.
			// Exception: pre-handshake error frames (worker couldn't parse
			// its own instruction and doesn't know the real nonce yet) are
			// accepted only for `type === "error"` so a fixture still can't
			// claim a fake success.
			const nonceOk =
				m.nonce === nonce ||
				(m.nonce === PRE_HANDSHAKE_NONCE && m.type === "error");
			if (!nonceOk) return;
			if (m.type === "result" && m.result) {
				finish({ kind: "result", result: m.result });
			} else if (m.type === "error") {
				finish({
					kind: "error",
					error: {
						file: m.file ?? file,
						message: m.message ?? "unknown worker error",
						stack: m.stack,
					},
				});
			}
		};

		child.stderr?.on("data", (chunk: Buffer) => {
			const text = decoder.write(chunk);
			stderrBuffer += text;
			if (stderrBuffer.length > MAX_STDERR_BUFFER_BYTES) {
				finish(
					{
						kind: "error",
						error: {
							file,
							message: `worker stderr exceeded ${MAX_STDERR_BUFFER_BYTES} bytes without emitting a frame`,
						},
					},
					true,
				);
				return;
			}
			let nl = stderrBuffer.indexOf("\n");
			while (nl >= 0 && !settled) {
				const line = stderrBuffer.slice(0, nl);
				stderrBuffer = stderrBuffer.slice(nl + 1);
				processLine(line);
				nl = stderrBuffer.indexOf("\n");
			}
		});

		// Drain stdout so a chatty `console.log` can't fill the 64 KB pipe
		// buffer and deadlock the worker. We don't currently surface it to
		// the reporter (Phase 2 feature).
		child.stdout?.on("data", () => {});

		child.on("error", (err) => {
			finish(
				{
					kind: "error",
					error: { file, message: `spawn failed: ${err.message}` },
				},
				true,
			);
		});

		child.on("exit", () => {
			// If we already have an outcome waiting on the natural exit,
			// resolve it now — coverage hooks have flushed.
			if (pendingOutcome) {
				settle(pendingOutcome);
				return;
			}
			if (settled) return;
			// Flush any partial trailing line from the decoder before giving up.
			const trailing = decoder.end();
			if (trailing) {
				stderrBuffer += trailing;
				const nl = stderrBuffer.indexOf("\n");
				if (nl >= 0) processLine(stderrBuffer.slice(0, nl));
			}
			if (pendingOutcome) {
				settle(pendingOutcome);
				return;
			}
			if (settled) return;
			settle({
				kind: "error",
				error: {
					file,
					message: "worker exited without emitting a framed result",
				},
			});
		});

		// Instruction line.
		const instr = JSON.stringify({
			type: "run",
			file,
			timeoutMs,
			nonce,
		});
		// `child.stdin` may be closed by the time we get here (rare spawn race).
		// Attach an error listener so an EPIPE doesn't crash the parent.
		child.stdin?.on("error", (err) => {
			finish(
				{
					kind: "error",
					error: { file, message: `stdin write failed: ${err.message}` },
				},
				true,
			);
		});
		child.stdin?.write(`${instr}\n`, () => {
			child.stdin?.end();
		});
	});
}

/**
 * Kill `child` with SIGTERM, escalate to SIGKILL after `graceMs`. On POSIX
 * we target the process group (negative pid) so grand-children die too.
 *
 * Idempotent: further calls after the first are no-ops. If the child has
 * already exited (cleanly or via an earlier kill), no signals are sent and
 * no escalation timer is armed — which matters for large suites where a
 * per-file 2s timer retains the `child` closure and creates GC pressure,
 * and for Linux systems where pid reuse could deliver SIGKILL to the wrong
 * process.
 */
const killedChildren = new WeakSet<ReturnType<typeof spawn>>();

function killChild(child: ReturnType<typeof spawn>, graceMs: number): void {
	if (killedChildren.has(child)) return;
	killedChildren.add(child);
	// If the child already exited on its own, nothing to do — no SIGTERM,
	// no escalation timer.
	if (child.killed || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	const pid = child.pid;
	const posix = process.platform !== "win32";
	const trySignal = (signal: NodeJS.Signals): void => {
		// Re-check exit status on each signal to avoid pid-reuse races: the
		// child may have exited between our initial check and this send.
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			if (posix && typeof pid === "number") {
				process.kill(-pid, signal);
			} else {
				child.kill(signal);
			}
		} catch {
			/* already dead, permission denied, or process-group invalid */
		}
	};
	trySignal("SIGTERM");
	// Escalate after the grace window if the child is still alive. Cleared
	// by `child.on("exit")` so a clean exit drops the timer immediately.
	const escalation = setTimeout(() => {
		trySignal("SIGKILL");
	}, graceMs);
	escalation.unref?.();
	child.once("exit", () => clearTimeout(escalation));
}
