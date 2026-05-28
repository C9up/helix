/**
 * `helix.relay.fake` — facade for in-memory relay fakes.
 *
 * **Helix is agnostic — no `@c9up/relay` import.** DI pattern;
 * caller passes the `FakeRelay` class at runtime.
 */

import type { ContainerToken } from "../container/index.js";
import {
	override as overrideContainer,
	overrideOn,
} from "../container/override.js";
import { inTestContext, registerTestCleanup } from "../runtime/test-context.js";

/** Duck-typed surface helix needs from a fake relay. Matches
 *  Relay's `FakeRelay` shape. */
export interface RelayFakeLike {
	broadcast(channel: string, data: unknown): number;
	getSent(): unknown[];
	reset(): void;
	assertSent(channel: string, predicate?: unknown): void;
	assertNotSent(channel: string, predicate?: unknown): void;
}

export type RelayFakeCtor<T extends RelayFakeLike = RelayFakeLike> =
	new () => T;

interface RelayContainer {
	override(token: ContainerToken, value: unknown): void;
	restore(token: ContainerToken): void;
}

export interface RelayFakeOptions {
	bind?: boolean;
	container?: RelayContainer;
	bindToken?: ContainerToken;
}

let activeFake: RelayFakeLike | undefined;

export function fake<T extends RelayFakeLike>(
	Ctor: RelayFakeCtor<T>,
	options: RelayFakeOptions = {},
): T {
	if (!inTestContext()) {
		throw new Error(
			"helix.relay.fake: must be called inside a test (no active test frame).",
		);
	}
	const instance = new Ctor();
	const shouldBind = options.bind ?? true;
	if (shouldBind) {
		const token = options.bindToken ?? "relay";
		if (options.container) overrideOn(options.container, token, instance);
		else overrideContainer(token, instance);
	}
	activeFake = instance;
	registerTestCleanup(() => {
		activeFake = undefined;
	});
	return instance;
}

export function current(): RelayFakeLike | null {
	return activeFake ?? null;
}

function requireActive(verb: string): RelayFakeLike {
	if (!activeFake) {
		throw new Error(
			`helix.relay.${verb}: no active fake. Call helix.relay.fake(FakeRelayClass) first.`,
		);
	}
	return activeFake;
}

export function assertSent(channel: string, predicate?: unknown): void {
	requireActive("assertSent").assertSent(channel, predicate);
}
export function assertNotSent(channel: string, predicate?: unknown): void {
	requireActive("assertNotSent").assertNotSent(channel, predicate);
}
export function getSent(): unknown[] {
	return requireActive("getSent").getSent();
}
export function reset(): void {
	if (activeFake) activeFake.reset();
}
