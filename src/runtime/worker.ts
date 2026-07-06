/**
 * Worker entry — loads a single test file, collects its `describe`/`test`
 * declarations, executes them, and emits a `FileResult`.
 *
 * Usage modes:
 *   1. Direct (unit tests): `runTestFile("/abs/path.test.ts")` → `FileResult`
 *   2. Child process (orchestrator): `main()` reads file paths from IPC
 *      messages and replies on `process.send`. Exactly one `main()` runs
 *      per worker process (guarded); IPC runs are serialized so concurrent
 *      messages cannot race on internal state.
 *
 * File collection is scoped per invocation via AsyncLocalStorage (see
 * `suite.ts#withCollection`) — no shared mutable state across concurrent
 * `runTestFile` calls.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { type ExecuteOptions, executeRoot, type FileResult } from "./run.js";
import { withCollection } from "./suite.js";
import { withViContext } from "./vi/index.js";

export interface RunFileOptions extends ExecuteOptions {
	/**
	 * Bust the ESM module cache so repeated runs of the same path re-execute
	 * the file body and re-collect tests. Default: true.
	 */
	freshImport?: boolean;
}

function assertAbsolute(p: string): void {
	if (!path.isAbsolute(p)) {
		throw new Error(
			`runTestFile: expected absolute path, got "${p}". Resolve against cwd or __dirname before calling.`,
		);
	}
}

/** Turn values that `JSON.stringify` rejects into readable fallbacks. */
function safeValue(v: unknown, seen = new WeakSet<object>()): unknown {
	if (v === null || v === undefined) return v;
	if (typeof v === "bigint") return `${v}n`;
	if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
	if (typeof v === "symbol") return v.toString();
	if (typeof v !== "object") return v;
	if (seen.has(v)) return "[Circular]";
	seen.add(v);
	if (Array.isArray(v)) return v.map((item) => safeValue(item, seen));
	if (v instanceof Map) {
		const out: Array<[unknown, unknown]> = [];
		for (const [k, val] of v)
			out.push([safeValue(k, seen), safeValue(val, seen)]);
		return { __type: "Map", entries: out };
	}
	if (v instanceof Set) {
		return { __type: "Set", values: [...v].map((x) => safeValue(x, seen)) };
	}
	if (v instanceof Date) return { __type: "Date", iso: v.toISOString() };
	if (v instanceof RegExp)
		return { __type: "RegExp", src: v.source, flags: v.flags };
	if (v instanceof Error) {
		return {
			__type: "Error",
			name: v.name,
			message: v.message,
			stack: v.stack,
		};
	}
	const rec: Record<string, unknown> = {};
	for (const key of Object.keys(v)) {
		rec[key] = safeValue(Reflect.get(v, key), seen);
	}
	return rec;
}

function sanitizeTest(
	t: FileResult["tests"][number],
): FileResult["tests"][number] {
	if (!t.error) return t;
	return {
		...t,
		error: {
			...t.error,
			actual: safeValue(t.error.actual),
			expected: safeValue(t.error.expected),
		},
	};
}

function sanitizeSuite(
	s: FileResult["suites"][number],
): FileResult["suites"][number] {
	return {
		...s,
		hookErrors: s.hookErrors.map((e) => ({
			...e,
			actual: safeValue(e.actual),
			expected: safeValue(e.expected),
		})),
		children: s.children.map((c) =>
			"children" in c ? sanitizeSuite(c) : sanitizeTest(c),
		),
	};
}

function sanitize(result: FileResult): FileResult {
	return {
		...result,
		tests: result.tests.map(sanitizeTest),
		suites: result.suites.map(sanitizeSuite),
	};
}

let importCounter = 0;

export async function runTestFile(
	absolutePath: string,
	options: RunFileOptions = {},
): Promise<FileResult> {
	assertAbsolute(absolutePath);
	const baseUrl = pathToFileURL(absolutePath).href;
	// Cache-busting query param so the ESM loader re-evaluates the module on
	// every call — otherwise `describe`/`test` would only register on the
	// first call and subsequent runs would see an empty suite tree.
	const url =
		options.freshImport === false
			? baseUrl
			: `${baseUrl}?helix=${Date.now()}-${++importCounter}`;
	return withViContext(async () => {
		const root = await withCollection(async () => {
			await import(url);
		});
		// Retries / grep / tags are per-test runtime filters. They're carried via
		// env vars (set by the CLI) so they reach the worker through ANY
		// orchestrator — the Rust native engine forwards a fixed instruction
		// shape, but child processes still inherit the CLI process env.
		// Explicit options always win over the env fallback.
		const raw = await executeRoot(root, absolutePath, {
			timeoutMs: options.timeoutMs,
			retries: options.retries ?? envRetries(),
			grep: options.grep ?? process.env.HELIX_GREP,
			tags: options.tags ?? envTags(),
		});
		return sanitize(raw);
	});
}

function envRetries(): number | undefined {
	const raw = process.env.HELIX_RETRIES;
	if (raw === undefined || raw === "") return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function envTags(): string[] | undefined {
	const raw = process.env.HELIX_TAGS;
	if (raw === undefined || raw === "") return undefined;
	const tags = raw
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	return tags.length > 0 ? tags : undefined;
}

interface WorkerIncoming {
	type: "run";
	file: string;
	timeoutMs?: number;
}

interface WorkerOutgoing {
	type: "result";
	result: FileResult;
}

interface WorkerError {
	type: "error";
	file: string | undefined;
	message: string;
	stack?: string;
}

type WorkerMessage = WorkerOutgoing | WorkerError;

const FRAME_PREFIX = "__HELIX_RESULT__";

function send(msg: WorkerMessage): void {
	if (typeof process.send === "function") {
		process.send(msg);
		return;
	}
	// Fallback: framed line on stderr so it doesn't collide with test
	// console.log output on stdout. Parent parses lines starting with the
	// `FRAME_PREFIX` magic.
	process.stderr.write(`${FRAME_PREFIX}${JSON.stringify(msg)}\n`);
}

function isWorkerIncoming(v: unknown): v is WorkerIncoming {
	if (!v || typeof v !== "object") return false;
	const r = v as { type?: unknown; file?: unknown };
	return r.type === "run" && typeof r.file === "string";
}

let mainStarted = false;

export async function main(): Promise<void> {
	if (mainStarted) return;
	mainStarted = true;

	// Unhandled rejections from test code (e.g. a dangling Promise.reject)
	// would crash the worker on Node 15+ or leak silently. Log them and keep
	// the process alive so currently-running tests can complete.
	process.on("unhandledRejection", (reason) => {
		process.stderr.write(
			`${FRAME_PREFIX}${JSON.stringify({
				type: "error",
				file: undefined,
				message: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`,
				stack: reason instanceof Error ? reason.stack : undefined,
			})}\n`,
		);
	});

	// IPC mode: parent drives us via `{ type: "run", file }` messages.
	if (typeof process.send === "function") {
		let pending: Promise<unknown> = Promise.resolve();
		process.on("message", (raw: unknown) => {
			if (!isWorkerIncoming(raw)) return;
			const msg = raw;
			// Serialize IPC runs: a second message waits for the first to
			// finish so module-scoped watchers / handlers don't race.
			pending = pending
				.then(() => runTestFile(msg.file, { timeoutMs: msg.timeoutMs }))
				.then((result) => send({ type: "result", result }))
				.catch((err: unknown) => {
					const e = err instanceof Error ? err : new Error(String(err));
					send({
						type: "error",
						file: msg.file,
						message: e.message,
						stack: e.stack,
					});
				});
		});
		return;
	}

	// CLI fallback: `node worker.js <file>`.
	const file = process.argv[2];
	if (!file) {
		process.stderr.write("helix worker: missing file arg\n");
		process.exit(2);
	}
	try {
		const abs = path.resolve(file);
		const result = await runTestFile(abs);
		send({ type: "result", result });
		process.exit(result.totals.fail > 0 ? 1 : 0);
	} catch (err) {
		const e = err instanceof Error ? err : new Error(String(err));
		send({ type: "error", file, message: e.message, stack: e.stack });
		process.exit(2);
	}
}
