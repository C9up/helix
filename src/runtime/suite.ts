/**
 * `describe` / `test` / `it` DSL — builds a suite tree during module load.
 *
 * Collection phase: `describe(name, fn)` runs `fn` synchronously with an
 * active suite on a per-invocation stack. `withCollection(...)` scopes the
 * collection to one `runTestFile` call via AsyncLocalStorage, so parallel
 * invocations never share state.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type TestFn = () => void | Promise<void>;
export type SuiteFn = () => void;

/** Teardown function a hook may return (Vitest/Japa parity). */
export type CleanupFn = () => void | Promise<void>;
/** A lifecycle hook: may return nothing or a cleanup function. */
export type HookFn = () => void | CleanupFn | Promise<void | CleanupFn>;

export type HookType = "beforeAll" | "afterAll" | "beforeEach" | "afterEach";

export interface Hook {
	type: HookType;
	fn: HookFn;
}

export type RunMode = "run" | "skip" | "only" | "todo";

export interface TestNode {
	kind: "test";
	name: string;
	fn: TestFn | undefined; // undefined for `todo`
	mode: RunMode;
	parent: SuiteNode;
	location?: string;
	/** Extra attempts on failure (`0` = run once). `test.retry(n)` / `{ retry }`. */
	retries?: number;
	/** Per-test timeout in ms. `0` disables. `test.timeout(ms)` / `{ timeout }`. */
	timeoutMs?: number;
	/** Tags for `--tags` filtering. `test.tags(...)` / `{ tags }`. */
	tags?: string[];
	/** When `true`, the test is expected to throw — `test.fails()`. */
	failing?: boolean;
}

/** Vitest-style per-test options (3rd argument to `test`). */
export interface TestOptions {
	/** Extra attempts on failure. */
	retry?: number;
	/** Per-test timeout in ms (`0` disables). */
	timeout?: number;
	/** Tags for `--tags` filtering. */
	tags?: string[];
	/** Expect the test to fail. */
	fails?: boolean;
}

/**
 * Chainable handle returned by `test(...)` — Japa-style fluent modifiers that
 * mutate the just-registered node. Ignoring the return keeps Vitest's
 * `test(name, fn)` ergonomics; chaining adds `@japa/runner` parity.
 */
export interface TestHandle {
	retry(n: number): TestHandle;
	timeout(ms: number): TestHandle;
	disableTimeout(): TestHandle;
	tags(...tags: string[]): TestHandle;
	fails(): TestHandle;
}

export interface SuiteNode {
	kind: "suite";
	name: string;
	mode: RunMode;
	parent: SuiteNode | undefined;
	children: Array<SuiteNode | TestNode>;
	hooks: Hook[];
}

interface CollectionContext {
	root: SuiteNode;
	stack: SuiteNode[];
}

function makeSuite(
	name: string,
	mode: RunMode,
	parent: SuiteNode | undefined,
): SuiteNode {
	return {
		kind: "suite",
		name,
		mode,
		parent,
		children: [],
		hooks: [],
	};
}

/**
 * Collection registry. Holds the `AsyncLocalStorage` scope used per test-file
 * run plus a fallback root for direct DSL use.
 *
 * CRITICAL (H5): this state is pinned to `globalThis`, NOT held as module-local
 * variables. A consumer's test does `import { describe } from '@c9up/helix'`
 * while the runner drives collection via `@c9up/helix/runtime/worker`. If those
 * two specifiers resolve to DISTINCT module instances of this file (src vs dist,
 * or an ESM/CJS dual instance under the tsx loader), a module-local registry
 * means the test's `describe`/`test` register into one instance while the worker
 * opens its collection scope on the other — so the worker collects 0 tests.
 * A single globalThis-backed registry removes that hazard entirely.
 */
interface CollectionRegistry {
	storage: AsyncLocalStorage<CollectionContext>;
	fallbackRoot: SuiteNode;
	fallbackStack: SuiteNode[];
}

declare global {
	// eslint-disable-next-line no-var
	var __helixCollectionRegistry: CollectionRegistry | undefined;
}

function registry(): CollectionRegistry {
	let r = globalThis.__helixCollectionRegistry;
	if (!r) {
		const root = makeSuite("", "run", undefined);
		r = {
			storage: new AsyncLocalStorage<CollectionContext>(),
			fallbackRoot: root,
			fallbackStack: [root],
		};
		globalThis.__helixCollectionRegistry = r;
	}
	return r;
}

function currentContext(): CollectionContext {
	const r = registry();
	const scoped = r.storage.getStore();
	if (scoped) return scoped;
	return { root: r.fallbackRoot, stack: r.fallbackStack };
}

export function resetRoot(): SuiteNode {
	const r = registry();
	r.fallbackRoot = makeSuite("", "run", undefined);
	r.fallbackStack = [r.fallbackRoot];
	return r.fallbackRoot;
}

export function getRoot(): SuiteNode {
	return currentContext().root;
}

/**
 * Run `body` inside a fresh, isolated collection context. Returns the root
 * populated by its DSL calls. Safe under concurrent invocation.
 */
export async function withCollection(
	body: () => Promise<void> | void,
): Promise<SuiteNode> {
	const root = makeSuite("", "run", undefined);
	const ctx: CollectionContext = { root, stack: [root] };
	await registry().storage.run(ctx, async () => {
		await body();
	});
	return root;
}

function current(): SuiteNode {
	const { stack } = currentContext();
	const top = stack[stack.length - 1];
	if (!top) throw new Error("internal: suite stack empty");
	return top;
}

function registerTest(
	name: string,
	mode: RunMode,
	fn: TestFn | undefined,
	options?: TestOptions,
): TestNode {
	const parent = current();
	const node: TestNode = {
		kind: "test",
		name,
		fn,
		mode,
		parent,
		retries: options?.retry,
		timeoutMs: options?.timeout,
		tags: options?.tags,
		failing: options?.fails,
	};
	parent.children.push(node);
	return node;
}

/** Wrap a registered node in the chainable Japa-style handle. */
function makeHandle(node: TestNode): TestHandle {
	const handle: TestHandle = {
		retry(n: number) {
			node.retries = n;
			return handle;
		},
		timeout(ms: number) {
			node.timeoutMs = ms;
			return handle;
		},
		disableTimeout() {
			node.timeoutMs = 0;
			return handle;
		},
		tags(...tags: string[]) {
			node.tags = [...(node.tags ?? []), ...tags];
			return handle;
		},
		fails() {
			node.failing = true;
			return handle;
		},
	};
	return handle;
}

/** Normalise the optional 3rd arg: a bare number is a timeout (Vitest). */
function normaliseTestOptions(
	optionsOrTimeout: TestOptions | number | undefined,
): TestOptions | undefined {
	if (optionsOrTimeout === undefined) return undefined;
	if (typeof optionsOrTimeout === "number") {
		return { timeout: optionsOrTimeout };
	}
	return optionsOrTimeout;
}

function registerSuite(name: string, mode: RunMode, body: SuiteFn): void {
	const ctx = currentContext();
	const parent = current();
	const suite = makeSuite(name, mode, parent);
	parent.children.push(suite);
	ctx.stack.push(suite);
	let result: unknown;
	try {
		result = body();
	} finally {
		ctx.stack.pop();
	}
	// Async describe bodies would register nested describe/test against the
	// wrong parent after the first `await` (because we've already popped).
	// Fail loudly rather than silently mis-collect.
	if (result && typeof (result as { then?: unknown }).then === "function") {
		throw new Error(
			`describe(${JSON.stringify(name)}): body returned a Promise. Async describe is not supported — await the setup in a \`beforeAll\` hook instead.`,
		);
	}
}

type SuiteApi = {
	(name: string, fn: SuiteFn): void;
	skip(name: string, fn: SuiteFn): void;
	only(name: string, fn: SuiteFn): void;
	todo(name: string): void;
};

type ArrayRow = readonly unknown[];
type ObjectRow = Readonly<Record<string, unknown>>;
type EachRow =
	| ArrayRow
	| ObjectRow
	| null
	| undefined
	| string
	| number
	| boolean
	| bigint
	| symbol;

/** Source of `each` rows: a static array or a (sync) function returning one. */
type EachRows<Row extends EachRow> = readonly Row[] | (() => readonly Row[]);

type TestApi = {
	(name: string, fn: TestFn, options?: TestOptions | number): TestHandle;
	skip(name: string, fn?: TestFn): void;
	only(name: string, fn: TestFn, options?: TestOptions | number): TestHandle;
	todo(name: string): void;
	each<Row extends EachRow>(
		rows: EachRows<Row>,
	): (name: string, fn: (row: Row) => void | Promise<void>) => void;
};

function safeStringify(v: unknown): string {
	try {
		const s = JSON.stringify(v);
		return s === undefined ? String(v) : s;
	} catch {
		// Circular / BigInt / etc.
		return String(v);
	}
}

function isArrayRow(row: EachRow): row is ArrayRow {
	return Array.isArray(row);
}

function isObjectRow(row: EachRow): row is ObjectRow {
	return typeof row === "object" && row !== null && !Array.isArray(row);
}

function interpolateArrayRow(
	template: string,
	row: ArrayRow,
	index: number,
): string {
	// Hand-rolled walker so `%%` escapes to a literal `%` without consuming a
	// row value, and format specifiers consume their argument in order.
	let i = 0;
	let out = "";
	for (let j = 0; j < template.length; j += 1) {
		const c = template[j];
		if (c !== "%" || j === template.length - 1) {
			out += c;
			continue;
		}
		const next = template[j + 1];
		if (next === "%") {
			out += "%";
			j += 1;
			continue;
		}
		if (next === "#") {
			out += String(index);
			j += 1;
			continue;
		}
		if (
			next === "s" ||
			next === "d" ||
			next === "i" ||
			next === "f" ||
			next === "j" ||
			next === "o"
		) {
			const v = row[i];
			i += 1;
			out += typeof v === "object" && v !== null ? safeStringify(v) : String(v);
			j += 1;
			continue;
		}
		out += c;
	}
	return out;
}

function interpolateObjectRow(
	template: string,
	row: ObjectRow,
	index: number,
): string {
	return template
		.replace(/\$#/g, String(index))
		.replace(/\$([a-zA-Z_][\w.]*)/g, (_match, path: string) => {
			const parts = path.split(".");
			let cursor: unknown = row;
			for (const p of parts) {
				if (cursor && typeof cursor === "object" && p in cursor) {
					cursor = Reflect.get(cursor, p);
				} else {
					return "undefined";
				}
			}
			if (typeof cursor === "object" && cursor !== null)
				return safeStringify(cursor);
			return String(cursor);
		});
}

function interpolateEach(
	template: string,
	row: EachRow,
	index: number,
): string {
	if (isArrayRow(row)) return interpolateArrayRow(template, row, index);
	if (isObjectRow(row)) return interpolateObjectRow(template, row, index);
	// Primitive row (number, string, boolean, bigint, symbol, null, undefined).
	// Append index so names don't collide.
	return `${template} [${index}]`;
}

const describeFn = ((name: string, fn: SuiteFn) =>
	registerSuite(name, "run", fn)) as SuiteApi;
describeFn.skip = (name, fn) => registerSuite(name, "skip", fn);
describeFn.only = (name, fn) => registerSuite(name, "only", fn);
describeFn.todo = (name) => registerSuite(name, "todo", () => {});

const testFn = ((name: string, fn: TestFn, options?: TestOptions | number) =>
	makeHandle(
		registerTest(name, "run", fn, normaliseTestOptions(options)),
	)) as TestApi;
testFn.skip = (name, fn) => {
	registerTest(name, "skip", fn);
};
testFn.only = (name, fn, options?: TestOptions | number) =>
	makeHandle(registerTest(name, "only", fn, normaliseTestOptions(options)));
testFn.todo = (name) => {
	registerTest(name, "todo", undefined);
};
testFn.each = <Row extends EachRow>(rows: EachRows<Row>) => {
	return (name: string, fn: (row: Row) => void | Promise<void>) => {
		// A function source (`test.each(() => rows)`) is resolved eagerly at
		// collection time — per-row nodes need concrete rows to register.
		const resolved = typeof rows === "function" ? rows() : rows;
		resolved.forEach((row, index) => {
			const resolvedName = interpolateEach(name, row, index);
			registerTest(resolvedName, "run", () => fn(row));
		});
	};
};

export const describe: SuiteApi = describeFn;
export const test: TestApi = testFn;
export const it: TestApi = testFn;

export function addHook(type: HookType, fn: HookFn): void {
	current().hooks.push({ type, fn });
}

export const beforeAll = (fn: HookFn): void => addHook("beforeAll", fn);
export const afterAll = (fn: HookFn): void => addHook("afterAll", fn);
export const beforeEach = (fn: HookFn): void => addHook("beforeEach", fn);
export const afterEach = (fn: HookFn): void => addHook("afterEach", fn);
