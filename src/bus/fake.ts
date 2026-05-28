/**
 * `helix.bus.fake` — facade for in-memory Pulsar-bus fakes.
 *
 * **Helix is agnostic — no `@c9up/pulsar` import.** DI pattern;
 * caller passes the `FakeBus` class at runtime.
 *
 *   import { FakeBus } from "@c9up/pulsar/testing";
 *   import { bus, useContainer } from "@c9up/helix";
 *
 *   useContainer(container);
 *   bus.fake(FakeBus);
 *   // ... call code under test ...
 *   bus.assertEmitted("order.created", { dataMatches: (d) => ... });
 *
 * NOTE: `helix.bus.fake` overrides ONLY the `"bus"` string container
 * token (default). Code that resolves via the class token —
 * `container.resolve<PulsarBus>(PulsarBus)` — bypasses the override
 * and gets the real bus. Apps wanting full coverage either
 * (a) consistently resolve through the `"bus"` string token, or
 * (b) pass `bindToken: PulsarBus` and call `bus.fake` again to cover
 * the class token. The `Emitter` singleton resolves the bus eagerly
 * via class token, so `bus.fake(...)` MUST run BEFORE the first
 * `container.resolve(Emitter)` call or the emitter will hold a stale
 * reference to the real bus.
 *
 * **Concurrency note.** `activeFake` is a module-level slot, not an
 * `AsyncLocalStorage` cell — same shape as `activeContainer` in
 * `container/override.ts`. Parallel `withTestContext` frames in the
 * same file share the slot; the helix runtime serialises tests, so
 * this is unreachable through the documented path.
 */

import type { ContainerToken } from "../container/index.js";
import {
	override as overrideContainer,
	overrideOn,
} from "../container/override.js";
import { inTestContext, registerTestCleanup } from "../runtime/test-context.js";

/** Predicate shape accepted by the assertion forwarders. Duplicated from
 *  Pulsar's `FakeBusPredicate` to keep helix agnostic (no `@c9up/pulsar`
 *  import). Must stay in lockstep with `packages/pulsar/src/testing/FakeBus.ts`
 *  — divergence is a bug here. */
export interface BusFakePredicate {
	name?: string;
	dataMatches?: (data: unknown) => boolean;
	correlationId?: string;
	causationId?: string;
}

/** Either the structured-predicate form OR a free-form function over a
 *  captured-event shape the caller types as they see fit. */
export type BusFakePredicateArg =
	| BusFakePredicate
	| ((event: unknown) => boolean);

/** Duck-typed surface helix needs from a fake bus. Matches Pulsar's
 *  `FakeBus` exactly — but the import lives at the caller, not here. */
export interface BusFakeLike {
	emit(name: string, data: string): Promise<string>;
	subscribe(pattern: string, callback: (eventJson: string) => void): number;
	unsubscribe(subscriptionId: number): Promise<void>;
	onRequest(
		name: string,
		callback: (
			eventJson: string,
			reply: (response: string) => void,
		) => void | PromiseLike<void>,
	): void;
	request(name: string, data: string, timeoutMs?: number): Promise<string>;
	matchesWildcard(pattern: string, eventName: string): boolean;
	subscriptionCount(): Promise<number>;
	getEmitted(): unknown[];
	getRequests(): unknown[];
	reset(): void;
	assertEmitted(name: string, predicate?: BusFakePredicateArg): void;
	assertNotEmitted(name: string, predicate?: BusFakePredicateArg): void;
}

export type BusFakeCtor<T extends BusFakeLike = BusFakeLike> = new () => T;

interface BusContainer {
	override(token: ContainerToken, value: unknown): void;
	restore(token: ContainerToken): void;
}

export interface BusFakeOptions {
	bind?: boolean;
	container?: BusContainer;
	bindToken?: ContainerToken;
}

let activeFake: BusFakeLike | undefined;

export function fake<T extends BusFakeLike>(
	Ctor: BusFakeCtor<T>,
	options: BusFakeOptions = {},
): T {
	if (!inTestContext()) {
		throw new Error(
			"helix.bus.fake: must be called inside a test (no active test frame). The instance would leak across tests.",
		);
	}
	const instance = new Ctor();
	// CRITICAL ordering: bind BEFORE mutating `activeFake`, so a failed
	// container bind ("no active container") leaves no stale slot state.
	// Note: any side effects in `new Ctor()` itself (timers, resource
	// acquisition, global mutations) remain the caller's responsibility
	// — the slot guarantee covers `activeFake`, not the constructor.
	const shouldBind = options.bind ?? true;
	if (shouldBind) {
		const token = options.bindToken ?? "bus";
		if (options.container) overrideOn(options.container, token, instance);
		else overrideContainer(token, instance);
	}
	activeFake = instance;
	registerTestCleanup(() => {
		activeFake = undefined;
	});
	return instance;
}

export function current(): BusFakeLike | null {
	return activeFake ?? null;
}

function requireActive(verb: string): BusFakeLike {
	if (!activeFake) {
		throw new Error(
			`helix.bus.${verb}: no active fake. Call helix.bus.fake(FakeBusClass) first.`,
		);
	}
	return activeFake;
}

export function assertEmitted(
	name: string,
	predicate?: BusFakePredicateArg,
): void {
	requireActive("assertEmitted").assertEmitted(name, predicate);
}
export function assertNotEmitted(
	name: string,
	predicate?: BusFakePredicateArg,
): void {
	requireActive("assertNotEmitted").assertNotEmitted(name, predicate);
}
export function getEmitted(): unknown[] {
	return requireActive("getEmitted").getEmitted();
}
export function getRequests(): unknown[] {
	return requireActive("getRequests").getRequests();
}
/**
 * Resets the active fake's captured state. Silently no-op when no fake
 * is active — asymmetric on purpose with the other forwarders
 * (`assertEmitted` / `assertNotEmitted` / `getEmitted` / `getRequests`)
 * which throw via `requireActive`. The no-op makes `afterEach(reset)`
 * safe to attach unconditionally; mirrors `helix.relay.reset`.
 */
export function reset(): void {
	if (activeFake) activeFake.reset();
}
