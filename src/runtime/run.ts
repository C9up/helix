/**
 * Execution engine — walks the suite tree collected by `suite.ts`,
 * runs each test with its inherited hook chain, and produces a structured
 * `FileResult` for the orchestrator.
 *
 * `.only` handling: if any test or suite is marked `only` anywhere in the
 * tree, non-`only` paths are downgraded to `skip` before execution.
 */

import { AssertionError } from "./assertion-error.js";
import type { Hook, SuiteNode, TestNode } from "./suite.js";
import {
	drainTestOutcomeHooks,
	getAssertionState,
	registerTestCleanup,
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
	 * Tag filter expressions (`@fast`, `!@slow`). A test runs when it carries
	 * every required tag and none of the excluded ones. Mirrors `--tags`.
	 */
	tags?: string[];
}

/** Compiled tag filter: a test must have all `required` and none `excluded`. */
interface TagFilter {
	required: string[];
	excluded: string[];
}

function compileTagFilter(tags: string[] | undefined): TagFilter | undefined {
	if (!tags || tags.length === 0) return undefined;
	const required: string[] = [];
	const excluded: string[] = [];
	for (const raw of tags) {
		const t = raw.trim();
		if (!t) continue;
		if (t.startsWith("!")) excluded.push(t.slice(1));
		else required.push(t);
	}
	if (required.length === 0 && excluded.length === 0) return undefined;
	return { required, excluded };
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
	for (const r of filter.required) if (!have.has(r)) return false;
	for (const e of filter.excluded) if (have.has(e)) return false;
	return true;
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
): Promise<SerializedError | undefined> {
	for (const h of hooks) {
		try {
			const ret = await h();
			// A `beforeEach` returning a function registers it as a test-scoped
			// cleanup (Vitest/Japa parity). Ignored for `afterEach`.
			if (registerCleanups && typeof ret === "function") {
				registerTestCleanup(ret as () => void | Promise<void>);
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

async function withTimeout<T>(
	p: Promise<T> | T,
	ms: number,
	label: string,
): Promise<T> {
	if (ms <= 0) return await p;
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<T>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`${label} exceeded ${ms}ms timeout`));
		}, ms);
		// Don't keep the event loop alive just for this watchdog.
		timer.unref?.();
	});
	try {
		return await Promise.race([Promise.resolve(p), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

interface RunCtx {
	onlyActive: boolean;
	flatTests: TestResult[];
	timeoutMs: number;
	retries: number;
	grep: RegExp | undefined;
	tagFilter: TagFilter | undefined;
}

async function runTest(
	node: TestNode,
	parentFullName: string,
	ctx: RunCtx,
): Promise<TestResult> {
	const fullName = joinName(parentFullName, node.name);
	if (node.mode === "todo") {
		const r: TestResult = {
			name: node.name,
			fullName,
			status: "todo",
			durationMs: 0,
		};
		ctx.flatTests.push(r);
		return r;
	}
	const filteredOut =
		(ctx.grep !== undefined && !ctx.grep.test(fullName)) ||
		(ctx.tagFilter !== undefined && !tagMatches(node, ctx.tagFilter));
	if (
		node.mode === "skip" ||
		filteredOut ||
		(ctx.onlyActive && !pathLeadsToOnly(node))
	) {
		const r: TestResult = {
			name: node.name,
			fullName,
			status: "skip",
			durationMs: 0,
		};
		ctx.flatTests.push(r);
		return r;
	}

	const before = collectHookChain(node.parent, "beforeEach");
	const after = collectHookChain(node.parent, "afterEach");
	const perTestTimeout = node.timeoutMs ?? ctx.timeoutMs;
	const attempts = 1 + Math.max(0, node.retries ?? ctx.retries);
	const start = Date.now();

	// Retry loop: each attempt runs the FULL cycle (beforeEach + body +
	// afterEach) inside its own per-test frame so cleanups / outcome hooks /
	// assertion counters reset between attempts. Passes on the first success.
	let last!: TestResult;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		last = await withTestContext<TestResult>(() =>
			runAttempt(node, fullName, before, after, perTestTimeout, start),
		);
		if (last.status === "pass") break;
	}
	ctx.flatTests.push(last);
	return last;
}

/** Run one full attempt of a test inside the active per-test frame. */
async function runAttempt(
	node: TestNode,
	fullName: string,
	before: Hook["fn"][],
	after: Hook["fn"][],
	timeoutMs: number,
	start: number,
): Promise<TestResult> {
	const beforeErr = await runHooks(before, true);
	if (beforeErr) {
		const afterErrBE = await runHooks(after);
		await drainTestOutcomeHooks(true);
		return {
			name: node.name,
			fullName,
			status: "fail",
			durationMs: Date.now() - start,
			error: combineErrors(beforeErr, afterErrBE),
		};
	}

	let testErr: SerializedError | undefined;
	try {
		const result = node.fn?.();
		if (result && typeof (result as PromiseLike<unknown>).then === "function") {
			await withTimeout(
				result as Promise<unknown>,
				timeoutMs,
				`test "${fullName}"`,
			);
		}
	} catch (err) {
		testErr = serializeError(err);
	}

	// `test.fails()` inverts the body outcome: a throw is success, a clean
	// run is a failure. Applied before assertion-count checks.
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

	const afterErr = await runHooks(after);
	const finalErr = combineErrors(testErr, afterErr);
	await drainTestOutcomeHooks(finalErr !== undefined);
	return {
		name: node.name,
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

	// beforeAll: when one throws, every descendant test inherits the failure
	// and the children list is replaced with those attributed results.
	const attributed = await runBeforeAllHooks(
		node,
		parentFullName,
		ctx,
		hookErrors,
	);
	const beforeAllFailed = attributed !== null;
	const children: Array<SuiteResult | TestResult> = attributed ?? [];

	if (!beforeAllFailed) {
		for (const child of node.children) {
			children.push(
				child.kind === "test"
					? await runTest(child, fullName, ctx)
					: await runSuite(child, fullName, ctx),
			);
		}
	}

	await runAfterAllHooks(node, hookErrors);

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
): Promise<Array<SuiteResult | TestResult> | null> {
	for (const h of node.hooks) {
		if (h.type !== "beforeAll") continue;
		try {
			await h.fn();
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
): Promise<void> {
	for (const h of node.hooks) {
		if (h.type !== "afterAll") continue;
		try {
			await h.fn();
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
		tagFilter: compileTagFilter(options.tags),
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
				const tr = await runTest(child, "", ctx);
				suites.push({
					name: "",
					fullName: "",
					children: [tr],
					status:
						tr.status === "fail"
							? "fail"
							: tr.status === "pass"
								? "pass"
								: "skip",
					durationMs: tr.durationMs,
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
