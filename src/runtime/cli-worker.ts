/**
 * CLI worker entry — what the orchestrator spawns as a child process.
 *
 * Protocol:
 *   1. Parent writes one `{ "type":"run", "file":"...", "timeoutMs":n, "nonce":"..." }`
 *      line to stdin, then closes stdin.
 *   2. We run the file via `runTestFile`.
 *   3. We emit a single framed line on **stderr** prefixed with
 *      `__HELIX_RESULT__`, with the parent's `nonce` echoed back so a
 *      test that happens to print that prefix can't spoof the result.
 *   4. Exit with code 0 on `result`, 1 on `error`.
 *
 * Pre-handshake errors (e.g. malformed instruction on stdin) are emitted
 * with the `__helix_pre_handshake__` magic nonce — the parent accepts
 * those only for `type === "error"` so a fixture can't use the magic to
 * fake success.
 *
 * Flush discipline: on the happy path we await the stream drain callback
 * before setting `process.exitCode` so the frame always reaches the
 * parent. For the fatal `unhandledRejection` path we use `fs.writeSync`
 * on fd 2 to guarantee the bytes hit the pipe before Node tears the
 * process down.
 */

import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { runTestFile } from "./worker.js";

const FRAME_PREFIX = "__HELIX_RESULT__";
const PRE_HANDSHAKE_NONCE = "__helix_pre_handshake__";

interface RunMessage {
	type: "run";
	file: string;
	timeoutMs?: number;
	nonce: string;
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

async function readInstruction(): Promise<RunMessage> {
	const rl = createInterface({ input: process.stdin });
	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Parse inside try so a bad JSON line propagates as a typed error
		// rather than leaking a SyntaxError that escapes `for await`.
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (err) {
			throw new Error(
				`malformed instruction JSON: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (
			parsed &&
			typeof parsed === "object" &&
			(parsed as { type?: unknown }).type === "run" &&
			typeof (parsed as { file?: unknown }).file === "string" &&
			typeof (parsed as { nonce?: unknown }).nonce === "string"
		) {
			return parsed as RunMessage;
		}
		throw new Error(`invalid instruction shape: ${trimmed}`);
	}
	throw new Error("stdin closed before instruction arrived");
}

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

	// Installed AFTER the instruction is read so we can echo the right nonce.
	// Synchronous write so Node's default "crash on unhandledRejection"
	// behaviour can't evict the frame before the parent reads it.
	process.on("unhandledRejection", (reason) => {
		emitSync({
			type: "error",
			file: instr.file,
			message: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`,
			stack: reason instanceof Error ? reason.stack : undefined,
			nonce: instr.nonce,
		});
	});

	try {
		const result = await runTestFile(instr.file, {
			timeoutMs: instr.timeoutMs,
		});
		await emit({ type: "result", result, nonce: instr.nonce });
		process.exitCode = result.totals.fail > 0 ? 1 : 0;
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
