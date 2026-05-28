/**
 * Execution engine — walks the suite tree collected by `suite.ts`,
 * runs each test with its inherited hook chain, and produces a structured
 * `FileResult` for the orchestrator.
 *
 * `.only` handling: if any test or suite is marked `only` anywhere in the
 * tree, non-`only` paths are downgraded to `skip` before execution.
 */

import { AssertionError } from "./assertion-error.js";
import type { SuiteNode, TestFn, TestNode } from "./suite.js";
import { withTestContext } from "./test-context.js";

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
	 * awaited further.
	 */
	timeoutMs?: number;
}

function isTestResult(x: SuiteResult | TestResult): x is TestResult {
	return (x as TestResult).status !== undefined && !("children" in x);
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
): TestFn[] {
	// beforeEach: outermost first; afterEach: innermost first.
	const suites: SuiteNode[] = [];
	let cursor: SuiteNode | undefined = leaf;
	while (cursor) {
		suites.push(cursor);
		cursor = cursor.parent;
	}
	const ordered = type === "beforeEach" ? [...suites].reverse() : suites;
	const chain: TestFn[] = [];
	for (const s of ordered) {
		for (const h of s.hooks) {
			if (h.type === type) chain.push(h.fn);
		}
	}
	return chain;
}

async function runHooks(hooks: TestFn[]): Promise<SerializedError | undefined> {
	for (const h of hooks) {
		try {
			await h();
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
	if (node.mode === "skip" || (ctx.onlyActive && !pathLeadsToOnly(node))) {
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
	const start = Date.now();
	// Wrap the whole cycle (beforeEach + body + afterEach) in a per-test
	// frame so test-scoped cleanups (e.g. container overrides registered
	// via `helix.override`) drain at the right time. Frame closes AFTER
	// afterEach so user teardown can still observe test-scoped state.
	const r = await withTestContext<TestResult>(async () => {
		const beforeErr = await runHooks(before);
		if (beforeErr) {
			const afterErrBE = await runHooks(after);
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
			if (
				result &&
				typeof (result as PromiseLike<unknown>).then === "function"
			) {
				await withTimeout(
					result as Promise<unknown>,
					ctx.timeoutMs,
					`test "${fullName}"`,
				);
			}
		} catch (err) {
			testErr = serializeError(err);
		}
		const afterErr = await runHooks(after);
		const finalErr = combineErrors(testErr, afterErr);
		return {
			name: node.name,
			fullName,
			status: finalErr ? "fail" : "pass",
			durationMs: Date.now() - start,
			error: finalErr,
		};
	});
	ctx.flatTests.push(r);
	return r;
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
	const hookErrors: SerializedError[] = [];
	let children: Array<SuiteResult | TestResult> = [];

	// `.skip` takes precedence over descendant `.only` — matches Vitest.
	// `.todo` likewise.
	const skipEntire =
		node.mode === "skip" ||
		node.mode === "todo" ||
		(ctx.onlyActive && !pathLeadsToOnly(node));

	if (skipEntire) {
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

	// beforeAll.
	let beforeAllFailed = false;
	for (const h of node.hooks) {
		if (h.type !== "beforeAll") continue;
		try {
			await h.fn();
		} catch (err) {
			const serialized = serializeError(err);
			hookErrors.push(serialized);
			// Attribute the error to every descendant test (direct AND nested).
			children = attributeHookFailure(node, parentFullName, serialized, ctx);
			beforeAllFailed = true;
			break;
		}
	}

	if (!beforeAllFailed) {
		for (const child of node.children) {
			if (child.kind === "test") {
				children.push(await runTest(child, fullName, ctx));
			} else {
				children.push(await runSuite(child, fullName, ctx));
			}
		}
	}

	// afterAll — run unconditionally so partial setup from a failed beforeAll
	// can be released. Errors are captured + surface as a test failure.
	for (const h of node.hooks) {
		if (h.type !== "afterAll") continue;
		try {
			await h.fn();
		} catch (err) {
			hookErrors.push(serializeError(err));
		}
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

	const anyFail =
		hookErrors.length > 0 ||
		children.some((c) =>
			isTestResult(c) ? c.status === "fail" : c.status === "fail",
		);
	const allSkip =
		children.length > 0 &&
		children.every((c) =>
			isTestResult(c) ? c.status === "skip" : c.status === "skip",
		);

	return {
		name: node.name,
		fullName,
		children,
		status: anyFail ? "fail" : allSkip ? "skip" : "pass",
		durationMs: Date.now() - start,
		hookErrors,
	};
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
