/**
 * `helix.storage.fake` — facade for in-memory storage fakes.
 *
 * **Helix is agnostic — no `@c9up/archive` import.** DI pattern;
 * caller passes the `FakeStorage` class at runtime.
 */

import type { ContainerToken } from "../container/index.js";
import {
	override as overrideContainer,
	overrideOn,
} from "../container/override.js";
import { inTestContext, registerTestCleanup } from "../runtime/test-context.js";

/** Duck-typed surface helix needs from a fake storage driver.
 *  Note: `put` mirrors the real `StorageDriver` (Buffer | string)
 *  but typed as `unknown` here to avoid pulling Archive types. */
export interface StorageFakeLike {
	put(filePath: string, content: unknown): Promise<unknown>;
	getStored(): unknown[];
	reset(): void;
	assertStored(path: string, predicate?: unknown): void;
	assertNotStored(path: string, predicate?: unknown): void;
}

export type StorageFakeCtor<T extends StorageFakeLike = StorageFakeLike> =
	new () => T;

interface StorageContainer {
	override(token: ContainerToken, value: unknown): void;
	restore(token: ContainerToken): void;
}

export interface StorageFakeOptions {
	bind?: boolean;
	container?: StorageContainer;
	bindToken?: ContainerToken;
}

let activeFake: StorageFakeLike | undefined;

export function fake<T extends StorageFakeLike>(
	Ctor: StorageFakeCtor<T>,
	options: StorageFakeOptions = {},
): T {
	if (!inTestContext()) {
		throw new Error(
			"helix.storage.fake: must be called inside a test (no active test frame).",
		);
	}
	const instance = new Ctor();
	const shouldBind = options.bind ?? true;
	if (shouldBind) {
		const token = options.bindToken ?? "storage";
		if (options.container) overrideOn(options.container, token, instance);
		else overrideContainer(token, instance);
	}
	activeFake = instance;
	registerTestCleanup(() => {
		activeFake = undefined;
	});
	return instance;
}

export function current(): StorageFakeLike | null {
	return activeFake ?? null;
}

function requireActive(verb: string): StorageFakeLike {
	if (!activeFake) {
		throw new Error(
			`helix.storage.${verb}: no active fake. Call helix.storage.fake(FakeStorageClass) first.`,
		);
	}
	return activeFake;
}

export function assertStored(path: string, predicate?: unknown): void {
	requireActive("assertStored").assertStored(path, predicate);
}
export function assertNotStored(path: string, predicate?: unknown): void {
	requireActive("assertNotStored").assertNotStored(path, predicate);
}
export function getStored(): unknown[] {
	return requireActive("getStored").getStored();
}
export function reset(): void {
	if (activeFake) activeFake.reset();
}
