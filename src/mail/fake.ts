/**
 * `helix.mail.fake` — facade for in-memory mail-transport fakes.
 *
 * **Helix is agnostic — no `@c9up/rover` import.** Per the cerebrum
 * rule "each package agnostic / self-contained", this module
 * accepts the `FakeMail` class as a runtime argument (DI pattern):
 *
 *   import { FakeMail } from "@c9up/rover/testing";  // caller side
 *   import { mail, useContainer } from "@c9up/helix";
 *   useContainer(container);
 *   const fake = mail.fake(FakeMail);
 *   mail.assertSent({ to: "user@x.com", subject: "Welcome" });
 *
 * Helix duck-types the surface (`MailFakeLike`), instantiates the
 * caller-provided class, optionally binds it into the active
 * container as `'mail'`, and registers per-test cleanup so the
 * fake is undone at end-of-test.
 *
 * **Concurrency note.** `activeFake` is a module-level slot, not
 * an `AsyncLocalStorage` cell — same shape as `activeContainer` in
 * `container/override.ts`. Two `withTestContext` frames running
 * in parallel inside the same file (e.g. via `Promise.all`) share
 * one slot — frame B's `mail.fake(...)` clobbers frame A's, and
 * forwarder calls from A see B's instance. The helix runtime
 * executes tests strictly sequentially (`runSuite`'s for-await
 * loop), so this is not reachable through the documented test
 * path. Callers who manually compose `withTestContext` in
 * parallel inside one file must serialise their `mail.fake`
 * calls themselves (or hold direct references to each instance
 * and skip the forwarders).
 */

import type { ContainerToken } from "../container/index.js";
import {
	override as overrideContainer,
	overrideOn,
} from "../container/override.js";
import { inTestContext, registerTestCleanup } from "../runtime/test-context.js";

/** Duck-typed surface helix needs from a fake mail transport.
 *  Matches Rover's `FakeMail` exactly — but the import lives at
 *  the caller, not here. Any class implementing this shape works
 *  (a hand-rolled stub, a different framework's fake, etc.). */
export interface MailFakeLike {
	send(message: unknown): Promise<unknown>;
	getSent(): unknown[];
	reset(): void;
	assertSent(predicate: unknown): void;
	assertNotSent(predicate: unknown): void;
}

/** A zero-arg constructor that produces a `MailFakeLike`. */
export type MailFakeCtor<T extends MailFakeLike = MailFakeLike> = new () => T;

/** Container surface helix needs — same `override` shape as
 *  `helix.override` from Story 42.3. Duck-typed so we don't import
 *  the concrete `Container` class. */
interface MailContainer {
	override(token: ContainerToken, value: unknown): void;
	restore(token: ContainerToken): void;
}

export interface MailFakeOptions {
	/** When `true` (default), `container.override(bindToken, instance)`
	 *  is called on the active container so DI lookups for the bound
	 *  token return the fake. Set to `false` to skip container
	 *  binding (caller wires the fake into the app themselves, e.g.
	 *  via constructor injection or test-doubles). */
	bind?: boolean;
	/** Container instance to bind on. Defaults to the active
	 *  container set via `useContainer`. Specify explicitly when
	 *  testing multi-container scenarios. */
	container?: MailContainer;
	/** Token used in the container override. Defaults to `'mail'`. */
	bindToken?: ContainerToken;
}

let activeFake: MailFakeLike | undefined;

/**
 * Create a fake mail transport, set it as the active fake for this
 * test, optionally bind it into the active container, and register
 * end-of-test cleanup that clears `activeFake`.
 *
 * Throws when called outside a test frame — same `inTestContext()`
 * guard as `helix.override` and `helix.time.freeze`.
 */
export function fake<T extends MailFakeLike>(
	Ctor: MailFakeCtor<T>,
	options: MailFakeOptions = {},
): T {
	if (!inTestContext()) {
		throw new Error(
			"helix.mail.fake: must be called inside a test (no active test frame). The instance would leak across tests.",
		);
	}
	const instance = new Ctor();
	// CRITICAL ordering: do the container bind BEFORE mutating the
	// `activeFake` slot, so a thrown bind ("no active container")
	// leaves no stale state behind. Set `activeFake` and queue the
	// cleanup only after the bind has succeeded.
	const shouldBind = options.bind ?? true;
	if (shouldBind) {
		const token = options.bindToken ?? "mail";
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
	// queue): `mail.fake`'s own cleanup is registered AFTER the
	// container `override` cleanup, so it runs FIRST — `activeFake`
	// clears, THEN the container restoration runs. That ordering
	// prevents any code triggered by the container restoration
	// (e.g. eager-resolve hooks) from seeing a stale `activeFake`.
	registerTestCleanup(() => {
		activeFake = undefined;
	});
	return instance;
}

/** Return the currently-active fake, or `null` if none. */
export function current(): MailFakeLike | null {
	return activeFake ?? null;
}

function requireActive(verb: string): MailFakeLike {
	if (!activeFake) {
		throw new Error(
			`helix.mail.${verb}: no active fake. Call helix.mail.fake(FakeMailClass) first.`,
		);
	}
	return activeFake;
}

/** Forward to the active fake's `assertSent`. */
export function assertSent(predicate: unknown): void {
	requireActive("assertSent").assertSent(predicate);
}

/** Forward to the active fake's `assertNotSent`. */
export function assertNotSent(predicate: unknown): void {
	requireActive("assertNotSent").assertNotSent(predicate);
}

/** Forward to the active fake's `getSent`. */
export function getSent(): unknown[] {
	return requireActive("getSent").getSent();
}

/**
 * Forward to the active fake's `reset`, OR no-op if no fake is
 * active. Unlike the assertion forwarders (which throw because a
 * caller asking "did mail X get sent?" without a fake is a real
 * test bug), `reset` is documented to be safe to call from
 * teardown blocks — if `mail.fake` was never invoked in this
 * test, there is nothing to reset and nothing to surface.
 */
export function reset(): void {
	if (activeFake) activeFake.reset();
}
