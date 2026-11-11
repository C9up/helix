/**
 * Per-test execution frame.
 *
 * Whereas `withViContext` wraps each test FILE (so spies and fake
 * timers can span tests within a file), `withTestContext` wraps each
 * INDIVIDUAL test (cycle = beforeEach + body + afterEach). It exists
 * so test-scoped resources — most notably container overrides
 * registered through `helix.override()` — get torn down between tests
 * without needing the user to wire `afterEach(restore)` by hand.
 *
 * Cleanup semantics:
 *   - reverse insertion order
 *   - one cleanup throwing must not block the others
 *   - a cleanup that throws fails its test (phase `test:cleanup`): the
 *     runner drains them through {@link drainTestCleanups} before it settles
 *     the attempt's result, so a broken restore is not inherited silently by
 *     the next test
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { TestInstance } from "./suite.js";

/**
 * A per-test teardown. Receives `(hasError, test)`: whether the
 * test failed, and the running test's instance. Both params are optional so
 * plain `() => …` cleanups stay valid.
 *
 * Returns `unknown`: the value is awaited and dropped, so a one-liner like
 * `() => log.push('done')` is not a type error for returning what `push`
 * returns.
 */
export type TestCleanup = (hasError?: boolean, test?: TestInstance) => unknown;

/** Per-test assertion bookkeeping (drives `expect.assertions`/`hasAssertions`). */
export interface AssertionState {
	/** Number of `expect(...)` matcher invocations observed this test. */
	count: number;
	/** Exact count required by `expect.assertions(n)`, if set. */
	expected: number | undefined;
	/** Whether `expect.hasAssertions()` demanded at least one assertion. */
	hasAssertions: boolean;
}

interface TestFrame {
	cleanups: TestCleanup[];
	/** `onTestFinished` callbacks — run after the test regardless of outcome. */
	onFinished: TestCleanup[];
	/** `onTestFailed` callbacks — run after the test only when it failed. */
	onFailed: TestCleanup[];
	assertions: AssertionState;
	/** The running test's instance (`ctx.test`), threaded into cleanups. */
	test: TestInstance | undefined;
	/** The injected context — what a helix `Test.executed` hook reads as `test.context`. */
	context: unknown;
	/** Whether the test body/hooks errored — passed to cleanups as `hasError`. */
	hadError: boolean;
	/** `.resolves` / `.rejects` assertions started during the test. */
	asyncAssertions: AsyncAssertion[];
}

/** One `.resolves` / `.rejects` assertion, and whether the test awaited it. */
interface AsyncAssertion {
	/** Set once the test attached a handler (`await`, `.then`, `.catch`, `.finally`). */
	observed: boolean;
	/** Settles with the failure, or `undefined` when the assertion held. */
	outcome: Promise<{ error: unknown } | undefined>;
}

const storage = new AsyncLocalStorage<TestFrame>();

export async function withTestContext<T>(body: () => Promise<T>): Promise<T> {
	const frame: TestFrame = {
		cleanups: [],
		onFinished: [],
		onFailed: [],
		assertions: { count: 0, expected: undefined, hasAssertions: false },
		test: undefined,
		context: undefined,
		hadError: false,
		asyncAssertions: [],
	};
	try {
		return await storage.run(frame, body);
	} finally {
		// Only reached with cleanups left when `body` did not drain them — it
		// threw before settling a result. There is no result to fail then, so
		// what a cleanup throws is reported where it can still be seen.
		for (const err of await runCleanups(frame)) {
			console.error("[helix] test cleanup failed:", err);
		}
	}
}

/**
 * Run the frame's cleanups, last registered first, and return what they
 * threw. Each runs once: a cleanup registered while another runs is drained
 * too, and the list is empty afterwards.
 */
async function runCleanups(frame: TestFrame): Promise<unknown[]> {
	const errors: unknown[] = [];
	while (frame.cleanups.length > 0) {
		for (const cleanup of frame.cleanups.splice(0).reverse()) {
			try {
				await cleanup(frame.hadError, frame.test);
			} catch (err) {
				errors.push(err);
			}
		}
	}
	return errors;
}

/**
 * Run the current test's cleanups (`ctx.cleanup`, a hook's returned cleanup,
 * the container and clock restores helix registers) and return what they
 * threw, for the runner to fail the test with. Empty outside a test frame.
 */
export async function drainTestCleanups(): Promise<unknown[]> {
	const frame = storage.getStore();
	if (!frame) return [];
	return runCleanups(frame);
}

/**
 * Register a cleanup function that runs at the end of the current
 * test cycle. Returns `true` when registered, `false` when called
 * outside a test frame (caller decides — usually a no-op or fallback
 * to a wider frame).
 */
export function registerTestCleanup(cleanup: TestCleanup): boolean {
	const frame = storage.getStore();
	if (!frame) return false;
	frame.cleanups.push(cleanup);
	return true;
}

export function inTestContext(): boolean {
	return storage.getStore() !== undefined;
}

/** Attach the running test's instance to the active frame (for `ctx.test` + cleanups). */
export function setFrameTest(test: TestInstance): void {
	const frame = storage.getStore();
	if (frame) frame.test = test;
}

/**
 * Read the running test's instance from the active frame — the `t` handed to a
 * helix resource macro (`test.macro((t, …) => …)`). Undefined outside a test.
 */
export function getFrameTest(): TestInstance | undefined {
	return storage.getStore()?.test;
}

/** The running test, or `undefined` outside one (`getActiveTest`). */
export function getActiveTest(): TestInstance | undefined {
	return getFrameTest();
}

/**
 * The running test, or a thrown error outside one — helix's
 * `getActiveTestOrFail`, the guard a plugin uses before touching test state.
 */
export function getActiveTestOrFail(): TestInstance {
	const test = getFrameTest();
	if (test === undefined) {
		throw new Error(
			"getActiveTestOrFail(): no test is running. Call it from inside a test body, a hook, or a resource macro.",
		);
	}
	return test;
}

/** Record whether the test errored — read by the cleanup/outcome drains. */
export function setFrameOutcome(hadError: boolean): void {
	const frame = storage.getStore();
	if (frame) frame.hadError = hadError;
}

/**
 * Register a callback to run once the current test finishes, regardless of
 * pass/fail. Mirrors Vitest's `onTestFinished`. Returns `false` when called
 * outside a test frame.
 */
export function registerOnTestFinished(cb: TestCleanup): boolean {
	const frame = storage.getStore();
	if (!frame) return false;
	frame.onFinished.push(cb);
	return true;
}

/**
 * Register a callback to run only when the current test fails. Mirrors
 * Vitest's `onTestFailed`. Returns `false` when called outside a test frame.
 */
export function registerOnTestFailed(cb: TestCleanup): boolean {
	const frame = storage.getStore();
	if (!frame) return false;
	frame.onFailed.push(cb);
	return true;
}

/**
 * Register a teardown that runs after the current test regardless of outcome.
 * Vitest-compatible public name for {@link registerOnTestFinished}.
 */
export function onTestFinished(cb: TestCleanup): void {
	registerOnTestFinished(cb);
}

/**
 * Register a callback that runs only if the current test fails.
 * Vitest-compatible public name for {@link registerOnTestFailed}.
 */
export function onTestFailed(cb: TestCleanup): void {
	registerOnTestFailed(cb);
}

/**
 * Callbacks registered for EVERY test of the run (`Test.executed`). helix
 * plugins use it to check after each test that something held — `helix's assert`
 * validates its planned-assertion count there.
 */
type ExecutedHook = (
	test: { options: unknown; context: unknown },
	hasError: boolean,
) => unknown;

const executedHooks: ExecutedHook[] = [];

/** Register a per-test hook for the whole run (`Test.executed`). */
export function registerExecutedHook(fn: ExecutedHook): void {
	executedHooks.push(fn);
}

/** Test seam: drop every registered `executed` hook. */
export function resetExecutedHooks(): void {
	executedHooks.length = 0;
}

/** Attach the injected context to the current frame. */
export function setFrameContext(context: unknown): void {
	const frame = storage.getStore();
	if (frame) frame.context = context;
}

/** What {@link drainTestOutcomeHooks} collected. */
export interface OutcomeHookErrors {
	/** What `onTestFailed` / `onTestFinished` callbacks threw, in run order. */
	callbacks: unknown[];
	/** The first thing a run-wide `Test.executed` hook threw, if any. */
	verdict: unknown;
}

/**
 * Drain the `onTestFinished`/`onTestFailed` callbacks for the current frame,
 * then the run-wide `Test.executed` hooks.
 *
 * Returns what both threw. An `executed` hook IS a verdict — `helix's assert`
 * validates `assert.plan(n)` there and throws when the count is wrong — so
 * swallowing it would let a plugin's whole reason for existing pass green. A
 * throwing `onTestFinished` / `onTestFailed` callback fails the test too: it
 * is a teardown that did not happen, and every callback still runs.
 */
export async function drainTestOutcomeHooks(
	failed: boolean,
): Promise<OutcomeHookErrors> {
	const callbacks: unknown[] = [];
	const frame = storage.getStore();
	if (!frame) return { callbacks, verdict: undefined };
	// `onTestFailed` first (diagnostics), then `onTestFinished` — both in
	// reverse insertion order to mirror Vitest teardown semantics.
	if (failed) {
		for (const onFailed of [...frame.onFailed].reverse()) {
			try {
				await onFailed(failed, frame.test);
			} catch (err) {
				callbacks.push(err);
			}
		}
	}
	for (const onFinished of [...frame.onFinished].reverse()) {
		try {
			await onFinished(failed, frame.test);
		} catch (err) {
			callbacks.push(err);
		}
	}
	// Run-wide hooks last, so a plugin checking an invariant sees the state the
	// test's own callbacks left behind. The FIRST throw is the verdict; the rest
	// still run, so one plugin's failure does not hide another's.
	let verdict: unknown;
	if (frame.test !== undefined) {
		const view = { options: frame.test.options, context: frame.context };
		for (const hook of executedHooks) {
			try {
				await hook(view, failed);
			} catch (err) {
				if (verdict === undefined) verdict = err;
			}
		}
	}
	return { callbacks, verdict };
}

/** Increment the assertion counter for the active test (no-op outside a test). */
export function recordAssertion(): void {
	const frame = storage.getStore();
	if (frame) frame.assertions.count += 1;
}

/** Declare that the current test must make exactly `n` assertions. */
export function setExpectedAssertions(n: number): void {
	const frame = storage.getStore();
	if (frame) frame.assertions.expected = n;
}

/** Declare that the current test must make at least one assertion. */
export function setHasAssertions(): void {
	const frame = storage.getStore();
	if (frame) frame.assertions.hasAssertions = true;
}

/** Read the assertion state of the active frame, if any. */
export function getAssertionState(): AssertionState | undefined {
	return storage.getStore()?.assertions;
}

/**
 * Tie a `.resolves` / `.rejects` assertion to the running test, so one the body
 * forgets to `await` still fails it instead of settling after the test passed.
 *
 * The returned promise behaves exactly like `assertion`; awaiting it (or any
 * `then` / `catch` / `finally`) marks it observed, and the body then owns the
 * outcome. Outside a test it is `assertion` itself.
 */
export function trackAsyncAssertion(assertion: Promise<void>): Promise<void> {
	const frame = storage.getStore();
	if (!frame) return assertion;
	const entry: AsyncAssertion = {
		observed: false,
		// Handling it here also keeps an un-awaited failure from becoming an
		// unhandled rejection: it is reported on its test instead.
		outcome: assertion.then(
			() => undefined,
			(error: unknown) => ({ error }),
		),
	};
	frame.asyncAssertions.push(entry);
	return {
		// biome-ignore lint/suspicious/noThenProperty: a deliberate thenable — intercepting `then` is the only way to know the test awaited the assertion, which decides who reports its failure.
		then(onFulfilled, onRejected) {
			entry.observed = true;
			return assertion.then(onFulfilled, onRejected);
		},
		catch(onRejected) {
			entry.observed = true;
			return assertion.catch(onRejected);
		},
		finally(onFinally) {
			entry.observed = true;
			return assertion.finally(onFinally);
		},
		[Symbol.toStringTag]: "Promise",
	};
}

/**
 * Wait for the assertions the test started but never awaited, and throw the
 * first one that failed. Called once the body has returned; the caller bounds
 * the wait by the test's timeout.
 */
export async function settleAsyncAssertions(): Promise<void> {
	const frame = storage.getStore();
	if (!frame) return;
	// An assertion may start another while it settles, so drain until empty.
	while (frame.asyncAssertions.length > 0) {
		const pending = frame.asyncAssertions.splice(0);
		const outcomes = await Promise.all(
			pending.map(async (entry) => ({ entry, outcome: await entry.outcome })),
		);
		for (const { entry, outcome } of outcomes) {
			if (!entry.observed && outcome !== undefined) throw outcome.error;
		}
	}
}
