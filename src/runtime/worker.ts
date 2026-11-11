/**
 * Worker entry — loads a single test file, collects its `describe`/`test`
 * declarations, executes them, and emits a `FileResult`.
 *
 * `runTestFile("/abs/path.test.ts")` → `FileResult`. It runs in-process
 * here; the child process both pools spawn is `cli-worker.ts`, which reads
 * the run instruction on stdin and calls `runTestFile`.
 *
 * File collection is scoped per invocation via AsyncLocalStorage (see
 * `suite.ts#withCollection`) — no shared mutable state across concurrent
 * `runTestFile` calls.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadBootstrap } from "./bootstrap.js";
import { cliArgs, runningInCI } from "./cli-args.js";
import { drainRunnerTeardowns, getConfiguredDefaults } from "./configure.js";
import {
	type ExecuteOptions,
	executeRoot,
	type FileResult,
	serializeError,
} from "./run.js";
import { type SuiteNode, withCollection } from "./suite.js";
import { applyTaps, tappedBail } from "./suite-taps.js";
import { withViContext } from "./vi/index.js";

export interface RunFileOptions extends ExecuteOptions {
	/**
	 * Bust the ESM module cache so repeated runs of the same path re-execute
	 * the file body and re-collect tests. Default: true.
	 */
	freshImport?: boolean;
	/**
	 * Per-test timeout (ms) used when neither {@link ExecuteOptions.timeoutMs}
	 * nor `configure({ timeout })` — a plugin's edit included — set one.
	 */
	defaultTimeoutMs?: number;
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
	// `tests/bootstrap.ts` (AdonisJS) installs the run's plugins and hooks, so
	// it must run BEFORE the test file: a plugin's context macros have to exist
	// by the time the file's first test declares itself.
	const suiteName = options.suite ?? cliArgs().suite;
	await loadBootstrap(
		suiteName === undefined || suiteName === "" ? "default" : suiteName,
	);
	return withViContext(async () => {
		const root = await withCollection(async () => {
			// `configure({ importer })` replaces the plain dynamic
			// import — the seam a consumer needs to compile or instrument a file
			// on the way in.
			const importer = getConfiguredDefaults().importer;
			if (importer) await importer(new URL(url));
			else await import(url);
		});
		// `configureSuite`'s taps run between collection and execution — the
		// point at which helix's own `onTest`/`onGroup` fire.
		applyTaps(root);
		// `--list-pinned`: helix collects the files, prints what is pinned and
		// runs nothing — not the tests, and not the runner teardowns either,
		// since it skipped the setup hooks that would have needed undoing.
		if (cliArgs().listPinned === true) {
			return {
				file: absolutePath,
				suites: [],
				tests: [],
				totals: { pass: 0, fail: 0, skip: 0, todo: 0 },
				durationMs: 0,
				pinned: pinnedNames(root, []),
			};
		}
		let result: FileResult;
		let teardownFailures: unknown[] = [];
		try {
			// Retries / grep / tags are per-test runtime filters. The CLI carries
			// them in env vars so they reach the worker through ANY orchestrator —
			// the Rust engine forwards a fixed instruction shape, but a child
			// process still inherits the CLI's env.
			//
			// Precedence, highest first: an explicit `runTestFile` option, then the
			// CLI flags, then what `configure()` set (`timeout`, `retries`,
			// `filters`), then the runtime's own fallback. So a filter typed at the
			// prompt always beats one written in a bootstrap.
			const defaults = getConfiguredDefaults();
			const filters = defaults.filters;
			// Read through the shared `cliArgs` object rather than the env: a
			// plugin may have edited it, and an edit that the
			// runtime ignored would be worse than not offering it at all.
			const flags = cliArgs();
			const raw = await executeRoot(root, absolutePath, {
				timeoutMs:
					options.timeoutMs ?? defaults.timeout ?? options.defaultTimeoutMs,
				retries: options.retries ?? flags.retries ?? defaults.retries,
				grep: options.grep ?? flags.grep,
				tags: options.tags ?? flags.tags ?? filters?.tags,
				matchAll: options.matchAll ?? flags.matchAll ?? filters?.matchAll,
				tests: options.tests ?? flags.tests ?? filters?.tests,
				groups: options.groups ?? flags.groups ?? filters?.groups,
				suite: options.suite ?? flags.suite ?? defaults.suite ?? "default",
				bail: options.bail ?? flags.bail ?? tappedBail() ?? false,
				bailLayer: options.bailLayer ?? asBailLayer(flags.bailLayer),
				allowOnly: options.allowOnly ?? flags.allowOnly ?? !runningInCI(),
			});
			result = sanitize(raw);
		} finally {
			// Runner teardowns (plugin `api.cleanup` + `configure({ teardown })`)
			// run once the file's tests finish — close servers, DB pools, etc.
			teardownFailures = await drainRunnerTeardowns();
		}
		if (teardownFailures.length === 0) return result;
		return {
			...result,
			teardownErrors: teardownFailures.map(serializeError),
		};
	});
}

/** Full names of every `.pin()`ed test under `node`, in declaration order. */
function pinnedNames(node: SuiteNode, path: string[]): string[] {
	const names: string[] = [];
	for (const child of node.children) {
		if (child.kind === "test") {
			if (child.pinned === true) names.push([...path, child.name].join(" > "));
			continue;
		}
		names.push(...pinnedNames(child, [...path, child.name]));
	}
	return names;
}

/** `--bail-layer` as forwarded by the CLI; anything else falls back to runner. */
function asBailLayer(
	raw: string | undefined,
): "group" | "suite" | "runner" | undefined {
	if (raw === "group" || raw === "suite" || raw === "runner") return raw;
	return undefined;
}
