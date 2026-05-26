/**
 * `helix.queue.fake` — facade for in-memory queue-driver fakes.
 *
 * **Helix is agnostic — no `@c9up/bay` import.** Per the cerebrum
 * rule "each package agnostic / self-contained", this module
 * accepts the `FakeQueue` class as a runtime argument (DI pattern):
 *
 *   import { FakeQueue } from "@c9up/bay/testing";  // caller side
 *   import { queue, useContainer } from "@c9up/helix";
 *   useContainer(container);
 *   queue.fake(FakeQueue);
 *   await app.dispatch("send-email", { to: "user@x.com" });
 *   queue.assertPushed("send-email");
 *
 * Helix duck-types the surface (`QueueFakeLike`), instantiates the
 * caller-provided class, optionally binds it into the active
 * container as `'queue'`, and registers per-test cleanup so the
 * fake is undone at end-of-test.
 *
 * **Concurrency note.** `activeFake` is a module-level slot, not
 * an `AsyncLocalStorage` cell — same shape as `activeContainer` in
 * `container/override.ts`. Two `withTestContext` frames running
 * in parallel inside the same file (e.g. via `Promise.all`) share
 * one slot — frame B's `queue.fake(...)` clobbers frame A's. The
 * helix runtime executes tests strictly sequentially
 * (`runSuite`'s for-await loop), so this is unreachable through
 * the documented test path.
 */

import type { ContainerToken } from "../container/index.js";
import {
	override as overrideContainer,
	overrideOn,
} from "../container/override.js";
import { inTestContext, registerTestCleanup } from "../runtime/test-context.js";

/** Duck-typed surface helix needs from a fake queue driver. Matches
 *  Bay's `FakeQueue` shape — but the import lives at the caller. */
export interface QueueFakeLike {
	push(job: unknown): Promise<unknown>;
	getPushed(): unknown[];
	reset(): void;
	assertPushed(name: string, predicate?: unknown): void;
	assertNotPushed(name: string, predicate?: unknown): void;
}

export type QueueFakeCtor<T extends QueueFakeLike = QueueFakeLike> =
	new () => T;

interface QueueContainer {
	override(token: ContainerToken, value: unknown): void;
	restore(token: ContainerToken): void;
}

export interface QueueFakeOptions {
	/** When `true` (default), the active container's `'queue'` (or
	 *  `bindToken`) binding is overridden with the fake instance. */
	bind?: boolean;
	/** Container to bind on. Defaults to the active container set
	 *  via `useContainer`. Specify explicitly for multi-container
	 *  scenarios. */
	container?: QueueContainer;
	/** Token used in the container override. Defaults to `'queue'`. */
	bindToken?: ContainerToken;
}

let activeFake: QueueFakeLike | undefined;

/**
 * Create a fake queue driver, set it as the active fake for this
 * test, optionally bind it into the active container, and register
 * end-of-test cleanup that clears `activeFake`.
 *
 * Throws when called outside a test frame — same `inTestContext()`
 * guard as `helix.override` / `helix.time.freeze` / `helix.mail.fake`.
 */
export function fake<T extends QueueFakeLike>(
	Ctor: QueueFakeCtor<T>,
	options: QueueFakeOptions = {},
): T {
	if (!inTestContext()) {
		throw new Error(
			"helix.queue.fake: must be called inside a test (no active test frame). The instance would leak across tests.",
		);
	}
	const instance = new Ctor();
	// CRITICAL ordering (lesson from 42.5 C1): bind FIRST, mutate
	// `activeFake` SECOND, register cleanup THIRD. A throw from the
	// bind ("no active container") then leaves no stale state.
	const shouldBind = options.bind ?? true;
	if (shouldBind) {
		const token = options.bindToken ?? "queue";
		if (options.container) {
			overrideOn(options.container, token, instance);
		} else {
			overrideContainer(token, instance);
		}
	}
	activeFake = instance;
	// LIFO drain: this cleanup runs FIRST (registered last),
	// container restoration second — so any code triggered by the
	// container restoration sees `activeFake === undefined`.
	registerTestCleanup(() => {
		activeFake = undefined;
	});
	return instance;
}

/** Return the currently-active fake, or `null` if none. */
export function current(): QueueFakeLike | null {
	return activeFake ?? null;
}

function requireActive(verb: string): QueueFakeLike {
	if (!activeFake) {
		throw new Error(
			`helix.queue.${verb}: no active fake. Call helix.queue.fake(FakeQueueClass) first.`,
		);
	}
	return activeFake;
}

/** Forward to the active fake's `assertPushed`. */
export function assertPushed(name: string, predicate?: unknown): void {
	requireActive("assertPushed").assertPushed(name, predicate);
}

/** Forward to the active fake's `assertNotPushed`. */
export function assertNotPushed(name: string, predicate?: unknown): void {
	requireActive("assertNotPushed").assertNotPushed(name, predicate);
}

/** Forward to the active fake's `getPushed`. */
export function getPushed(): unknown[] {
	return requireActive("getPushed").getPushed();
}

/**
 * Forward to the active fake's `reset`, OR no-op if no fake is
 * active. Documented to be safe in teardown blocks (matches the
 * `mail.reset` ergonomics from 42.5).
 */
export function reset(): void {
	if (activeFake) activeFake.reset();
}
