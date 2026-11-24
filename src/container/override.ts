/**
 * Helix facade over `@c9up/ream`'s `Container.override(token, value)`.
 *
 * Adds two things to the raw container call:
 *   1. The override is registered against the active test context's
 *      auto-restore queue, so it's undone after the test even if the
 *      test body never calls `restore()` itself. Undone means the token
 *      resolves as it did before the call: through a swap that was
 *      already in place, or through its binding.
 *   2. A clear error when called outside a test (no AsyncLocalStorage
 *      frame) — the queued cleanup would never fire there.
 *
 * The active container is passed via `useContainer(container)` (called
 * by the host app's test bootstrap). For bare unit tests with no host
 * app, callers can pass the container explicitly to `overrideOn`.
 */

import {
	E_HELIX_NO_ACTIVE_CONTAINER,
	E_HELIX_NO_ACTIVE_TEST,
} from "../errors.js";
import { inTestContext, registerTestCleanup } from "../runtime/test-context.js";
import type { ContainerLike, ContainerToken } from "../runtime/vi/index.js";

/**
 * Container surface helix needs: a value-based override + a restore.
 *
 * `swapped` + `swap` are optional. With both, the end-of-test cleanup puts
 * back whatever swap was in place before the override (a fake the file
 * installed in `beforeAll`, an outer `override()`); without them it falls
 * back to `restore(token)`, which removes every swap of the token.
 */
export interface HelixContainer extends ContainerLike {
	override(token: ContainerToken, value: unknown): void;
	/**
	 * The swap in place for `token` (`@c9up/ream`: its `ServiceFactory`), read
	 * without running it; `undefined` when the token is not swapped. Opaque to
	 * helix: only handed back to `swap`, never called.
	 */
	swapped?(token: ContainerToken): unknown;
	/** Put back a swap read through `swapped`. */
	swap?(token: ContainerToken, factory: unknown): void;
}

let activeContainer: HelixContainer | undefined;

/**
 * Bind a container instance as active for `helix.override(...)` calls.
 *
 * If called inside a test frame, the previous active container is
 * captured and restored when the frame ends — so swapping the active
 * container mid-test does not leak into the next test. Outside a test
 * frame the assignment is permanent until the next `useContainer` /
 * `clearActiveContainer` call.
 */
export function useContainer(container: HelixContainer): void {
	const previous = activeContainer;
	activeContainer = container;
	registerTestCleanup(() => {
		activeContainer = previous;
	});
}

/** Reset the active container binding. Typically not needed in user
 *  code — `useContainer` already auto-restores when called inside a
 *  test. Exposed so `afterEach` blocks (and unit tests) can clear the
 *  module-scoped slot explicitly. */
export function clearActiveContainer(): void {
	activeContainer = undefined;
}

/**
 * Override a binding on the active container with a value, and queue
 * the restore for end-of-test. Use `overrideOn` when you need to
 * target a specific container instance.
 *
 * Throws if called outside a test frame: a queued cleanup would never
 * fire there, so the override would leak across tests silently.
 */
export function override(token: ContainerToken, value: unknown): void {
	if (!inTestContext()) {
		throw new E_HELIX_NO_ACTIVE_TEST([
			"helix.override: must be called inside a test (no active test frame). Calls from top-level setup leak across tests — use container.override() directly with manual restore() if that is what you want.",
		]);
	}
	if (!activeContainer) {
		throw new E_HELIX_NO_ACTIVE_CONTAINER();
	}
	overrideOn(activeContainer, token, value);
}

/** Override on a specific container instance. */
export function overrideOn(
	container: HelixContainer,
	token: ContainerToken,
	value: unknown,
): void {
	const undo = undoFor(container, token);
	container.override(token, value);
	// `registerTestCleanup` returns false when called outside a test
	// frame (e.g. raw vitest tests, REPL, top-level setup). In that
	// case the caller is responsible for `container.restore(token)` —
	// we don't queue a fallback that might fire in an unexpected
	// frame.
	registerTestCleanup(undo);
}

/**
 * The cleanup that returns `token` to how it resolved before this override.
 *
 * The container's `restore(token)` is flat: it removes the token's swap
 * outright, including one installed before this test, so every later test
 * would resolve the real service. Capturing the swap in place first and
 * swapping it back undoes only this override; cleanups run last-registered
 * first, so nested overrides unwind one level each.
 */
function undoFor(container: HelixContainer, token: ContainerToken): () => void {
	const { swapped, swap } = container;
	if (swapped === undefined || swap === undefined) {
		return () => container.restore(token);
	}
	const previous = swapped.call(container, token);
	if (previous === undefined) return () => container.restore(token);
	return () => swap.call(container, token, previous);
}
