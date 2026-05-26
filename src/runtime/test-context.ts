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

interface TestFrame {
	cleanups: TestCleanup[];
}

const storage = new AsyncLocalStorage<TestFrame>();

export async function withTestContext<T>(body: () => Promise<T>): Promise<T> {
	const frame: TestFrame = { cleanups: [] };
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
