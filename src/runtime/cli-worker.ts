/**
 * CLI worker entry — what the orchestrator spawns as a child process.
 *
 * Protocol:
 *   1. Parent writes one `{ "type":"run", "file":"...", "timeoutMs":n,
 *      "defaultTimeoutMs":n, "nonce":"..." }` line to stdin (both timeouts
 *      optional), and keeps stdin open until the file is settled: its
 *      closing is how the worker learns the parent died.
 *   2. We run the file via `runTestFile`.
 *   3. We emit a single framed line on **stderr** prefixed with
 *      `__HELIX_RESULT__`, with the parent's `nonce` echoed back so a
 *      test that happens to print that prefix can't spoof the result.
 *   4. Exit with code 0 on a clean `result`, 1 on a failing one or on `error`.
 *
 * An error nobody handled (a floating rejection, a timer that throws) is sent
 * as an `unhandled` frame whenever it happens — during the tests or after the
 * result — and the worker keeps going. The parent reads frames until the worker
 * exits, so a late one still turns the file red.
 *
 * Pre-handshake errors (e.g. malformed instruction on stdin) are emitted
 * with the `__helix_pre_handshake__` magic nonce — the parent accepts
 * those only for `type === "error"` so a fixture can't use the magic to
 * fake success.
 *
 * Flush discipline: on the happy path we await the stream drain callback
 * before setting `process.exitCode` so the frame always reaches the
 * parent. For the `unhandled` frames we use `fs.writeSync` on fd 2 to
 * guarantee the bytes hit the pipe before Node tears the process down.
 */

import { writeSync } from "node:fs";
import { cliArgs } from "./cli-args.js";
import { FRAME_PREFIX, PRE_HANDSHAKE_NONCE } from "./ipc-protocol.js";
import { runTestFile } from "./worker.js";

interface RunMessage {
	type: "run";
	file: string;
	/** Per-test timeout that beats `configure({ timeout })` (flag, suite). */
	timeoutMs?: number;
	/** Per-test timeout below `configure({ timeout })` (the config file's). */
	defaultTimeoutMs?: number;
	nonce: string;
}

/**
 * Per-test timeout when nothing — flag, suite, `configure()`, config file —
 * chose one.
 */
const DEFAULT_TEST_TIMEOUT_MS = 60_000;

/** A finite, non-negative number of milliseconds, or `undefined`. */
function millis(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

/** The `run` instruction, or `undefined` when `parsed` is not one. */
function toRunMessage(parsed: unknown): RunMessage | undefined {
	if (parsed === null || typeof parsed !== "object") return undefined;
	const type = Reflect.get(parsed, "type");
	const file = Reflect.get(parsed, "file");
	const nonce = Reflect.get(parsed, "nonce");
	if (type !== "run" || typeof file !== "string" || typeof nonce !== "string") {
		return undefined;
	}
	return {
		type,
		file,
		nonce,
		timeoutMs: millis(Reflect.get(parsed, "timeoutMs")),
		defaultTimeoutMs: millis(Reflect.get(parsed, "defaultTimeoutMs")),
	};
}

async function emit(msg: unknown): Promise<void> {
	const line = `${FRAME_PREFIX}${JSON.stringify(msg)}\n`;
	await new Promise<void>((resolve, reject) => {
		process.stderr.write(line, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

/**
 * Synchronous emit used from fatal handlers (unhandledRejection) where
 * we can't afford to lose the frame to the process tear-down racing the
 * pipe drain. `writeSync` blocks until the kernel accepts the bytes.
 */
function emitSync(msg: unknown): void {
	try {
		writeSync(2, `${FRAME_PREFIX}${JSON.stringify(msg)}\n`);
	} catch {
		/* pipe broken — nothing we can do */
	}
}

/** One instruction line, or the error that explains why it is not one. */
function parseInstruction(line: string): RunMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (err) {
		throw new Error(
			`malformed instruction JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const message = toRunMessage(parsed);
	if (message !== undefined) return message;
	throw new Error(`invalid instruction shape: ${line}`);
}

/**
 * Read the first non-empty line of stdin. The stream stays open and flowing
 * afterwards: the parent keeps its end open for the whole run, which is how
 * the worker learns the parent is gone (see {@link watchParent}).
 */
function readInstruction(): Promise<RunMessage> {
	return new Promise((resolve, reject) => {
		const stdin = process.stdin;
		let buffered = "";
		let settled = false;
		const take = (line: string): void => {
			settled = true;
			try {
				resolve(parseInstruction(line));
			} catch (err) {
				reject(err);
			}
		};
		stdin.setEncoding("utf8");
		stdin.on("data", (chunk: string) => {
			if (settled) return;
			buffered += chunk;
			let nl = buffered.indexOf("\n");
			while (nl >= 0) {
				const line = buffered.slice(0, nl).trim();
				buffered = buffered.slice(nl + 1);
				if (line !== "") {
					take(line);
					return;
				}
				nl = buffered.indexOf("\n");
			}
		});
		stdin.once("end", () => {
			if (settled) return;
			const line = buffered.trim();
			if (line !== "") {
				take(line);
				return;
			}
			settled = true;
			reject(new Error("stdin closed before instruction arrived"));
		});
	});
}

/**
 * Exit — taking this worker's process group along — once the parent is gone.
 *
 * The parent's watchdog and its SIGINT teardown cannot run when it is
 * SIGKILLed or OOM-killed, and a worker stuck in a hanging test would then
 * live on, reparented to init. Two signals, either is enough: the parent's end
 * of stdin closing (immediate, everywhere), and our parent pid changing
 * (reparenting — a fallback for a host that keeps the pipe open). The worker
 * leads its own group (the pools spawn it detached), so signalling `-pid`
 * reaches what its tests spawned too.
 */
function watchParent(): void {
	const parent = process.ppid;
	const orphaned = (): void => {
		try {
			process.kill(-process.pid, "SIGKILL");
		} catch {
			// Not a group leader (spawned by hand): only this process to end.
		}
		process.exit(1);
	};
	const stdin = process.stdin;
	stdin.once("end", orphaned);
	// Unreferenced: a lifeline, not a reason to stay alive once the file is done.
	if (typeof stdin.unref === "function") stdin.unref();
	const poll = setInterval(() => {
		if (process.ppid !== parent) orphaned();
	}, PARENT_POLL_MS);
	poll.unref();
}

/** How often the fallback parent check runs. */
const PARENT_POLL_MS = 500;

async function main(): Promise<void> {
	let instr: RunMessage;
	try {
		instr = await readInstruction();
	} catch (err) {
		// We don't know the real nonce yet — emit with the pre-handshake
		// magic so the parent accepts this specific error path.
		await emit({
			type: "error",
			file: undefined,
			message: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
			nonce: PRE_HANDSHAKE_NONCE,
		}).catch(() => {});
		process.exitCode = 1;
		return;
	}

	watchParent();

	// Installed AFTER the instruction is read so we can echo the right nonce.
	// An error nobody handled is recorded, not fatal: the file keeps running so
	// its results still arrive, and the `unhandled` frame makes the parent count
	// the file as errored. Listening for `uncaughtException` is what keeps a
	// timer that throws from killing the worker before it can say so. Written
	// synchronously so a tear-down racing the pipe cannot drop the frame.
	let reported = false;
	let unhandled = 0;
	const onUnhandled = (kind: string, reason: unknown): void => {
		unhandled += 1;
		process.exitCode = 1;
		const when = reported ? " after the file reported its result" : "";
		emitSync({
			type: "unhandled",
			file: instr.file,
			message: `${kind}${when}: ${reason instanceof Error ? reason.message : String(reason)}`,
			stack: reason instanceof Error ? reason.stack : undefined,
			nonce: instr.nonce,
		});
	};
	process.on("unhandledRejection", (reason) =>
		onUnhandled("unhandledRejection", reason),
	);
	process.on("uncaughtException", (err) =>
		onUnhandled("uncaughtException", err),
	);

	try {
		const result = await runTestFile(instr.file, {
			timeoutMs: instr.timeoutMs,
			defaultTimeoutMs: instr.defaultTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
		});
		// A file that declared nothing checked nothing — often a typo, or tests
		// registered on a second copy of helix. Under `--list-pinned` nothing
		// runs by design.
		const flags = cliArgs();
		if (
			result.tests.length === 0 &&
			flags.passWithNoTests !== true &&
			flags.listPinned !== true
		) {
			throw new Error(`No test suite found in file ${instr.file}`);
		}
		await emit({ type: "result", result, nonce: instr.nonce });
		reported = true;
		// A runner teardown that threw is an error of this file, beside its
		// results: the parent counts each one.
		for (const error of result.teardownErrors ?? []) {
			unhandled += 1;
			await emit({
				type: "unhandled",
				file: instr.file,
				message: `runner teardown failed: ${error.message}`,
				stack: error.stack,
				nonce: instr.nonce,
			});
		}
		// The status the parent checks the exit against: anything else means
		// something happened after this line that the frames did not explain.
		process.exitCode = result.totals.fail > 0 || unhandled > 0 ? 1 : 0;
	} catch (err) {
		await emit({
			type: "error",
			file: instr.file,
			message: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
			nonce: instr.nonce,
		}).catch(() => {});
		process.exitCode = 1;
	}
}

void main();
