/**
 * Execution engine — walks the suite tree collected by `suite.ts`,
 * runs each test with its inherited hook chain, and produces a structured
 * `FileResult` for the orchestrator.
 *
 * `.only` handling: if any test or suite is marked `only` anywhere in the
 * tree, non-`only` paths are downgraded to `skip` before execution.
 */

import { AssertionError } from "./assertion-error.js";
import { buildTestContext } from "./context.js";
import {
	type EmittedDataset,
	type EmittedError,
	type ErrorPhase,
	emitter,
	type TestStartNode,
} from "./emitter.js";
import type {
	CleanupFn,
	DoneFn,
	Group,
	GroupInstance,
	Hook,
	SuiteNode,
	TestInstance,
	TestNode,
} from "./suite.js";
import { interpolateDatasetTitle } from "./suite.js";
import {
	drainTestOutcomeHooks,
	getAssertionState,
	registerTestCleanup,
	setFrameOutcome,
	setFrameTest,
	withTestContext,
} from "./test-context.js";

export interface TestResult {
	name: string;
	fullName: string;
	status: "pass" | "fail" | "skip" | "todo";
	durationMs: number;
	error?: SerializedError;
	/** Lifecycle phase `error` was raised in (Japa `test:end` parity). */
	errorPhase?: ErrorPhase;
}

export interface SuiteResult {
	name: string;
	fullName: string;
	children: Array<SuiteResult | TestResult>;
	status: "pass" | "fail" | "skip";
	durationMs: number;
	/** Hook errors attributed to this suite (beforeAll/afterAll). */
	hookErrors: SerializedError[];
}

export interface SerializedError {
	name: string;
	message: string;
	stack?: string;
	actual?: unknown;
	expected?: unknown;
	operator?: string;
}

export interface FileResult {
	file: string;
	suites: SuiteResult[];
	tests: TestResult[];
	totals: {
		pass: number;
		fail: number;
		skip: number;
		todo: number;
	};
	durationMs: number;
}

export interface ExecuteOptions {
	/**
	 * Per-test timeout in ms. `0` disables (default). When exceeded, the
	 * test is marked failed with a timeout error; the hanging promise is not
	 * awaited further. A per-test `test.timeout(ms)` overrides this.
	 */
	timeoutMs?: number;
	/**
	 * Default extra attempts on failure. `test.retry(n)` / `{ retry }` override
	 * per test. `0` (default) runs each test once.
	 */
	retries?: number;
	/**
	 * Only run tests whose full name matches this pattern (regex source or a
	 * plain substring). Mirrors `--grep` / Vitest `-t`.
	 */
	grep?: string;
	/**
	 * Tag filter expressions (Japa `--tags`). A `~`-prefixed tag EXCLUDES (`!` is
	 * also accepted). Required tags are OR-ed by default — a test runs when it
	 * carries ANY of them — unless {@link ExecuteOptions.matchAll} is set, and
	 * never when it carries an excluded tag.
	 */
	tags?: string[];
	/** Require ALL required tags instead of any (Japa `--match-all`). */
	matchAll?: boolean;
	/** Exact test titles to run (Japa `--tests`). A test runs only if its leaf title is listed. */
	tests?: string[];
	/** Exact group titles to run (Japa `--groups`). A test runs only if its enclosing group is listed. */
	groups?: string[];
	/**
	 * The suite these tests belong to — `ctx.test.options.meta.suite` and the
	 * `suite:*` event payloads. Defaults to `"default"`, Japa's implicit suite.
	 */
	suite?: string;
	/**
	 * Stop running once a test fails (Japa `--bail`). Everything after the
	 * failure is reported as SKIPPED, not dropped — same as Japa, so the counts
	 * still add up.
	 */
	bail?: boolean;
	/**
	 * How far a bail reaches (Japa `--bail-layer`): `"group"` stops the enclosing
	 * group only, `"suite"` the rest of the file, `"runner"` (Japa's default,
	 * spelled `""` on its CLI) the rest of the run — the remaining FILES are
	 * dropped by the pool, since helix runs one process per file and cannot skip
	 * tests it never collected.
	 */
	bailLayer?: "group" | "suite" | "runner" | "";
}

/**
 * Compiled tag filter (Japa `--tags` / `--match-all`). A test passes when it
 * carries no `excluded` tag AND — if any `required` — matches them by the
 * `matchAll` mode (all vs any).
 */
interface TagFilter {
	required: string[];
	excluded: string[];
	/** `true` → every required tag must be present; `false` (default) → any. */
	matchAll: boolean;
}

function compileTagFilter(
	tags: string[] | undefined,
	matchAll: boolean,
): TagFilter | undefined {
	if (!tags || tags.length === 0) return undefined;
	const required: string[] = [];
	const excluded: string[] = [];
	for (const raw of tags) {
		const t = raw.trim();
		if (!t) continue;
		// `~` is the Japa exclusion prefix; `!` is accepted too (helix legacy) so a
		// stray `!` never silently becomes an impossible required tag.
		if (t.startsWith("~") || t.startsWith("!")) excluded.push(t.slice(1));
		else required.push(t);
	}
	if (required.length === 0 && excluded.length === 0) return undefined;
	return { required, excluded, matchAll };
}

function compileGrep(grep: string | undefined): RegExp | undefined {
	if (!grep) return undefined;
	try {
		return new RegExp(grep);
	} catch {
		// A malformed regex falls back to a literal substring match.
		return new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	}
}

function tagMatches(node: TestNode, filter: TagFilter): boolean {
	const have = new Set(node.tags ?? []);
	// Exclusions always win.
	for (const e of filter.excluded) if (have.has(e)) return false;
	if (filter.required.length === 0) return true;
	// OR by default (any required tag), AND under `--match-all` (every one).
	return filter.matchAll
		? filter.required.every((r) => have.has(r))
		: filter.required.some((r) => have.has(r));
}

/** Nearest enclosing `test.group(...)` title, for the Japa `--groups` filter. */
function enclosingGroupTitle(node: TestNode): string | undefined {
	for (
		let s: SuiteNode | undefined = node.parent;
		s !== undefined;
		s = s.parent
	) {
		if (s.isGroup) return s.name;
	}
	return undefined;
}

/** Whether the test's enclosing group is one of the `--groups` titles. */
function isInGroups(node: TestNode, groups: Set<string>): boolean {
	const title = enclosingGroupTitle(node);
	return title !== undefined && groups.has(title);
}

function serializeError(err: unknown): SerializedError {
	if (err instanceof AssertionError) {
		return {
			name: err.name,
			message: err.message,
			stack: err.stack,
			actual: err.actual,
			expected: err.expected,
			operator: err.operator,
		};
	}
	if (err instanceof Error) {
		return { name: err.name, message: err.message, stack: err.stack };
	}
	return { name: "NonError", message: String(err) };
}

function hasOnly(node: SuiteNode | TestNode): boolean {
	if (node.mode === "only") return true;
	if (node.kind === "test") return false;
	return node.children.some(hasOnly);
}

function ancestorHasOnly(node: SuiteNode | TestNode): boolean {
	let cursor: SuiteNode | undefined = node.parent;
	while (cursor) {
		if (cursor.mode === "only") return true;
		cursor = cursor.parent;
	}
	return false;
}

function pathLeadsToOnly(node: SuiteNode | TestNode): boolean {
	if (node.mode === "only") return true;
	if (ancestorHasOnly(node)) return true;
	if (node.kind === "suite") {
		return node.children.some(hasOnly);
	}
	return false;
}

function collectHookChain(
	leaf: SuiteNode,
	type: "beforeEach" | "afterEach",
): Hook["fn"][] {
	// beforeEach: outermost first; afterEach: innermost first.
	const suites: SuiteNode[] = [];
	let cursor: SuiteNode | undefined = leaf;
	while (cursor) {
		suites.push(cursor);
		cursor = cursor.parent;
	}
	const ordered = type === "beforeEach" ? [...suites].reverse() : suites;
	const chain: Hook["fn"][] = [];
	for (const s of ordered) {
		for (const h of s.hooks) {
			if (h.type === type) chain.push(h.fn);
		}
	}
	return chain;
}

async function runHooks(
	hooks: Hook["fn"][],
	registerCleanups = false,
	subject?: TestInstance | GroupInstance,
): Promise<SerializedError | undefined> {
	for (const h of hooks) {
		try {
			// Japa parity: test hooks receive the Test instance, group hooks the
			// Group instance. Zero-arg hooks simply ignore it.
			const ret = await h(subject);
			// A `beforeEach` returning a function registers it as a test-scoped
			// cleanup (Vitest/Japa parity). Ignored for `afterEach`.
			if (registerCleanups && typeof ret === "function") {
				registerTestCleanup(ret);
			}
		} catch (err) {
			return serializeError(err);
		}
	}
	return undefined;
}

function joinName(parent: string, name: string): string {
	if (!parent) return name;
	if (!name) return parent;
	return `${parent} > ${name}`;
}

function combineErrors(
	primary: SerializedError | undefined,
	secondary: SerializedError | undefined,
): SerializedError | undefined {
	if (!primary) return secondary;
	if (!secondary) return primary;
	return {
		name: primary.name,
		message: `${primary.message}\n+ teardown also failed: ${secondary.message}`,
		stack: primary.stack,
		actual: primary.actual,
		expected: primary.expected,
		operator: primary.operator,
	};
}

/** A test-body timeout that can be re-armed mid-flight (`ctx.test.resetTimeout`). */
interface TimeoutController {
	/** Race `work` against the current deadline. */
	race<T>(work: Promise<T> | T): Promise<T>;
	/** Restart the timer (optionally with a new duration). */
	reset(ms?: number): void;
}

function makeTimeoutController(ms: number, label: string): TimeoutController {
	let timer: NodeJS.Timeout | undefined;
	let rejectTimeout: ((err: unknown) => void) | undefined;
	let current = ms;
	const arm = () => {
		if (current <= 0) return;
		timer = setTimeout(() => {
			rejectTimeout?.(new Error(`${label} exceeded ${current}ms timeout`));
		}, current);
		timer.unref?.();
	};
	return {
		race<T>(work: Promise<T> | T): Promise<T> {
			if (current <= 0) return Promise.resolve(work);
			const timeout = new Promise<T>((_, reject) => {
				rejectTimeout = reject;
				arm();
			});
			return Promise.race([
				Promise.resolve(work).then((v) => {
					if (timer) clearTimeout(timer);
					return v;
				}),
				timeout,
			]);
		},
		reset(newMs?: number): void {
			if (timer) clearTimeout(timer);
			if (newMs !== undefined) current = newMs;
			arm();
		},
	};
}

interface RunCtx {
	onlyActive: boolean;
	flatTests: TestResult[];
	timeoutMs: number;
	retries: number;
	grep: RegExp | undefined;
	tagFilter: TagFilter | undefined;
	/** Exact test titles to run (Japa `--tests`); `undefined` = no title filter. */
	testTitles: Set<string> | undefined;
	/** Exact group titles to run (Japa `--groups`); `undefined` = no group filter. */
	groupTitles: Set<string> | undefined;
	/** The test file being executed — surfaced as `ctx.test.options.meta.fileName`. */
	file: string;
	/** The suite these tests belong to (Japa `meta.suite` / `suite:*`). */
	suite: SuiteIdentity;
	/** Stop after the first failure (Japa `--bail`). */
	bail: boolean;
	/** How far a bail reaches — `"group"` resets at each group boundary. */
	bailLayer: "group" | "suite" | "runner";
	/** Set once a test has failed under `bail`; skips everything after it. */
	bailed: boolean;
}

/**
 * Whether a test survives the run's filters (Japa's refiner). `--grep` is a
 * helix extra applied per resolved title, so it lives at the call sites that
 * know the interpolated name rather than here.
 */
function isFilteredOut(node: TestNode, ctx: RunCtx): boolean {
	return (
		(ctx.tagFilter !== undefined && !tagMatches(node, ctx.tagFilter)) ||
		(ctx.testTitles !== undefined && !ctx.testTitles.has(node.name)) ||
		(ctx.groupTitles !== undefined && !isInGroups(node, ctx.groupTitles)) ||
		(ctx.onlyActive && !pathLeadsToOnly(node))
	);
}

/**
 * Whether any test under this suite survives the filters — Japa's
 * `Refiner#isGroupAllowed`: a group announces itself only when it has at least
 * one runnable test, so a fully filtered-out group is invisible to reporters.
 */
function suiteHasRunnableTest(node: SuiteNode, ctx: RunCtx): boolean {
	for (const child of node.children) {
		if (child.kind === "test") {
			if (!isFilteredOut(child, ctx)) return true;
		} else if (suiteHasRunnableTest(child, ctx)) {
			return true;
		}
	}
	return false;
}

/**
 * The suite a run belongs to (Japa `meta.suite`). Helix runs one process per
 * FILE, so the suite is a name the run carries — `"default"` unless
 * `configure({ suite })` or `--suite` says otherwise, exactly like Japa's
 * implicit suite.
 */
export interface SuiteIdentity {
	name: string;
}

/**
 * The `meta` bag exposed as `ctx.test.options.meta` and on the test events —
 * Japa's `{ suite, group, fileName, abort }`.
 */
function testMeta(node: TestNode, ctx: RunCtx): Record<string, unknown> {
	return {
		suite: ctx.suite,
		group: enclosingGroup(node),
		fileName: ctx.file,
		// Japa's escape hatch: fail the running test with a given message.
		abort: (message: string): never => {
			throw new Error(message);
		},
	};
}

/** Nearest enclosing `test.group(...)` instance, if any (Japa `meta.group`). */
function enclosingGroup(node: TestNode): Group | undefined {
	for (
		let s: SuiteNode | undefined = node.parent;
		s !== undefined;
		s = s.parent
	) {
		if (s.isGroup) return s.groupInstance;
	}
	return undefined;
}

/**
 * The `test:start` payload for one concrete test (a plain test, or one dataset
 * row). `test:end` is this object plus the outcome — exactly how Japa builds
 * the two nodes.
 */
function buildTestStartNode(
	node: TestNode,
	expandedTitle: string,
	ctx: RunCtx,
	dataset: EmittedDataset | undefined,
	flags: { isTodo: boolean; isSkipped: boolean },
): TestStartNode {
	return {
		title: { original: node.name, expanded: expandedTitle },
		tags: node.tags ?? [],
		timeout: node.timeoutMs ?? ctx.timeoutMs,
		retries: node.retries,
		isTodo: flags.isTodo,
		isSkipped: flags.isSkipped,
		isFailing: node.failing === true,
		isPinned: node.pinned === true,
		meta: testMeta(node, ctx),
		dataset,
	};
}

/** The `errors` array of a `test:end` / `group:end` node. */
function toEmittedErrors(
	error: SerializedError | undefined,
	phase: ErrorPhase,
): EmittedError[] {
	return error === undefined ? [] : [{ phase, error }];
}

/**
 * Emit the Japa `test:start` / `test:end` pair for a test that never runs a
 * body — a `todo`, an explicit `.skip()`, or a test whose skip condition threw.
 * Japa announces those through its `DummyRunner`, back-to-back.
 *
 * Tests dropped by a FILTER (`--tags`/`--tests`/`--groups`/`--grep`/`.only`)
 * are deliberately NOT emitted: Japa's refiner removes them before they can
 * announce themselves, so a reporter never hears about them. They still show up
 * as `skip` in {@link FileResult}, which is what the (Vitest-shaped) CLI
 * reporter consumes.
 */
function emitTestResult(
	node: TestNode,
	result: TestResult,
	ctx: RunCtx,
	dataset?: EmittedDataset,
): void {
	const start = buildTestStartNode(node, result.name, ctx, dataset, {
		isTodo: result.status === "todo",
		isSkipped: result.status === "skip",
	});
	emitter.emit("test:start", start);
	emitter.emit("test:end", {
		...start,
		duration: result.durationMs,
		hasError: result.status === "fail",
		errors: toEmittedErrors(result.error, result.errorPhase ?? "test"),
	});
}

async function runTest(
	node: TestNode,
	parentFullName: string,
	ctx: RunCtx,
): Promise<TestResult[]> {
	const baseFullName = joinName(parentFullName, node.name);

	// Filter gates (Japa's refiner). Computed first because a filtered-out test
	// emits NOTHING — not even the `test:start`/`test:end` pair a `.skip()` or a
	// `todo` still announces. `grep` is per-name (per row for datasets), so it
	// stays below.
	const filteredOut = isFilteredOut(node, ctx);

	// A dataset test with no body (`test('x').with(rows)` and no `.run(fn)` / no
	// body in `test`) is a `todo` — same as a bodiless plain test (Japa parity).
	const datasetTodo =
		node.datasetFn !== undefined && node.datasetBody === undefined;
	if (node.mode === "todo" || datasetTodo) {
		const r: TestResult = {
			name: node.name,
			fullName: baseFullName,
			status: "todo",
			durationMs: 0,
		};
		ctx.flatTests.push(r);
		if (!filteredOut) emitTestResult(node, r, ctx);
		return [r];
	}

	// Deferred skip condition (Japa: a `skip(fn)` callback — possibly async — is
	// evaluated here at run time, not eagerly at collection). A throwing
	// condition fails the test rather than silently skipping it.
	let deferredSkip = false;
	if (node.skipCondition !== undefined) {
		try {
			deferredSkip = Boolean(await node.skipCondition());
		} catch (err) {
			const r: TestResult = {
				name: node.name,
				fullName: baseFullName,
				status: "fail",
				durationMs: 0,
				error: serializeError(err),
				errorPhase: "setup",
			};
			ctx.flatTests.push(r);
			if (!filteredOut) emitTestResult(node, r, ctx);
			return [r];
		}
	}

	// Node-level gates that apply to the whole test (and every dataset row).
	// `grep` is applied per-name below (per row for datasets). A bailed run skips
	// what is left — Japa marks them `skip`, it does not drop them.
	const nodeSkipped =
		node.mode === "skip" || deferredSkip || filteredOut || ctx.bailed;

	const makeSkip = (
		name: string,
		fullName: string,
		emit: boolean,
		dataset?: EmittedDataset,
	): TestResult => {
		const r: TestResult = { name, fullName, status: "skip", durationMs: 0 };
		ctx.flatTests.push(r);
		if (emit) emitTestResult(node, r, ctx, dataset);
		return r;
	};
	const grepOut = (fullName: string): boolean =>
		ctx.grep !== undefined && !ctx.grep.test(fullName);

	// Dataset expansion (Japa `test(name, fn).with(rows)`): resolve the rows at
	// run time (awaiting an async source), then run one test per row with an
	// interpolated title. The full resolved dataset is exposed as `ctx.test.dataset`.
	if (node.datasetFn !== undefined) {
		let rows: readonly unknown[];
		try {
			rows =
				typeof node.datasetFn === "function"
					? await node.datasetFn()
					: node.datasetFn;
		} catch (err) {
			const r: TestResult = {
				name: node.name,
				fullName: baseFullName,
				status: "fail",
				durationMs: 0,
				error: serializeError(err),
				errorPhase: "setup",
			};
			ctx.flatTests.push(r);
			if (!filteredOut) emitTestResult(node, r, ctx);
			return [r];
		}
		const results: TestResult[] = [];
		for (let i = 0; i < rows.length; i += 1) {
			const title = interpolateDatasetTitle(node.name, rows[i], i, rows.length);
			const fullName = joinName(parentFullName, title);
			const dataset: EmittedDataset = {
				size: rows.length,
				index: i,
				row: rows[i],
			};
			if (nodeSkipped || grepOut(fullName)) {
				const emit = !filteredOut && !grepOut(fullName);
				results.push(makeSkip(title, fullName, emit, dataset));
				continue;
			}
			results.push(
				await runOneTest(node, title, fullName, ctx, rows, rows[i], dataset),
			);
		}
		return results;
	}

	// Single (non-dataset) test.
	if (nodeSkipped || grepOut(baseFullName)) {
		const emit = !filteredOut && !grepOut(baseFullName);
		return [makeSkip(node.name, baseFullName, emit)];
	}
	return [
		await runOneTest(
			node,
			node.name,
			baseFullName,
			ctx,
			undefined,
			undefined,
			undefined,
		),
	];
}

/**
 * Run one concrete test (a plain test, or one row of a dataset) through its
 * retry loop and record the result. `title`/`fullName` are already resolved
 * (interpolated for datasets); `dataset`/`row` are set for a dataset row.
 */
async function runOneTest(
	node: TestNode,
	title: string,
	fullName: string,
	ctx: RunCtx,
	dataset: readonly unknown[] | undefined,
	row: unknown,
	datasetNode: EmittedDataset | undefined,
): Promise<TestResult> {
	const before = collectHookChain(node.parent, "beforeEach");
	const after = collectHookChain(node.parent, "afterEach");
	// Resolution order: per-test override → nearest group `each.timeout`/`retry`
	// → run-wide default.
	const perTestTimeout =
		node.timeoutMs ?? inheritedEach(node, "eachTimeout") ?? ctx.timeoutMs;
	const perTestRetries =
		node.retries ?? inheritedEach(node, "eachRetries") ?? ctx.retries;
	const attempts = 1 + Math.max(0, perTestRetries);
	const start = Date.now();

	// Japa announces the test ONCE, before the first attempt; the retry loop
	// lives inside the start/end pair and only the final attempt is reported.
	const startNode = buildTestStartNode(node, title, ctx, datasetNode, {
		isTodo: false,
		isSkipped: false,
	});
	emitter.emit("test:start", startNode);

	// Retry loop: each attempt runs the FULL cycle (beforeEach + body +
	// afterEach) inside its own per-test frame so cleanups / outcome hooks /
	// assertion counters reset between attempts. Passes on the first success.
	let last!: TestResult;
	// 1-based number of the attempt that produced `last` (Japa counts the first
	// run as attempt 1), and only reported when the test opted into retries.
	let attemptNumber = 1;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		attemptNumber = attempt + 1;
		last = await withTestContext<TestResult>(() =>
			runAttempt(
				node,
				title,
				fullName,
				before,
				after,
				perTestTimeout,
				perTestRetries,
				start,
				dataset,
				row,
				testMeta(node, ctx),
			),
		);
		if (last.status === "pass") break;
	}
	ctx.flatTests.push(last);
	if (ctx.bail && last.status === "fail") ctx.bailed = true;
	emitter.emit("test:end", {
		...startNode,
		retryAttempt: perTestRetries > 0 ? attemptNumber : undefined,
		duration: last.durationMs,
		hasError: last.status === "fail",
		errors: toEmittedErrors(last.error, last.errorPhase ?? "test"),
	});
	return last;
}

function noop(): void {}

/** Narrow an unknown value to a thenable without a cast. */
function isThenable(v: unknown): v is PromiseLike<unknown> {
	return (
		v !== null &&
		(typeof v === "object" || typeof v === "function") &&
		typeof Reflect.get(v, "then") === "function"
	);
}

/** Nearest ancestor group's `each.timeout`/`each.retry` default for a test. */
function inheritedEach(
	node: TestNode,
	key: "eachTimeout" | "eachRetries",
): number | undefined {
	for (
		let suite: SuiteNode | undefined = node.parent;
		suite !== undefined;
		suite = suite.parent
	) {
		const value = suite[key];
		if (value !== undefined) return value;
	}
	return undefined;
}

/** Run one full attempt of a test inside the active per-test frame. */
async function runAttempt(
	node: TestNode,
	title: string,
	fullName: string,
	before: Hook["fn"][],
	after: Hook["fn"][],
	timeoutMs: number,
	retries: number,
	start: number,
	dataset: readonly unknown[] | undefined,
	row: unknown,
	meta: Record<string, unknown>,
): Promise<TestResult> {
	// A re-armable body timeout so `ctx.test.resetTimeout()` can push the deadline.
	const timeoutCtl = makeTimeoutController(timeoutMs, `test "${fullName}"`);

	// The running test's instance — injected as `ctx.test`, passed to the test
	// hooks (Japa parity), and threaded into the frame so cleanups receive it.
	const testInstance: TestInstance = {
		title,
		fullName,
		options: {
			title,
			timeout: timeoutMs,
			retries,
			tags: node.tags ?? [],
			isTodo: false,
			meta,
		},
		dataset: dataset ?? node.dataset,
		isPinned: node.pinned === true,
		resetTimeout: (ms?: number) => timeoutCtl.reset(ms),
		cleanup: (fn) => {
			registerTestCleanup(fn);
		},
	};
	setFrameTest(testInstance);

	// Build the injected context BEFORE the `beforeEach` chain so hooks can reach
	// it as `$test.context` (Japa parity) — the SAME context flows to the body.
	// Built inside the per-test frame so `ctx.cleanup` / getters bind here.
	const context = buildTestContext(testInstance);
	testInstance.context = context;

	const beforeErr = await runHooks(before, true, testInstance);
	if (beforeErr) {
		const afterErrBE = await runHooks(after, false, testInstance);
		await drainTestOutcomeHooks(true);
		return {
			name: title,
			fullName,
			status: "fail",
			durationMs: Date.now() - start,
			error: combineErrors(beforeErr, afterErrBE),
			errorPhase: "setup",
		};
	}

	let testErr: SerializedError | undefined;
	// Which phase produced `testErr` — surfaced on `test:end` (Japa parity).
	let errorPhase: ErrorPhase | undefined;

	// Per-test setup hooks (`test.setup`) run after the group `each.setup` chain,
	// just before the body. A failing setup fails the test without running it.
	const setupErr = await runHooks(node.setups ?? [], true, testInstance);
	if (setupErr) {
		testErr = setupErr;
		errorPhase = "setup";
	} else {
		try {
			// `done` callback (Japa `waitForDone`): the test completes when the
			// body calls done()/done(error). Built even when unused (harmless).
			let doneResolve: () => void = noop;
			let doneReject: (error: unknown) => void = noop;
			const donePromise = new Promise<void>((resolve, reject) => {
				doneResolve = resolve;
				doneReject = reject;
			});
			let doneCalled = false;
			const done: DoneFn = (error?: unknown) => {
				if (doneCalled) return;
				doneCalled = true;
				if (error !== undefined) doneReject(error);
				else doneResolve();
			};

			// A dataset test runs its `datasetBody(ctx, row)`; a plain test its
			// `fn(ctx, done)`.
			const result =
				node.datasetFn !== undefined
					? node.datasetBody?.(context, row)
					: node.fn?.(context, done);

			if (node.waitForDone) {
				// Complete on done(); a body rejection still fails fast, but a body
				// that merely RESOLVES does not complete the test (it must call done).
				const body = isThenable(result) ? result : Promise.resolve();
				const bodyRejectsOnly = body.then(
					() => new Promise<void>(noop),
					(err) => {
						throw err;
					},
				);
				await timeoutCtl.race(Promise.race([donePromise, bodyRejectsOnly]));
			} else if (isThenable(result)) {
				await timeoutCtl.race(result);
			}
		} catch (err) {
			testErr = serializeError(err);
			errorPhase = "test";
		}

		// `test.fails()` inverts the body outcome: a throw is success, a clean
		// run is a failure. Applied before assertion-count checks. Only when the
		// body actually ran (a setup error is a hard failure, not an expected one).
		if (node.failing) {
			testErr = testErr
				? undefined
				: {
						name: "AssertionError",
						message: `test "${fullName}" was expected to fail (test.fails) but passed`,
					};
			errorPhase = testErr === undefined ? undefined : "test";
		}

		// Assertion-count enforcement (`expect.assertions(n)` / `hasAssertions()`).
		if (!testErr) {
			testErr = checkAssertionCount(fullName);
			if (testErr !== undefined) errorPhase = "test";
		}
	}

	// Per-test teardown hooks (`test.teardown`) run before the group `each.teardown`.
	const teardownErr = await runHooks(node.teardowns ?? [], false, testInstance);
	const afterErr = await runHooks(after, false, testInstance);
	const finalErr = combineErrors(combineErrors(testErr, teardownErr), afterErr);
	// Record the outcome BEFORE the frame's cleanup drain (finally) fires, so
	// `ctx.cleanup((hasError, test) => …)` sees the right `hasError`.
	setFrameOutcome(finalErr !== undefined);
	await drainTestOutcomeHooks(finalErr !== undefined);
	return {
		name: title,
		fullName,
		status: finalErr ? "fail" : "pass",
		durationMs: Date.now() - start,
		error: finalErr,
		// A failure with no recorded phase came from the teardown chain.
		errorPhase: finalErr === undefined ? undefined : (errorPhase ?? "teardown"),
	};
}

/** Verify `expect.assertions(n)` / `hasAssertions()` for the active frame. */
function checkAssertionCount(fullName: string): SerializedError | undefined {
	const state = getAssertionState();
	if (!state) return undefined;
	if (state.expected !== undefined && state.count !== state.expected) {
		return {
			name: "AssertionError",
			message: `test "${fullName}" expected ${state.expected} assertion(s) but ran ${state.count}`,
		};
	}
	if (state.hasAssertions && state.count === 0) {
		return {
			name: "AssertionError",
			message: `test "${fullName}" expected at least one assertion but ran none`,
		};
	}
	return undefined;
}

/**
 * Recursively mark every descendant test as failed due to an ancestor
 * hook error. Ensures `flatTests` is complete and reporters can navigate
 * the whole tree.
 */
function attributeHookFailure(
	node: SuiteNode,
	parentFullName: string,
	err: SerializedError,
	ctx: RunCtx,
): Array<SuiteResult | TestResult> {
	const children: Array<SuiteResult | TestResult> = [];
	const fullName = joinName(parentFullName, node.name);
	for (const child of node.children) {
		if (child.kind === "test") {
			const r: TestResult = {
				name: child.name,
				fullName: joinName(fullName, child.name),
				status: child.mode === "todo" ? "todo" : "fail",
				durationMs: 0,
				error: child.mode === "todo" ? undefined : err,
				errorPhase: child.mode === "todo" ? undefined : "setup",
			};
			children.push(r);
			ctx.flatTests.push(r);
			emitTestResult(child, r, ctx);
		} else {
			const innerChildren = attributeHookFailure(child, fullName, err, ctx);
			children.push({
				name: child.name,
				fullName: joinName(fullName, child.name),
				children: innerChildren,
				status: "fail",
				durationMs: 0,
				hookErrors: [],
			});
		}
	}
	return children;
}

async function runSuite(
	node: SuiteNode,
	parentFullName: string,
	ctx: RunCtx,
): Promise<SuiteResult> {
	const fullName = joinName(parentFullName, node.name);
	const start = Date.now();

	// `.skip` takes precedence over descendant `.only` — matches Vitest.
	// `.todo` likewise.
	const skipEntire =
		node.mode === "skip" ||
		node.mode === "todo" ||
		(ctx.onlyActive && !pathLeadsToOnly(node));
	if (skipEntire) return runSkippedSuite(node, fullName, ctx);

	const hookErrors: SerializedError[] = [];
	// The group's instance (Japa parity) passed to group hooks, and cleanups a
	// `group.setup()` returns — run in the afterAll phase with `(hadError, group)`.
	// For a `test.group()` this is the SAME object the body received and the call
	// returned (`self === group`); a plain `describe` suite has no group handle,
	// so fall back to a bare identity object.
	const group: GroupInstance = node.groupInstance ?? {
		title: node.name,
		fullName,
	};
	const groupCleanups: CleanupFn[] = [];

	// A group with no runnable test announces nothing — Japa's refiner drops it
	// before `Group.exec()` runs, so a reporter never sees it.
	const groupFiltered = !suiteHasRunnableTest(node, ctx);
	if (!groupFiltered) {
		emitter.emit("group:start", {
			title: node.name,
			meta: { suite: ctx.suite, fileName: ctx.file },
		});
	}

	// beforeAll: when one throws, every descendant test inherits the failure
	// and the children list is replaced with those attributed results.
	const attributed = await runBeforeAllHooks(
		node,
		parentFullName,
		ctx,
		hookErrors,
		group,
		groupCleanups,
	);
	const beforeAllFailed = attributed !== null;
	const children: Array<SuiteResult | TestResult> = attributed ?? [];

	// `--bail-layer=group` confines a bail to the group it happened in, so the
	// next group starts clean. The wider layers leave the flag set.
	const bailedOnEntry = ctx.bailed;

	if (!beforeAllFailed) {
		for (const child of node.children) {
			if (child.kind === "test") {
				// A dataset test expands to one result per row (Japa parity).
				for (const r of await runTest(child, fullName, ctx)) children.push(r);
			} else {
				children.push(await runSuite(child, fullName, ctx));
			}
		}
	}

	if (ctx.bailLayer === "group") ctx.bailed = bailedOnEntry;

	const groupHadError =
		hookErrors.length > 0 || children.some((c) => c.status === "fail");
	// Errors recorded so far come from `beforeAll`; anything appended by
	// `runAfterAllHooks` below belongs to the teardown phase.
	const setupErrorCount = hookErrors.length;
	await runAfterAllHooks(node, hookErrors, group, groupCleanups, groupHadError);

	if (!groupFiltered) {
		emitter.emit("group:end", {
			title: node.name,
			meta: { suite: ctx.suite, fileName: ctx.file },
			// True when ANYTHING under the group failed — a hook or a test — which
			// is what Japa's GroupRunner reports.
			hasError: groupHadError || hookErrors.length > 0,
			// The group's own `errors` are its hook failures only; a test's failure
			// travels on that test's `test:end` (Japa parity).
			errors: hookErrors.map(
				(error, i): EmittedError => ({
					phase: i < setupErrorCount ? "setup" : "teardown",
					error,
				}),
			),
		});
	}

	// Surface afterAll failures as a synthetic test so `totals.fail` reflects
	// them and CI exits nonzero.
	if (!beforeAllFailed && hookErrors.length > 0) {
		const synthetic: TestResult = {
			name: "afterAll",
			fullName: joinName(fullName, "afterAll"),
			status: "fail",
			durationMs: 0,
			error: hookErrors[hookErrors.length - 1],
		};
		children.push(synthetic);
		ctx.flatTests.push(synthetic);
	}

	return {
		name: node.name,
		fullName,
		children,
		status: suiteStatus(children, hookErrors),
		durationMs: Date.now() - start,
		hookErrors,
	};
}

/** Build skip/todo results for an entirely-skipped suite (no hooks run). */
async function runSkippedSuite(
	node: SuiteNode,
	fullName: string,
	ctx: RunCtx,
): Promise<SuiteResult> {
	const children: Array<SuiteResult | TestResult> = [];
	// The group still announces itself — its tests are skipped, not filtered
	// out — so a reporter can nest them under it.
	emitter.emit("group:start", {
		title: node.name,
		meta: { suite: ctx.suite, fileName: ctx.file },
	});
	for (const child of node.children) {
		if (child.kind === "test") {
			const r: TestResult = {
				name: child.name,
				fullName: joinName(fullName, child.name),
				status: child.mode === "todo" ? "todo" : "skip",
				durationMs: 0,
			};
			children.push(r);
			ctx.flatTests.push(r);
			emitTestResult(child, r, ctx);
		} else {
			children.push(await runSuiteSkip(child, fullName, ctx));
		}
	}
	emitter.emit("group:end", {
		title: node.name,
		meta: { suite: ctx.suite, fileName: ctx.file },
		hasError: false,
		errors: [],
	});
	return {
		name: node.name,
		fullName,
		children,
		status: "skip",
		durationMs: 0,
		hookErrors: [],
	};
}

/**
 * Run the suite's `beforeAll` hooks. On the first failure, push the serialized
 * error to `hookErrors` and return the descendant tests attributed with that
 * failure; return `null` when all hooks pass.
 */
async function runBeforeAllHooks(
	node: SuiteNode,
	parentFullName: string,
	ctx: RunCtx,
	hookErrors: SerializedError[],
	group: GroupInstance,
	groupCleanups: CleanupFn[],
): Promise<Array<SuiteResult | TestResult> | null> {
	for (const h of node.hooks) {
		if (h.type !== "beforeAll") continue;
		try {
			// Japa parity: group hooks receive the Group instance; a returned
			// function becomes a group-scoped cleanup (run in the afterAll phase).
			const ret = await h.fn(group);
			if (typeof ret === "function") groupCleanups.push(ret);
		} catch (err) {
			const serialized = serializeError(err);
			hookErrors.push(serialized);
			// Attribute the error to every descendant test (direct AND nested).
			return attributeHookFailure(node, parentFullName, serialized, ctx);
		}
	}
	return null;
}

/**
 * Run `afterAll` hooks unconditionally so partial setup from a failed beforeAll
 * can be released. Errors are captured into `hookErrors`, not thrown.
 */
async function runAfterAllHooks(
	node: SuiteNode,
	hookErrors: SerializedError[],
	group: GroupInstance,
	groupCleanups: CleanupFn[],
	hadError: boolean,
): Promise<void> {
	// Group-scoped cleanups (returned by `group.setup()`) run first, in reverse
	// insertion order, receiving `(hadError, group)` — Japa lifecycle parity.
	for (let i = groupCleanups.length - 1; i >= 0; i -= 1) {
		try {
			await groupCleanups[i](hadError, group);
		} catch (err) {
			hookErrors.push(serializeError(err));
		}
	}
	for (const h of node.hooks) {
		if (h.type !== "afterAll") continue;
		try {
			await h.fn(group);
		} catch (err) {
			hookErrors.push(serializeError(err));
		}
	}
}

/** Roll a suite's child statuses + hook errors up into its own status. */
function suiteStatus(
	children: Array<SuiteResult | TestResult>,
	hookErrors: SerializedError[],
): "fail" | "skip" | "pass" {
	if (hookErrors.length > 0 || children.some((c) => c.status === "fail")) {
		return "fail";
	}
	if (children.length > 0 && children.every((c) => c.status === "skip")) {
		return "skip";
	}
	return "pass";
}

async function runSuiteSkip(
	node: SuiteNode,
	parentFullName: string,
	ctx: RunCtx,
): Promise<SuiteResult> {
	const fullName = joinName(parentFullName, node.name);
	const children: Array<SuiteResult | TestResult> = [];
	emitter.emit("group:start", {
		title: node.name,
		meta: { suite: ctx.suite, fileName: ctx.file },
	});
	for (const child of node.children) {
		if (child.kind === "test") {
			const r: TestResult = {
				name: child.name,
				fullName: joinName(fullName, child.name),
				status: child.mode === "todo" ? "todo" : "skip",
				durationMs: 0,
			};
			children.push(r);
			ctx.flatTests.push(r);
			emitTestResult(child, r, ctx);
		} else {
			children.push(await runSuiteSkip(child, fullName, ctx));
		}
	}
	emitter.emit("group:end", {
		title: node.name,
		meta: { suite: ctx.suite, fileName: ctx.file },
		hasError: false,
		errors: [],
	});
	return {
		name: node.name,
		fullName,
		children,
		status: "skip",
		durationMs: 0,
		hookErrors: [],
	};
}

export async function executeRoot(
	root: SuiteNode,
	file: string,
	options: ExecuteOptions = {},
): Promise<FileResult> {
	const start = Date.now();
	const onlyActive = root.children.some(hasOnly);
	const ctx: RunCtx = {
		onlyActive,
		flatTests: [],
		timeoutMs: options.timeoutMs ?? 0,
		retries: options.retries ?? 0,
		grep: compileGrep(options.grep),
		tagFilter: compileTagFilter(options.tags, options.matchAll === true),
		testTitles:
			options.tests && options.tests.length > 0
				? new Set(options.tests)
				: undefined,
		groupTitles:
			options.groups && options.groups.length > 0
				? new Set(options.groups)
				: undefined,
		file,
		suite: { name: options.suite ?? "default" },
		bail: options.bail === true,
		// Japa spells the runner layer as an empty string on its CLI.
		bailLayer:
			options.bailLayer === undefined || options.bailLayer === ""
				? "runner"
				: options.bailLayer,
		bailed: false,
	};
	const suites: SuiteResult[] = [];

	// Japa's runner/suite frame. Helix has no named-suite layer (one process per
	// file), so the FILE is the suite — `suite:start` carries its name.
	// Japa skips a suite whose every test is filtered out — the suite never
	// announces itself, though the runner still opens and closes the run.
	const suiteRunnable = suiteHasRunnableTest(root, ctx);
	emitter.emit("runner:start", {});
	if (suiteRunnable) emitter.emit("suite:start", { name: ctx.suite.name });

	// Root-level beforeAll: run once before anything, root-level afterAll:
	// once after everything. Errors attribute to a synthetic test entry so
	// they show up in totals.
	const rootHookErrors: SerializedError[] = [];
	let rootBeforeAllFailed = false;
	for (const h of root.hooks) {
		if (h.type !== "beforeAll") continue;
		try {
			await h.fn();
		} catch (err) {
			const serialized = serializeError(err);
			rootHookErrors.push(serialized);
			const synthetic: TestResult = {
				name: "beforeAll",
				fullName: "beforeAll",
				status: "fail",
				durationMs: 0,
				error: serialized,
			};
			ctx.flatTests.push(synthetic);
			rootBeforeAllFailed = true;
			break;
		}
	}

	if (!rootBeforeAllFailed) {
		for (const child of root.children) {
			if (child.kind === "test") {
				// A dataset test expands to one result per row (Japa parity).
				const trs = await runTest(child, "", ctx);
				suites.push({
					name: "",
					fullName: "",
					children: trs,
					status: suiteStatus(trs, []),
					durationMs: trs.reduce((sum, t) => sum + t.durationMs, 0),
					hookErrors: [],
				});
			} else {
				suites.push(await runSuite(child, "", ctx));
			}
		}
	}

	// Root afterAll — always try.
	for (const h of root.hooks) {
		if (h.type !== "afterAll") continue;
		try {
			await h.fn();
		} catch (err) {
			const serialized = serializeError(err);
			rootHookErrors.push(serialized);
			const synthetic: TestResult = {
				name: "afterAll",
				fullName: "afterAll",
				status: "fail",
				durationMs: 0,
				error: serialized,
			};
			ctx.flatTests.push(synthetic);
		}
	}

	const totals = { pass: 0, fail: 0, skip: 0, todo: 0 };
	for (const t of ctx.flatTests) totals[t.status] += 1;

	const hasError = totals.fail > 0;
	if (suiteRunnable) {
		emitter.emit("suite:end", {
			name: ctx.suite.name,
			hasError,
			errors: rootHookErrors.map(
				(error): EmittedError => ({ phase: "setup", error }),
			),
		});
	}
	emitter.emit("runner:end", { hasError });

	return {
		file,
		suites,
		tests: ctx.flatTests,
		totals,
		durationMs: Date.now() - start,
	};
}
