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
}

async function runTest(
	node: TestNode,
	parentFullName: string,
	ctx: RunCtx,
): Promise<TestResult[]> {
	const baseFullName = joinName(parentFullName, node.name);

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
			};
			ctx.flatTests.push(r);
			return [r];
		}
	}

	// Node-level gates that apply to the whole test (and every dataset row).
	// `grep` is applied per-name below (per row for datasets).
	const nodeSkipped =
		node.mode === "skip" ||
		deferredSkip ||
		(ctx.tagFilter !== undefined && !tagMatches(node, ctx.tagFilter)) ||
		(ctx.testTitles !== undefined && !ctx.testTitles.has(node.name)) ||
		(ctx.groupTitles !== undefined && !isInGroups(node, ctx.groupTitles)) ||
		(ctx.onlyActive && !pathLeadsToOnly(node));

	const makeSkip = (name: string, fullName: string): TestResult => {
		const r: TestResult = { name, fullName, status: "skip", durationMs: 0 };
		ctx.flatTests.push(r);
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
			};
			ctx.flatTests.push(r);
			return [r];
		}
		const results: TestResult[] = [];
		for (let i = 0; i < rows.length; i += 1) {
			const title = interpolateDatasetTitle(node.name, rows[i], i, rows.length);
			const fullName = joinName(parentFullName, title);
			if (nodeSkipped || grepOut(fullName)) {
				results.push(makeSkip(title, fullName));
				continue;
			}
			results.push(await runOneTest(node, title, fullName, ctx, rows, rows[i]));
		}
		return results;
	}

	// Single (non-dataset) test.
	if (nodeSkipped || grepOut(baseFullName)) {
		return [makeSkip(node.name, baseFullName)];
	}
	return [
		await runOneTest(node, node.name, baseFullName, ctx, undefined, undefined),
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

	// Retry loop: each attempt runs the FULL cycle (beforeEach + body +
	// afterEach) inside its own per-test frame so cleanups / outcome hooks /
	// assertion counters reset between attempts. Passes on the first success.
	let last!: TestResult;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
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
				ctx.file,
			),
		);
		if (last.status === "pass") break;
	}
	ctx.flatTests.push(last);
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
	fileName: string,
): Promise<TestResult> {
	// A re-armable body timeout so `ctx.test.resetTimeout()` can push the deadline.
	const timeoutCtl = makeTimeoutController(timeoutMs, `test "${fullName}"`);

	// Nearest enclosing `test.group(...)` instance (Japa `options.meta.group` — an
	// object, not a name). `meta.suite` is intentionally absent: helix has no
	// named-suite layer (process-per-file), so there is no Suite object to expose.
	let groupInstance: Group | undefined;
	for (
		let s: SuiteNode | undefined = node.parent;
		s !== undefined;
		s = s.parent
	) {
		if (s.isGroup) {
			groupInstance = s.groupInstance;
			break;
		}
	}

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
			meta: { fileName, group: groupInstance },
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
		};
	}

	let testErr: SerializedError | undefined;

	// Per-test setup hooks (`test.setup`) run after the group `each.setup` chain,
	// just before the body. A failing setup fails the test without running it.
	const setupErr = await runHooks(node.setups ?? [], true, testInstance);
	if (setupErr) {
		testErr = setupErr;
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
		}

		// Assertion-count enforcement (`expect.assertions(n)` / `hasAssertions()`).
		if (!testErr) {
			testErr = checkAssertionCount(fullName);
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
			};
			children.push(r);
			ctx.flatTests.push(r);
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

	const groupHadError =
		hookErrors.length > 0 || children.some((c) => c.status === "fail");
	await runAfterAllHooks(node, hookErrors, group, groupCleanups, groupHadError);

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
		} else {
			children.push(await runSuiteSkip(child, fullName, ctx));
		}
	}
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
		} else {
			children.push(await runSuiteSkip(child, fullName, ctx));
		}
	}
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
	};
	const suites: SuiteResult[] = [];

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
	return {
		file,
		suites,
		tests: ctx.flatTests,
		totals,
		durationMs: Date.now() - start,
	};
}
