/**
 * `describe` / `test` / `it` DSL — builds a suite tree during module load.
 *
 * Collection phase: `describe(name, fn)` runs `fn` synchronously with an
 * active suite on a per-invocation stack. `withCollection(...)` scopes the
 * collection to one `runTestFile` call via AsyncLocalStorage, so parallel
 * invocations never share state.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { TestContext } from "./context.js";
import { getFrameTest, type TestCleanup } from "./test-context.js";

/**
 * Signals completion of a `waitForDone()` test. Call `done()` to pass, or
 * `done(error)` to fail. Ignored unless `test.waitForDone()`.
 */
export type DoneFn = (error?: unknown) => void;

/**
 * A test body. Receives the injected {@link TestContext} as its first argument
 * and a `done` callback as its second. Existing zero/one-argument
 * bodies stay valid — they simply ignore the extra parameters.
 */
export type TestFn = (ctx: TestContext, done: DoneFn) => void | Promise<void>;
export type SuiteFn = () => void;

/**
 * Teardown a hook may return (Vitest parity). Receives `(hasError, subject)`
 * — whether the test/group errored, and the Test or Group instance. Both params
 * are optional so plain `() => …` cleanups stay valid.
 */
export type CleanupFn = (
	hasError?: boolean,
	subject?: TestInstance | GroupInstance,
) => void | Promise<void>;
/**
 * A lifecycle hook. Receives the Test instance (test hooks) or Group instance
 * (group hooks) as its argument; may return a {@link CleanupFn}.
 * Existing zero-argument hooks stay valid.
 */
export type HookFn =
	| ((subject?: TestInstance | GroupInstance) => void | Promise<void>)
	| ((
			subject?: TestInstance | GroupInstance,
	  ) => CleanupFn | Promise<CleanupFn>);

export type HookType = "beforeAll" | "afterAll" | "beforeEach" | "afterEach";

export interface Hook {
	type: HookType;
	fn: HookFn;
	/**
	 * Hook timeout in ms. `0` disables it; absent falls back to the run-wide
	 * test timeout.
	 *
	 * Without one a hook that never settles hangs the whole file forever, with
	 * no output saying which one — the failure mode a boot that cannot reach
	 * its database produces.
	 */
	timeoutMs?: number;
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
	/** Reason attached to `test.fails(reason)` / `test.skip(cond, reason)`. */
	reason?: string;
	/** Marked via `test.pin()` — reported as pinned; runs like `.only`. */
	pinned?: boolean;
	/** Per-test setup hooks — `test.setup(fn)` (run just before this test). */
	setups?: HookFn[];
	/** Per-test teardown hooks — `test.teardown(fn)` (run just after this test). */
	teardowns?: HookFn[];
	/** Resolved dataset rows backing this test — `test(name, fn).with(rows)` (`ctx.test.dataset`). */
	dataset?: readonly unknown[];
	/**
	 * Deferred dataset source — `test(name, fn).with(rows)`. An array OR a
	 * (possibly async) function returning one. Resolved at RUN time
	 * so async datasets work; the node then expands into one result per row.
	 */
	datasetFn?: DatasetSource<unknown>;
	/**
	 * The dataset test body — receives `(ctx, row)`. Set by `.with().run()` or
	 * re-homed from `test(name, fn).with()`. Declared as a METHOD signature so its
	 * `row` param is bivariant: a caller's `(ctx, row: Row) => …` assigns here
	 * without a cast (the type-erasure boundary between the generic `.with<Row>`
	 * surface and this untyped node storage).
	 */
	datasetBody?(ctx: TestContext, row: unknown): void | Promise<void>;
	/** Wait for the `done()` callback before completing — `test.waitForDone()`. */
	waitForDone?: boolean;
	/**
	 * Deferred skip condition — `test.skip(fn)` where `fn` may be async (helix
	 * parity). Evaluated at RUN time. A static boolean sets `mode` at collection
	 * instead, so this only ever holds a function.
	 */
	skipCondition?: () => boolean | Promise<boolean>;
}

/** A group's instance, passed to `group.setup`/`teardown` hooks. */
export interface GroupInstance {
	/** The group's own name. */
	title: string;
	/** Fully-qualified dotted name (suite path). */
	fullName: string;
}

/**
 * The running test's own instance, injected as `ctx.test`. Read
 * access to the test's identity + resolved options + dataset.
 */
export interface TestInstance {
	/** The test's own name (leaf). */
	title: string;
	/** Fully-qualified dotted name (suite path + title). */
	fullName: string;
	/** Resolved options in effect for this run (`test.options`). */
	options: {
		/** The test's title (leaf name). */
		title: string;
		timeout: number;
		retries: number;
		tags: readonly string[];
		/** Whether this is a `todo` test. Always `false` inside a running test. */
		isTodo: boolean;
		/** Whether the test is expected to throw — `test.fails()`. */
		isFailing: boolean;
		/**
		 * Free-form metadata bag (`options.meta`): `fileName`, `group` (the
		 * enclosing {@link Group} instance, or `undefined` outside a group),
		 * `suite` (`{ name }` — `"default"` unless `configure({ suite })` or
		 * `--suite` names it, the implicit suite), and `abort`.
		 */
		meta: Record<string, unknown>;
	};
	/** The full dataset when created via `test(name, fn).with(rows)`, else undefined. */
	dataset?: readonly unknown[];
	/**
	 * The injected {@link TestContext} for this run — helix's `$test.context`. Set
	 * before the `beforeEach` chain, so lifecycle hooks can reach it; the same
	 * context is passed to the test body as its first argument. Undefined only
	 * outside an active run.
	 */
	context?: TestContext;
	/** Whether the test was pinned via `test.pin()`. */
	isPinned: boolean;
	/**
	 * Re-arm the running test's timeout (`ctx.test.resetTimeout`). With no
	 * argument, restarts the current timeout; with `ms`, sets a new one. Useful
	 * for long polling steps that shouldn't count against a single deadline.
	 */
	resetTimeout(ms?: number): void;
	/**
	 * Register a teardown that runs at the end of THIS test regardless of outcome
	 * (`test.cleanup`). This is the same registry as `ctx.cleanup`; it is
	 * exposed here so a resource macro's `t` (see `test.macro`) can register
	 * cleanups — `test.macro((t) => { t.cleanup(() => …) })`.
	 */
	cleanup(fn: TestCleanup): void;
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
 * Chainable handle returned by `test(...)` — helix-style fluent modifiers that
 * mutate the just-registered node. Ignoring the return keeps Vitest's
 * `test(name, fn)` ergonomics; chaining adds `helix` parity.
 */
/** How `tags()` merges with any tags already on the test. */
export type TagStrategy = "replace" | "append" | "prepend";

export interface TestHandle {
	retry(n: number): TestHandle;
	timeout(ms: number): TestHandle;
	disableTimeout(): TestHandle;
	/**
	 * Attach tags. `tags(['@slow'], 'append')`. `strategy` defaults
	 * to `'replace'`. A single string is accepted as a shorthand.
	 */
	tags(tags: string | string[], strategy?: TagStrategy): TestHandle;
	/** Expect the test to throw. Optional `reason` documents why. */
	fails(reason?: string): TestHandle;
	/** Run a hook just before THIS test (`test.setup`). */
	setup(fn: HookFn): TestHandle;
	/** Run a hook just after THIS test (`test.teardown`). */
	teardown(fn: HookFn): TestHandle;
	/** Pin the test: when any test is pinned, only pinned tests run (`test.pin`). */
	pin(): TestHandle;
	/**
	 * Skip the test, optionally only when `condition` (a boolean OR a function
	 * returning one — which may be async) is true, with a `reason`.
	 * A function condition is evaluated at RUN time, not at collection.
	 */
	skip(
		condition?: boolean | (() => boolean | Promise<boolean>),
		reason?: string,
	): TestHandle;
	/** Complete only once the body calls its `done` callback (`waitForDone`). */
	waitForDone(): TestHandle;
	/**
	 * Attach a dataset. Two forms:
	 *   - `test('title', (ctx, row) => …).with([...])` — the body from `test()`
	 *     is re-homed and runs once per row (row typed as the 2nd body arg).
	 *   - `test('title').with([...]).run((ctx, row) => …)` — the fully-typed
	 *     form; `row` is inferred as the dataset element type.
	 * `rows` may be an array OR a (possibly async) function returning one,
	 * resolved at run time. Title tokens: `{prop}` (object rows), `{$i}`
	 * (1-based index), `{$self}` (the row itself).
	 */
	with<Row>(rows: DatasetSource<Row>): DatasetHandle<Row>;
}

/**
 * The handle returned by `test(...).with(rows)` — carries the dataset element
 * type so `.run((ctx, row) => …)` types `row` precisely.
 */
export interface DatasetHandle<Row> {
	/**
	 * Provide the per-row body when `test('title')` had none —
	 * `test('title').with([...]).run((ctx, row) => …)`. Takes only the body (no
	 * name); the name came from `test()`. Returns the base handle for further
	 * chaining.
	 */
	run(fn: (ctx: TestContext, row: Row) => void | Promise<void>): TestHandle;
}

export interface SuiteNode {
	kind: "suite";
	name: string;
	mode: RunMode;
	parent: SuiteNode | undefined;
	children: Array<SuiteNode | TestNode>;
	hooks: Hook[];
	/** Default per-test timeout for tests in this group — `group.each.timeout(ms)`. */
	eachTimeout?: number;
	/** Default per-test retries for tests in this group — `group.each.retry(n)`. */
	eachRetries?: number;
	/** Opened via `test.group()` (vs `describe`) — helix forbids nesting these. */
	isGroup?: boolean;
	/**
	 * The single {@link Group} instance built by `test.group()` for this node —
	 * the body handle, the value returned, AND the `self` its hooks receive
	 * (`self === group`). Absent on plain `describe` suites.
	 */
	groupInstance?: Group;
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

/** Consumer-registered handle macros (`Test.macro`) applied to every handle. */
const handleMacros = new Map<
	string,
	(this: TestHandle, ...args: unknown[]) => unknown
>();

/** Wrap a registered node in the chainable helix-style handle. */
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
		tags(tags: string | string[], strategy: TagStrategy = "replace") {
			const incoming = Array.isArray(tags) ? tags : [tags];
			const existing = node.tags ?? [];
			node.tags =
				strategy === "append"
					? [...existing, ...incoming]
					: strategy === "prepend"
						? [...incoming, ...existing]
						: [...incoming];
			return handle;
		},
		fails(reason?: string) {
			node.failing = true;
			if (reason !== undefined) node.reason = reason;
			return handle;
		},
		setup(fn: HookFn) {
			if (!node.setups) node.setups = [];
			node.setups.push(fn);
			return handle;
		},
		teardown(fn: HookFn) {
			if (!node.teardowns) node.teardowns = [];
			node.teardowns.push(fn);
			return handle;
		},
		pin() {
			node.pinned = true;
			// A pinned test runs like `.only` — the runner already restricts the
			// tree to `only` nodes when any exist.
			if (node.mode === "run") node.mode = "only";
			return handle;
		},
		skip(
			condition: boolean | (() => boolean | Promise<boolean>) = true,
			reason?: string,
		) {
			if (typeof condition === "function") {
				// Deferred: a function condition (possibly async) is evaluated at RUN
				// time, not eagerly at collection.
				node.skipCondition = condition;
				if (reason !== undefined) node.reason = reason;
			} else if (condition) {
				node.mode = "skip";
				if (reason !== undefined) node.reason = reason;
			}
			return handle;
		},
		waitForDone() {
			node.waitForDone = true;
			return handle;
		},
		with<Row>(rows: DatasetSource<Row>): DatasetHandle<Row> {
			// Covariant: DatasetSource<Row> assigns to DatasetSource<unknown> (no cast).
			node.datasetFn = rows;
			// If `test(name, fn)` already supplied a body, it IS the dataset body —
			// re-home it so the executor calls it with `(ctx, row)`. `datasetBody`'s
			// bivariant method signature accepts `node.fn` directly (no cast). A body
			// added later via `.run()` overrides this.
			if (node.datasetBody === undefined && node.fn) {
				node.datasetBody = node.fn;
			}
			// A `test('title')` with no body was registered as `todo`; attaching a
			// dataset makes it a runnable, per-row test again.
			if (node.mode === "todo") node.mode = "run";
			node.fn = undefined;
			const datasetHandle: DatasetHandle<Row> = {
				run(fn) {
					// Bivariant method param → the Row-typed body assigns without a cast.
					node.datasetBody = fn;
					if (node.mode === "todo") node.mode = "run";
					node.fn = undefined;
					return handle;
				},
			};
			return datasetHandle;
		},
	};
	// Apply consumer-registered macros (`Test.macro`) — `this` is the handle
	// so the macro can chain.
	for (const [name, fn] of handleMacros) {
		Object.defineProperty(handle, name, {
			value: (...args: unknown[]) => fn.apply(handle, args),
			enumerable: false,
			configurable: true,
			writable: true,
		});
	}
	return handle;
}

/**
 * Build the {@link TapHandle} passed to `group.tap` — the chainable modifiers
 * plus a mutable `options` view backed live by the node (`test.options`).
 */
function makeTapHandle(node: TestNode): TapHandle {
	const handle = makeHandle(node);
	const options: TapOptions = {
		get title() {
			return node.name;
		},
		set title(v: string) {
			node.name = v;
		},
		get tags() {
			return node.tags ?? [];
		},
		set tags(v: string[]) {
			node.tags = v;
		},
		get timeout() {
			return node.timeoutMs;
		},
		set timeout(v: number | undefined) {
			node.timeoutMs = v;
		},
		get retries() {
			return node.retries;
		},
		set retries(v: number | undefined) {
			node.retries = v;
		},
	};
	return Object.assign(handle, { options });
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

/**
 * Source of dataset rows (`test(name, fn).with(...)`): a static array OR a
 * function returning one — the function may be async. Resolved at
 * RUN time so async sources work.
 */
export type DatasetSource<Row> =
	| readonly Row[]
	| (() => readonly Row[] | Promise<readonly Row[]>);

/**
 * The `group` handle passed to `test.group(name, (group) => …)`.
 * `setup`/`teardown` run once for the whole group; `each.setup`/`each.teardown`
 * run around every test in it. Hook bodies may return a cleanup function.
 */
export interface Group extends GroupInstance {
	/** Run once before all tests in the group (≈ `beforeAll`). */
	setup(fn: HookFn): void;
	/** Run once after all tests in the group (≈ `afterAll`). */
	teardown(fn: HookFn): void;
	/** Per-test hooks + defaults for this group (≈ `beforeEach`/`afterEach`). */
	each: {
		setup(fn: HookFn): void;
		teardown(fn: HookFn): void;
		/** Default timeout (ms) for every test in the group — `group.each.timeout(ms)`. */
		timeout(ms: number): void;
		/** Disable the timeout for every test in the group. */
		disableTimeout(): void;
		/** Default retries for every test in the group — `group.each.retry(n)`. */
		retry(n: number): void;
	};
	/**
	 * Configure every test in the group — `group.tap(t => t.tags('@slow'))` or
	 * `group.tap(t => { t.options.title = t.options.title.toUpperCase() })`.
	 * Applied to all tests registered in the group body. The callback receives a
	 * {@link TapHandle}: the chainable modifiers PLUS a mutable `options` view
	 * (`test.options.title`).
	 */
	tap(fn: (test: TapHandle) => void): void;
}

/** The mutable, resolved options of a test, exposed to `group.tap`. */
export interface TapOptions {
	/** The test's title — assignable to rename it (`test.options.title`). */
	title: string;
	/** The test's tags — assignable to replace them. */
	tags: string[];
	/** Per-test timeout in ms (`undefined` = inherit). */
	timeout: number | undefined;
	/** Extra attempts on failure (`undefined` = inherit). */
	retries: number | undefined;
}

/**
 * The handle passed to `group.tap` — a {@link TestHandle} (chainable modifiers)
 * augmented with a mutable {@link TapOptions} view, matching helix's `test`
 * instance whose `options` are directly assignable.
 */
export interface TapHandle extends TestHandle {
	readonly options: TapOptions;
}

type TestApi = {
	/**
	 * Register a test. Omitting `fn` marks it `todo` — reported as
	 * pending and never executed — unless a dataset body is supplied later via
	 * `.with(...).run(fn)`.
	 */
	(name: string, fn?: TestFn, options?: TestOptions | number): TestHandle;
	skip(name: string, fn?: TestFn): void;
	only(name: string, fn: TestFn, options?: TestOptions | number): TestHandle;
	todo(name: string): void;
	each<Row extends EachRow>(
		rows: EachRows<Row>,
	): (name: string, fn: (row: Row) => void | Promise<void>) => void;
	/**
	 * helix-style grouping: `test.group(name, (group) => { … })`. Returns the
	 * {@link Group} — the SAME instance passed to the body and to the group's
	 * hooks as `self` (helix's current release returns the group; `self === group`).
	 */
	group(name: string, fn: (group: Group) => void): Group;
	/**
	 * Create a resource macro (`test.macro`). The callback receives the
	 * running test instance `t` (carrying `t.cleanup`) followed by any arguments;
	 * `macro` returns a function that, called inside a test body, invokes the
	 * callback against the active test and returns its value:
	 *
	 *     const useFile = test.macro((t, path: string) => {
	 *       t.cleanup(() => rm(path))
	 *       return writeFile(path, '…')
	 *     })
	 *     // inside a test: await useFile('tmp/a.txt')
	 *
	 * To add a chainable method to every handle instead, use {@link Test.macro}.
	 */
	macro<Args extends unknown[], R>(
		callback: (test: TestInstance, ...args: Args) => R,
	): (...args: Args) => R;
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

/**
 * Interpolate a dataset test title. Tokens:
 *   - `{$i}`   → the 1-based row index
 *   - `{$self}`→ the row itself (stringified) — for primitive/array rows
 *   - `{prop}` / `{a.b}` → a (dotted) property lookup on an object row
 * Unknown `{tokens}` are left verbatim. A template with no token at all is
 * returned unchanged and therefore repeats for every row — helix's behaviour,
 * and what the golden dataset spec pins down.
 */
export function interpolateDatasetTitle(
	template: string,
	row: unknown,
	index: number,
): string {
	// No token: helix returns the title unchanged and repeats it for every row.
	// helix used to append ` (row N)` to keep them distinct; that made titles a
	// reporter shows — and `--tests` never matched on, since filtering reads the
	// declared name — differ from helix's for the same spec.
	if (!/\{[^}]+\}/.test(template)) return template;
	return template.replace(/\{([^}]+)\}/g, (match, tokenRaw: string) => {
		const token = tokenRaw.trim();
		if (token === "$i") return String(index + 1);
		if (token === "$self") {
			return typeof row === "object" && row !== null
				? safeStringify(row)
				: String(row);
		}
		// Dotted property path against an object row.
		let cursor: unknown = row;
		for (const part of token.split(".")) {
			if (cursor && typeof cursor === "object" && part in cursor) {
				cursor = Reflect.get(cursor, part);
			} else {
				return match; // leave unknown tokens verbatim
			}
		}
		if (typeof cursor === "object" && cursor !== null)
			return safeStringify(cursor);
		return String(cursor);
	});
}

const describeFn = ((name: string, fn: SuiteFn) =>
	registerSuite(name, "run", fn)) as SuiteApi;
describeFn.skip = (name, fn) => registerSuite(name, "skip", fn);
describeFn.only = (name, fn) => registerSuite(name, "only", fn);
describeFn.todo = (name) => registerSuite(name, "todo", () => {});

const testFn = ((name: string, fn?: TestFn, options?: TestOptions | number) => {
	// No body → `todo`. A dataset body added later via
	// `.with(...).run(fn)` promotes it back to a runnable test.
	const mode: RunMode = fn === undefined ? "todo" : "run";
	return makeHandle(
		registerTest(name, mode, fn, normaliseTestOptions(options)),
	);
}) as TestApi;
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
testFn.group = (name: string, fn: (group: Group) => void): Group => {
	// helix forbids nested groups (grouping-tests docs) — a group inside a group
	// is a structural error, not a supported nesting.
	for (
		let ancestor: SuiteNode | undefined = current();
		ancestor !== undefined;
		ancestor = ancestor.parent
	) {
		if (ancestor.isGroup) {
			throw new Error(
				`test.group("${name}") cannot be nested inside group "${ancestor.name}" — helix does not allow nested groups.`,
			);
		}
	}
	// A group IS a suite. Build ONE instance that is the body handle, the value
	// returned, AND the `self` the group's hooks receive (`self === group`).
	// Its hook methods attach to THIS active suite via `addHook`.
	let instance: Group | undefined;
	registerSuite(name, "run", () => {
		const suite = current();
		suite.isGroup = true;
		// Dotted full name from the suite chain (matching the runtime `joinName`
		// separator); computed HERE where `suite` is the group's own node.
		const ancestorNames: string[] = [];
		for (let a: SuiteNode | undefined = suite; a !== undefined; a = a.parent) {
			if (a.name) ancestorNames.unshift(a.name);
		}
		const taps: Array<(test: TapHandle) => void> = [];
		const group: Group = {
			title: name,
			fullName: ancestorNames.join(" > "),
			setup: (hookFn) => addHook("beforeAll", hookFn),
			teardown: (hookFn) => addHook("afterAll", hookFn),
			each: {
				setup: (hookFn) => addHook("beforeEach", hookFn),
				teardown: (hookFn) => addHook("afterEach", hookFn),
				timeout: (ms) => {
					suite.eachTimeout = ms;
				},
				disableTimeout: () => {
					suite.eachTimeout = 0;
				},
				retry: (n) => {
					suite.eachRetries = n;
				},
			},
			tap: (tapFn) => taps.push(tapFn),
		};
		suite.groupInstance = group;
		instance = group;
		fn(group);
		// Apply `tap` callbacks to every test registered directly in this group,
		// regardless of whether tap() was called before or after them.
		if (taps.length > 0) {
			for (const child of suite.children) {
				if (child.kind === "test") {
					const handle = makeTapHandle(child);
					for (const tapFn of taps) tapFn(handle);
				}
			}
		}
	});
	// `registerSuite` ran the body synchronously, so `instance` is set.
	if (instance === undefined) {
		throw new Error(`internal: group("${name}") instance was not built`);
	}
	return instance;
};

testFn.macro = <Args extends unknown[], R>(
	callback: (test: TestInstance, ...args: Args) => R,
): ((...args: Args) => R) => {
	return (...args: Args): R => {
		const t = getFrameTest();
		if (t === undefined) {
			throw new Error(
				"test.macro(...): the returned function must be invoked inside a running test.",
			);
		}
		return callback(t, ...args);
	};
};

/**
 * Class-level extension surface (`Test.macro`). Registers a named method
 * available on every test handle; `this` inside it is the handle, so it can
 * chain (`Test.macro('slow', function () { this.tags(['@slow']); return this })`).
 * Pair with a `declare module` augmentation for the types.
 */
export const Test: {
	macro(
		name: string,
		fn: (this: TestHandle, ...args: unknown[]) => unknown,
	): void;
} = {
	macro(name, fn) {
		handleMacros.set(name, fn);
	},
};

export const describe: SuiteApi = describeFn;
export const test: TestApi = testFn;
export const it: TestApi = testFn;

export function addHook(type: HookType, fn: HookFn, timeoutMs?: number): void {
	current().hooks.push({ type, fn, timeoutMs });
}

/**
 * The optional second argument is the hook's timeout in ms, as in Vitest and
 * Jest — `beforeAll(fn, 30_000)`. It used to be accepted by neither the types
 * nor the runner: the value was dropped and the hook ran unbounded.
 */
export const beforeAll = (fn: HookFn, timeoutMs?: number): void =>
	addHook("beforeAll", fn, timeoutMs);
export const afterAll = (fn: HookFn, timeoutMs?: number): void =>
	addHook("afterAll", fn, timeoutMs);
export const beforeEach = (fn: HookFn, timeoutMs?: number): void =>
	addHook("beforeEach", fn, timeoutMs);
export const afterEach = (fn: HookFn, timeoutMs?: number): void =>
	addHook("afterEach", fn, timeoutMs);
