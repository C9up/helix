/**
 * `helix.logger.fake` — facade for in-memory logger fakes.
 *
 * **Helix is agnostic — no `@c9up/spectrum` import.** Caller
 * passes the `FakeLogger` class to `logger.fake(...)` at runtime;
 * helix duck-types `LoggerFakeLike` and orchestrates the
 * lifecycle. Same DI pattern as `mail.fake` / `queue.fake`.
 */

import type { ContainerToken } from "../container/index.js";
import {
	override as overrideContainer,
	overrideOn,
} from "../container/override.js";
import { inTestContext, registerTestCleanup } from "../runtime/test-context.js";

/** Duck-typed surface helix needs from a fake logger. Matches
 *  Spectrum's `FakeLogger` shape. */
export interface LoggerFakeLike {
	write(entry: unknown): void;
	getLogged(): unknown[];
	reset(): void;
	assertLogged(level: string, predicate?: unknown): void;
	assertNotLogged(level: string, predicate?: unknown): void;
}

export type LoggerFakeCtor<T extends LoggerFakeLike = LoggerFakeLike> =
	new () => T;

interface LoggerContainer {
	override(token: ContainerToken, value: unknown): void;
	restore(token: ContainerToken): void;
}

export interface LoggerFakeOptions {
	bind?: boolean;
	container?: LoggerContainer;
	bindToken?: ContainerToken;
}

let activeFake: LoggerFakeLike | undefined;

export function fake<T extends LoggerFakeLike>(
	Ctor: LoggerFakeCtor<T>,
	options: LoggerFakeOptions = {},
): T {
	if (!inTestContext()) {
		throw new Error(
			"helix.logger.fake: must be called inside a test (no active test frame).",
		);
	}
	const instance = new Ctor();
	const shouldBind = options.bind ?? true;
	if (shouldBind) {
		const token = options.bindToken ?? "logger";
		if (options.container) overrideOn(options.container, token, instance);
		else overrideContainer(token, instance);
	}
	activeFake = instance;
	registerTestCleanup(() => {
		activeFake = undefined;
	});
	return instance;
}

export function current(): LoggerFakeLike | null {
	return activeFake ?? null;
}

function requireActive(verb: string): LoggerFakeLike {
	if (!activeFake) {
		throw new Error(
			`helix.logger.${verb}: no active fake. Call helix.logger.fake(FakeLoggerClass) first.`,
		);
	}
	return activeFake;
}

export function assertLogged(level: string, predicate?: unknown): void {
	requireActive("assertLogged").assertLogged(level, predicate);
}
export function assertNotLogged(level: string, predicate?: unknown): void {
	requireActive("assertNotLogged").assertNotLogged(level, predicate);
}
export function getLogged(): unknown[] {
	return requireActive("getLogged").getLogged();
}
export function reset(): void {
	if (activeFake) activeFake.reset();
}
