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
import { FRAME_PREFIX, PRE_HANDSHAKE_NONCE } from "../runtime/ipc-protocol.js";
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
	/**
	 * Per-test timeout (ms) handed to the worker, above `configure({ timeout })`
	 * — the `--timeout` flag or a suite's own. Unset, the worker decides.
	 */
	timeoutMs?: number;
	/**
	 * Per-test timeout (ms) the worker falls back to when neither
	 * {@link PoolConfig.timeoutMs} nor `configure({ timeout })` set one — the
	 * config file's `timeout`.
	 */
	defaultTimeoutMs?: number;
	/**
	 * How long one file may run before its worker is killed (ms). Default
	 * {@link DEFAULT_FILE_TIMEOUT_MS}. A safety net for a worker stuck where no
	 * test or hook timeout reaches it — a synchronous loop — so it is sized for
	 * a whole file, never taken from the per-test timeout.
	 */
	fileTimeoutMs?: number;
	/**
	 * Grace period (ms) between SIGTERM and SIGKILL when killing a hanging
	 * worker. Default 2 000.
	 */
	killGraceMs?: number;
	/**
	 * How long a worker may take to exit AFTER reporting its result, in ms.
	 * Default 2 000.
	 *
	 * It is only flushing `atExit` hooks by then, which is milliseconds — except
	 * where it is not: a large V8 coverage dump on a slow disk, or a CI runner
	 * under load, can take longer, and the run then kills a worker that was
	 * about to finish writing. A fixed constant made that unfixable from the
	 * outside; the only way out was to stop asking for coverage.
	 */
	exitGraceMs?: number;
	/**
	 * Extra environment variables merged into every spawned worker's env.
	 * Used by coverage to forward `NODE_V8_COVERAGE=<tmp-dir>`.
	 */
	extraEnv?: NodeJS.ProcessEnv;
	/**
	 * Stop the run once a file reports a failure (helix `--bail` at the runner
	 * layer). Files already in flight finish; files not yet started are never
	 * spawned.
	 *
	 * Named deviation from helix: those files are DROPPED, not reported as
	 * skipped. helix can skip them because it collected every test in one
	 * process; helix runs one process per file, so a file that never starts has
	 * no tests to skip.
	 */
	bail?: boolean;
	/** Drop what the tests print instead of forwarding it (`--silent`). */
	silent?: boolean;
	/**
	 * Forward what the tests print on stdout to stderr instead — so a reporter
	 * writing machine-readable output on stdout (`json`) stays parseable.
	 */
	outputToStderr?: boolean;
}

export interface WorkerErrorMessage {
	file: string | undefined;
	message: string;
	stack?: string;
}

/**
 * What one file produced: its result when the worker reported one, and every
 * error that belongs to it — a fatal one instead of the result, or ones raised
 * beside it (an unhandled rejection, a late throw, an unexpected exit).
 */
export interface FileOutcome {
	result?: FileResult;
	errors: WorkerErrorMessage[];
	/** What the worker printed, outside the frames, on each stream. */
	output: { stdout: string; stderr: string };
}

/**
 * How much of what one file prints is kept, per stream. Past it the rest is
 * counted, not kept: a test logging in a loop must not grow the CLI's memory
 * without bound.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Bounded accumulator for one stream of a worker's output. */
class OutputBuffer {
	#text = "";
	#dropped = 0;
	append(chunk: string): void {
		const room = MAX_OUTPUT_BYTES - this.#text.length;
		if (room >= chunk.length) {
			this.#text += chunk;
			return;
		}
		if (room > 0) this.#text += chunk.slice(0, room);
		this.#dropped += chunk.length - Math.max(room, 0);
	}
	toString(): string {
		if (this.#dropped === 0) return this.#text;
		return `${this.#text}\n… ${this.#dropped} more characters of output dropped\n`;
	}
}

/**
 * Write what a file printed, under a header naming it. Buffered per file and
 * written in one go, so files running in parallel do not interleave.
 */
function forwardOutput(
	file: string,
	output: FileOutcome["output"],
	cfg: PoolConfig,
): void {
	if (cfg.silent === true) return;
	const name = path.relative(process.cwd(), file) || file;
	const write = (label: string, text: string, toStderr: boolean): void => {
		if (text.length === 0) return;
		const body = text.endsWith("\n") ? text : `${text}\n`;
		(toStderr ? process.stderr : process.stdout).write(
			`${label} | ${name}\n${body}`,
		);
	};
	write("stdout", output.stdout, cfg.outputToStderr === true);
	write("stderr", output.stderr, true);
}

/** Maximum stderr buffering before we give up and mark the file errored. */
const MAX_STDERR_BUFFER_BYTES = 4 * 1024 * 1024; // 4 MiB

/**
 * How long a worker may take to exit AFTER reporting its result, when nothing
 * says otherwise.
 *
 * It is only flushing `atExit` hooks by then — the V8 coverage writer is the
 * slow one, and it is milliseconds. Anything past this is a resource the test
 * left running, and waiting on it turns a passing run into a silent hang.
 * Overridable through {@link PoolConfig.exitGraceMs}, because "milliseconds"
 * stops being true on a loaded CI runner writing a large coverage dump.
 */
const DEFAULT_EXIT_GRACE_MS = 2000;

/** Default per-file deadline: ten minutes. */
export const DEFAULT_FILE_TIMEOUT_MS = 600_000;

/**
 * How long to keep reading a worker's stderr after it exited. Its last frames
 * may still be in the pipe; a grandchild holding the pipe open would otherwise
 * keep the file from settling at all.
 */
const EXIT_DRAIN_MS = 250;

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
	// Under `--bail`, the first failing file closes the gate: whatever has not
	// been spawned yet never will be.
	let gateClosed = false;

	await Promise.all(
		files.map(async (file) => {
			const absFile = path.isAbsolute(file) ? file : path.resolve(file);
			const release = await sem.acquire();
			try {
				// Checked AFTER acquiring the slot: by then an earlier file may have
				// failed while this one was queued.
				if (cfg.bail === true && gateClosed) return;
				safeCall(() => reporter.onFileStart(absFile), "onFileStart");
				const outcome = await runOne(absFile, cfg);
				forwardOutput(absFile, outcome.output, cfg);
				const { result } = outcome;
				if (result !== undefined) {
					safeCall(() => reporter.onFileResult(result), "onFileResult");
					results.push(result);
					if (cfg.bail === true && result.totals.fail > 0) {
						gateClosed = true;
					}
				}
				for (const error of outcome.errors) {
					safeCall(() => reporter.onFileError(error), "onFileError");
					errors.push(error);
					if (cfg.bail === true) gateClosed = true;
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
		const fileTimeoutMs = positiveMs(
			cfg.fileTimeoutMs,
			DEFAULT_FILE_TIMEOUT_MS,
		);
		const killGraceMs = positiveMs(cfg.killGraceMs, 2_000);
		const exitGraceMs = positiveMs(cfg.exitGraceMs, DEFAULT_EXIT_GRACE_MS);
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

		let killedByPool = false;
		const kill = (): void => {
			killedByPool = true;
			killChild(child, killGraceMs);
		};
		const registration: ActiveChild = { kill };
		activeChildren.add(registration);

		let settled = false;
		let result: FileResult | undefined;
		const errors: WorkerErrorMessage[] = [];
		const stdout = new OutputBuffer();
		const stderr = new OutputBuffer();
		// Set once the worker has said it is done (a result, or a fatal error).
		let reported = false;
		let exitGrace: ReturnType<typeof setTimeout> | undefined;
		let exitDrain: ReturnType<typeof setTimeout> | undefined;
		let exitStatus:
			| { code: number | null; signal: NodeJS.Signals | null }
			| undefined;

		const settle = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog);
			if (exitGrace) clearTimeout(exitGrace);
			if (exitDrain) clearTimeout(exitDrain);
			activeChildren.delete(registration);
			if (result === undefined && errors.length === 0) {
				errors.push({
					file,
					message: "worker exited without emitting a framed result",
				});
			}
			const output = { stdout: stdout.toString(), stderr: stderr.toString() };
			resolve(
				result === undefined ? { errors, output } : { result, errors, output },
			);
		};
		/** A failure the pool itself diagnosed: record it, kill, and stop. */
		const abort = (message: string): void => {
			if (settled) return;
			errors.push({ file, message });
			kill();
			settle();
		};

		/**
		 * The worker has reported. Keep reading its frames until it exits — an
		 * error it raises from here on (a timer that throws, a late rejection)
		 * still belongs to this file — but bound that wait: it is only flushing
		 * `atExit` hooks (the V8 coverage writer), which is milliseconds. A test
		 * that left a server or a timer running means the exit never comes, and
		 * the run would hang after its last file with nothing printed.
		 *
		 * Separate from the per-file watchdog on purpose: that one is sized for a
		 * file to RUN, this one for a flush.
		 */
		const awaitExit = (): void => {
			if (reported) return;
			reported = true;
			clearTimeout(watchdog);
			exitGrace = setTimeout(() => {
				if (settled) return;
				if (result !== undefined) {
					process.stderr.write(
						`helix: ${file} finished but its worker did not exit within ${exitGraceMs}ms — ` +
							"something it started is still running (a server, a timer, a connection).\n" +
							"helix: killing it and keeping the result. Close it in a teardown hook to silence this.\n",
					);
				}
				kill();
				settle();
			}, exitGraceMs);
			exitGrace.unref?.();
		};

		const watchdog = setTimeout(() => {
			abort(
				`worker timed out after ${fileTimeoutMs}ms — the file did not finish within its deadline (fileTimeoutMs)`,
			);
		}, fileTimeoutMs);
		watchdog.unref?.();

		// UTF-8-safe accumulator for stderr frame parsing.
		const decoder = new StringDecoder("utf8");
		let stderrBuffer = "";

		const processLine = (line: string): void => {
			if (!line.startsWith(FRAME_PREFIX)) {
				stderr.append(`${line}\n`);
				return;
			}
			const frame = parseFrame(line.slice(FRAME_PREFIX.length));
			if (frame === undefined) return;
			// Reject frames without the matching nonce — prevents a fixture
			// that writes `__HELIX_RESULT__...` on stderr from spoofing.
			// Exception: pre-handshake error frames (worker couldn't parse
			// its own instruction and doesn't know the real nonce yet) are
			// accepted only for `type === "error"` so a fixture still can't
			// claim a fake success.
			const nonceOk =
				frame.nonce === nonce ||
				(frame.nonce === PRE_HANDSHAKE_NONCE && frame.type === "error");
			if (!nonceOk) return;
			if (frame.type === "result") {
				if (result === undefined && frame.result !== undefined) {
					result = frame.result;
				}
				awaitExit();
				return;
			}
			errors.push({
				file: frame.file ?? file,
				message: frame.message ?? "unknown worker error",
				stack: frame.stack,
			});
			// An `unhandled` frame is not the end: the worker carries on with the
			// file. A fatal `error` frame is.
			if (frame.type === "error") awaitExit();
		};

		const drainLines = (): void => {
			let nl = stderrBuffer.indexOf("\n");
			while (nl >= 0 && !settled) {
				const line = stderrBuffer.slice(0, nl);
				stderrBuffer = stderrBuffer.slice(nl + 1);
				processLine(line);
				nl = stderrBuffer.indexOf("\n");
			}
		};

		child.stderr?.on("data", (chunk: Buffer) => {
			if (settled) return;
			stderrBuffer += decoder.write(chunk);
			if (stderrBuffer.length > MAX_STDERR_BUFFER_BYTES) {
				abort(
					`worker stderr exceeded ${MAX_STDERR_BUFFER_BYTES} bytes without emitting a frame`,
				);
				return;
			}
			drainLines();
		});

		// Read stdout as it comes, so a chatty `console.log` can't fill the 64 KB
		// pipe buffer and deadlock the worker; it is forwarded once the file
		// settles.
		const stdoutDecoder = new StringDecoder("utf8");
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout.append(stdoutDecoder.write(chunk));
		});

		child.on("error", (err) => {
			abort(`spawn failed: ${err.message}`);
		});

		/**
		 * Every frame is in, and the worker is gone: settle, after checking that
		 * the way it went matches what it said. A worker that reported and then
		 * died of a signal nobody sent, or exited with a status other than the
		 * one its frames imply, had something go wrong after its result — and the
		 * result alone would have read as green.
		 */
		const finalize = (): void => {
			if (settled || exitStatus === undefined) return;
			const trailing = decoder.end();
			if (trailing) stderrBuffer += trailing;
			drainLines();
			if (stderrBuffer.length > 0) {
				processLine(stderrBuffer);
				stderrBuffer = "";
			}
			if (result !== undefined && !killedByPool) {
				const { code, signal } = exitStatus;
				const expected = result.totals.fail > 0 || errors.length > 0 ? 1 : 0;
				if (signal !== null) {
					errors.push({
						file,
						message: `worker was killed by ${signal} after the file reported its result`,
					});
				} else if (code !== null && code !== 0 && code !== expected) {
					errors.push({
						file,
						message: `worker exited with code ${code} after the file reported its result`,
					});
				}
			}
			settle();
		};

		child.on("exit", (code, signal) => {
			exitStatus = { code, signal };
			// `exit` can fire before the last stderr bytes are read. `close`
			// waits for them, but never comes while a grandchild holds the pipe
			// open — so it gets a short window, and then we settle with what we
			// have.
			exitDrain = setTimeout(finalize, EXIT_DRAIN_MS);
			exitDrain.unref?.();
		});
		child.on("close", finalize);

		// Instruction line. The timeouts travel only when set, so the worker can
		// tell "nobody chose" from a choice and apply `configure({ timeout })`.
		const instr = JSON.stringify({
			type: "run",
			file,
			timeoutMs: cfg.timeoutMs,
			defaultTimeoutMs: cfg.defaultTimeoutMs,
			nonce,
		});
		// `child.stdin` may be closed by the time we get here (rare spawn race).
		// Attach an error listener so an EPIPE doesn't crash the parent.
		child.stdin?.on("error", (err) => {
			abort(`stdin write failed: ${err.message}`);
		});
		child.stdin?.write(`${instr}\n`, () => {
			child.stdin?.end();
		});
	});
}

/** What a frame line carries once its JSON is read and its fields checked. */
interface Frame {
	type: "result" | "error" | "unhandled";
	nonce: unknown;
	result?: FileResult;
	file?: string;
	message?: string;
	stack?: string;
}

/** Read a frame payload, or `undefined` for anything that is not one. */
function parseFrame(payload: string): Frame | undefined {
	let msg: unknown;
	try {
		msg = JSON.parse(payload);
	} catch {
		return undefined;
	}
	if (msg === null || typeof msg !== "object") return undefined;
	const type = Reflect.get(msg, "type");
	if (type !== "result" && type !== "error" && type !== "unhandled") {
		return undefined;
	}
	const result = Reflect.get(msg, "result");
	const file = Reflect.get(msg, "file");
	const message = Reflect.get(msg, "message");
	const stack = Reflect.get(msg, "stack");
	return {
		type,
		nonce: Reflect.get(msg, "nonce"),
		result: isFileResult(result) ? result : undefined,
		file: typeof file === "string" ? file : undefined,
		message: typeof message === "string" ? message : undefined,
		stack: typeof stack === "string" ? stack : undefined,
	};
}

/** Enough of a `FileResult`'s shape to count it; the worker built the rest. */
function isFileResult(value: unknown): value is FileResult {
	if (value === null || typeof value !== "object") return false;
	const totals = Reflect.get(value, "totals");
	return (
		typeof Reflect.get(value, "file") === "string" &&
		Array.isArray(Reflect.get(value, "tests")) &&
		Array.isArray(Reflect.get(value, "suites")) &&
		totals !== null &&
		typeof totals === "object" &&
		["pass", "fail", "skip", "todo"].every(
			(key) => typeof Reflect.get(totals, key) === "number",
		)
	);
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

/**
 * A millisecond option, or the default when it is not one. Read once into a
 * local rather than three times off the config: narrowing an optional property
 * does not survive to the next read, which is why this used to end in a cast
 * asserting back what the check had just established.
 */
function positiveMs(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return Math.floor(value);
}

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
