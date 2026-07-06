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
 * Cleanup semantics mirror `withViContext`'s finally:
 *   - reverse insertion order
 *   - one cleanup throwing must not block the others
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type TestCleanup = () => void | Promise<void>;

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
}

const storage = new AsyncLocalStorage<TestFrame>();

export async function withTestContext<T>(body: () => Promise<T>): Promise<T> {
	const frame: TestFrame = {
		cleanups: [],
		onFinished: [],
		onFailed: [],
		assertions: { count: 0, expected: undefined, hasAssertions: false },
	};
	try {
		return await storage.run(frame, body);
	} finally {
		for (let i = frame.cleanups.length - 1; i >= 0; i -= 1) {
			try {
				await frame.cleanups[i]();
			} catch (err) {
				// One cleanup failing must not block the others — but log it
				// so silent leaks become noisy. `console.error` matches what
				// Vitest does for `afterEach` failures observed at runtime.
				console.error("[helix] test cleanup failed:", err);
			}
		}
	}
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

/** Drain the `onTestFinished`/`onTestFailed` callbacks for the current frame. */
export async function drainTestOutcomeHooks(failed: boolean): Promise<void> {
	const frame = storage.getStore();
	if (!frame) return;
	// `onTestFailed` first (diagnostics), then `onTestFinished` — both in
	// reverse insertion order to mirror Vitest teardown semantics.
	if (failed) {
		for (let i = frame.onFailed.length - 1; i >= 0; i -= 1) {
			try {
				await frame.onFailed[i]();
			} catch (err) {
				console.error("[helix] onTestFailed callback threw:", err);
			}
		}
	}
	for (let i = frame.onFinished.length - 1; i >= 0; i -= 1) {
		try {
			await frame.onFinished[i]();
		} catch (err) {
			console.error("[helix] onTestFinished callback threw:", err);
		}
	}
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
