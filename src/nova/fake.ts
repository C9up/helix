/**
 * `helix.nova.fake` — facade for in-memory Web Push fakes.
 *
 * **Helix is agnostic — no `@c9up/nova` import.** Per the cerebrum
 * rule "each package agnostic / self-contained", this module
 * accepts the `FakeNova` class as a runtime argument (DI pattern):
 *
 *   import { FakeNova } from "@c9up/nova/testing";  // caller side
 *   import { nova, useContainer } from "@c9up/helix";
 *   useContainer(container);
 *   const fake = nova.fake(FakeNova);
 *   nova.assertPushed({ userId: "user-A", title: "Welcome" });
 *
 * Helix duck-types the surface (`NovaFakeLike`), instantiates the
 * caller-provided class, optionally binds it into the active
 * container as `'nova'`, and registers per-test cleanup so the
 * fake is undone at end-of-test.
 *
 * **Mirror of `helix.mail.fake` (Story 42.5).** Same lifecycle,
 * same options, same cleanup ordering. The only differences are
 * the duck-typed surface (`push` / `pushToUser` instead of `send`),
 * the default `bindToken` (`'nova'` vs `'mail'`), and the assertion
 * verb names (`assertPushed` / `assertNotPushed` vs `assertSent`
 * / `assertNotSent`).
 *
 * **Concurrency note.** `activeFake` is a module-level slot, not
 * an `AsyncLocalStorage` cell — same shape as `helix.mail.fake`.
 * Two `withTestContext` frames running in parallel inside the
 * same file (e.g. via `Promise.all`) share one slot; the helix
 * runtime executes tests strictly sequentially so this is not
 * reachable through the documented test path.
 */

import type { ContainerToken } from "../container/index.js";
import {
	override as overrideContainer,
	overrideOn,
} from "../container/override.js";
import { inTestContext, registerTestCleanup } from "../runtime/test-context.js";

/** Duck-typed surface helix needs from a fake Nova.
 *  Matches `FakeNova` from `@c9up/nova/testing` exactly — but the
 *  import lives at the caller, not here. Any class implementing
 *  this shape works (a hand-rolled stub, a different framework's
 *  fake, etc.). */
export interface NovaFakeLike {
	push(
		subscription: unknown,
		payload: unknown,
		options?: unknown,
	): Promise<unknown>;
	pushToUser(
		userId: string,
		payload: unknown,
		options?: unknown,
	): Promise<unknown[]>;
	getPushed(): unknown[];
	reset(): void;
	assertPushed(predicate: unknown): void;
	assertNotPushed(predicate: unknown): void;
}

/** A zero-arg constructor that produces a `NovaFakeLike`. */
export type NovaFakeCtor<T extends NovaFakeLike = NovaFakeLike> = new () => T;

/** Container surface helix needs — same `override` shape as
 *  `helix.override` from Story 42.3. Duck-typed so we don't import
 *  the concrete `Container` class. */
interface NovaContainer {
	override(token: ContainerToken, value: unknown): void;
	restore(token: ContainerToken): void;
}

export interface NovaFakeOptions {
	/** When `true` (default), `container.override(bindToken, instance)`
	 *  is called on the active container so DI lookups for the bound
	 *  token return the fake. Set to `false` to skip container
	 *  binding (caller wires the fake into the app themselves, e.g.
	 *  via constructor injection or test-doubles). */
	bind?: boolean;
	/** Container instance to bind on. Defaults to the active
	 *  container set via `useContainer`. Specify explicitly when
	 *  testing multi-container scenarios. */
	container?: NovaContainer;
	/** Token used in the container override. Defaults to `'nova'`. */
	bindToken?: ContainerToken;
}

let activeFake: NovaFakeLike | undefined;

/**
 * Create a fake Nova, set it as the active fake for this test,
 * optionally bind it into the active container, and register
 * end-of-test cleanup that clears `activeFake`.
 *
 * Throws when called outside a test frame — same `inTestContext()`
 * guard as `helix.mail.fake`, `helix.override`, `helix.time.freeze`.
 */
export function fake<T extends NovaFakeLike>(
	Ctor: NovaFakeCtor<T>,
	options: NovaFakeOptions = {},
): T {
	if (!inTestContext()) {
		throw new Error(
			"helix.nova.fake: must be called inside a test (no active test frame). The instance would leak across tests.",
		);
	}
	const instance = new Ctor();
	// CRITICAL ordering: do the container bind BEFORE mutating the
	// `activeFake` slot, so a thrown bind ("no active container")
	// leaves no stale state behind. Set `activeFake` and queue the
	// cleanup only after the bind has succeeded.
	const shouldBind = options.bind ?? true;
	if (shouldBind) {
		const token = options.bindToken ?? "nova";
		if (options.container) {
			overrideOn(options.container, token, instance);
		} else {
			// Falls back to the helix-managed active container set via
			// `useContainer`. If none is active, `override()` throws —
			// caller can pass `bind: false` to skip the binding.
			overrideContainer(token, instance);
		}
	}
	activeFake = instance;
	// Cleanup ordering at frame close (LIFO drain of the cleanup
	// queue): `nova.fake`'s own cleanup is registered AFTER the
	// container `override` cleanup, so it runs FIRST — `activeFake`
	// clears, THEN the container restoration runs.
	registerTestCleanup(() => {
		activeFake = undefined;
	});
	return instance;
}

/** Return the currently-active fake, or `null` if none. */
export function current(): NovaFakeLike | null {
	return activeFake ?? null;
}

function requireActive(verb: string): NovaFakeLike {
	if (!activeFake) {
		throw new Error(
			`helix.nova.${verb}: no active fake. Call helix.nova.fake(FakeNovaClass) first.`,
		);
	}
	return activeFake;
}

/** Forward to the active fake's `assertPushed`. */
export function assertPushed(predicate: unknown): void {
	requireActive("assertPushed").assertPushed(predicate);
}

/** Forward to the active fake's `assertNotPushed`. */
export function assertNotPushed(predicate: unknown): void {
	requireActive("assertNotPushed").assertNotPushed(predicate);
}

/** Forward to the active fake's `getPushed`. */
export function getPushed(): unknown[] {
	return requireActive("getPushed").getPushed();
}

/**
 * Forward to the active fake's `reset`, OR no-op if no fake is
 * active. Unlike the assertion forwarders (which throw because a
 * caller asking "did push X go out?" without a fake is a real
 * test bug), `reset` is documented to be safe to call from
 * teardown blocks — if `nova.fake` was never invoked in this
 * test, there is nothing to reset and nothing to surface.
 */
export function reset(): void {
	if (activeFake) activeFake.reset();
}
