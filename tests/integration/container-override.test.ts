/**
 * Tests for `helix.override` (Story 42-3, FR69) — value-based override,
 * manual + auto restore, and the `withTestContext` cleanup lifecycle.
 *
 * helix's override facade operates on a duck-typed `HelixContainer`
 * (`override` + `restore`, optionally `swapped` + `swap`), so this suite drives it with a minimal in-test
 * container — helix stays dependency-free. The real pairing with
 * `@c9up/ream`'s Container lives in the kitchen-sink integration app.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	clearActiveContainer,
	override,
	overrideOn,
	useContainer,
} from "../../src/container/override.js";
import { withTestContext } from "../../src/runtime/test-context.js";

/**
 * Minimal container implementing the surface helix's override facade drives
 * (`singleton` / `resolve` / `override` / `restore`). Mirrors the relevant
 * slice of `@c9up/ream`'s Container so the facade is tested in isolation.
 */
class StubContainer {
	readonly #factories = new Map<unknown, () => unknown>();
	readonly #overrides = new Map<unknown, unknown>();
	singleton(token: unknown, factory: () => unknown): void {
		this.#factories.set(token, factory);
	}
	// ASYNC, mirroring `@c9up/ream`'s Container (`resolve(): Promise<T>`). A
	// synchronous mirror is not a mirror: it hides a missing `await` in the code
	// under test.
	async resolve(token: unknown): Promise<unknown> {
		if (this.#overrides.has(token)) return this.#overrides.get(token);
		const factory = this.#factories.get(token);
		if (!factory) throw new Error(`no binding for ${String(token)}`);
		return factory();
	}
	override(token: unknown, value: unknown): void {
		this.#overrides.set(token, value);
	}
	restore(token?: unknown): void {
		if (token === undefined) this.#overrides.clear();
		else this.#overrides.delete(token);
	}
}

/**
 * Mirrors the swap slice of `@c9up/ream`'s Container: ONE swap per token
 * (`swap` replaces, `restore` removes it outright, as in AdonisJS), plus the
 * `swapped` reader the facade uses to put a previous swap back.
 */
type Factory = () => unknown;
class SwappableContainer {
	readonly #factories = new Map<unknown, () => unknown>();
	readonly #swaps = new Map<unknown, Factory>();
	readonly calls: string[] = [];
	singleton(token: unknown, factory: () => unknown): void {
		this.#factories.set(token, factory);
	}
	async resolve(token: unknown): Promise<unknown> {
		const swap = this.#swaps.get(token);
		if (swap) return swap();
		const factory = this.#factories.get(token);
		if (!factory) throw new Error(`no binding for ${String(token)}`);
		return factory();
	}
	swap(token: unknown, factory: Factory): void {
		this.calls.push(`swap:${String(token)}`);
		this.#swaps.set(token, factory);
	}
	override(token: unknown, value: unknown): void {
		this.#swaps.set(token, () => value);
	}
	swapped(token: unknown): Factory | undefined {
		return this.#swaps.get(token);
	}
	restore(token?: unknown): void {
		this.calls.push(`restore:${String(token)}`);
		if (token === undefined) this.#swaps.clear();
		else this.#swaps.delete(token);
	}
}

describe("helix.override — puts back the swap that was in place", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("a file-level swap is back after a test overrides the same token", async () => {
		const container = new SwappableContainer();
		container.singleton("mailer", () => "REAL smtp mailer");
		container.swap("mailer", () => "file-level fake"); // a beforeAll

		await withTestContext(async () => {
			overrideOn(container, "mailer", "test-1 fake");
			await expect(container.resolve("mailer")).resolves.toBe("test-1 fake");
		});

		await expect(container.resolve("mailer")).resolves.toBe("file-level fake");
		// The next test sees the file's fake too, not the real binding.
		await withTestContext(async () => {
			await expect(container.resolve("mailer")).resolves.toBe(
				"file-level fake",
			);
		});
	});

	it("two nested overrides unwind one level each, back to the outer swap", async () => {
		const container = new SwappableContainer();
		container.singleton("mailer", () => "real");
		container.swap("mailer", () => "outer fake");
		useContainer(container);

		await withTestContext(async () => {
			override("mailer", "first");
			override("mailer", "second");
			await expect(container.resolve("mailer")).resolves.toBe("second");
			container.calls.length = 0;
		});

		// Last registered first: back to "first", then to "outer fake".
		expect(container.calls).toEqual(["swap:mailer", "swap:mailer"]);
		await expect(container.resolve("mailer")).resolves.toBe("outer fake");
	});

	it("an override in a nested frame is undone when that frame ends", async () => {
		const container = new SwappableContainer();
		container.singleton("mailer", () => "real");

		await withTestContext(async () => {
			overrideOn(container, "mailer", "outer test fake");
			await withTestContext(async () => {
				overrideOn(container, "mailer", "inner fake");
			});
			await expect(container.resolve("mailer")).resolves.toBe(
				"outer test fake",
			);
		});

		await expect(container.resolve("mailer")).resolves.toBe("real");
	});

	it("with no swap before it, the real binding is back (restore, not swap)", async () => {
		const container = new SwappableContainer();
		container.singleton("mailer", () => "real");

		await withTestContext(async () => {
			overrideOn(container, "mailer", "fake");
		});

		expect(container.calls).toEqual(["restore:mailer"]);
		expect(container.swapped("mailer")).toBeUndefined();
		await expect(container.resolve("mailer")).resolves.toBe("real");
	});

	it("falls back to restore(token) on a container that can read swaps but not put one back", async () => {
		const restored: unknown[] = [];
		const container = {
			override(): void {},
			swapped: (): unknown => () => "outer",
			restore(token: unknown): void {
				restored.push(token);
			},
		};

		await withTestContext(async () => {
			overrideOn(container, "mailer", "fake");
		});

		expect(restored).toEqual(["mailer"]);
	});
});

describe("helix.override — facade auto-restore", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("override() throws when no active container is bound", async () => {
		clearActiveContainer();
		await withTestContext(async () => {
			expect(() => override("any", "value")).toThrow(/no active container/);
		});
	});

	it("override() registers cleanup on the active container", async () => {
		const container = new StubContainer();
		container.singleton("svc", () => "real");
		useContainer(container);

		await withTestContext(async () => {
			override("svc", "fake");
			await expect(container.resolve("svc")).resolves.toBe("fake");
		});

		// withTestContext drained the cleanup queue → original is back.
		await expect(container.resolve("svc")).resolves.toBe("real");
	});

	it("overrideOn() targets a specific container instance", async () => {
		const c1 = new StubContainer();
		const c2 = new StubContainer();
		c1.singleton("svc", () => "c1-real");
		c2.singleton("svc", () => "c2-real");

		await withTestContext(async () => {
			overrideOn(c1, "svc", "c1-fake");
			await expect(c1.resolve("svc")).resolves.toBe("c1-fake");
			await expect(c2.resolve("svc")).resolves.toBe("c2-real");
		});

		await expect(c1.resolve("svc")).resolves.toBe("c1-real");
		await expect(c2.resolve("svc")).resolves.toBe("c2-real");
	});

	it("auto-restore unwinds in reverse insertion order", async () => {
		const container = new StubContainer();
		const restoreOrder: string[] = [];
		// Spy on restore so we observe the cleanup order without a custom
		// container subclass.
		const realRestore = container.restore.bind(container);
		container.restore = ((token?: unknown) => {
			restoreOrder.push(String(token));
			return realRestore(token);
		}) as typeof container.restore;
		container.singleton("a", () => "real-a");
		container.singleton("b", () => "real-b");
		useContainer(container);

		await withTestContext(async () => {
			override("a", "fake-a");
			override("b", "fake-b");
		});

		expect(restoreOrder).toEqual(["b", "a"]);
	});

	it("override() outside a test frame throws (M1)", () => {
		const container = new StubContainer();
		container.singleton("svc", () => "real");
		useContainer(container);
		// No `withTestContext` wrapping — direct call.
		expect(() => override("svc", "fake")).toThrow(
			/must be called inside a test/,
		);
	});

	it("useContainer auto-restores the previous active container at frame end (M3)", async () => {
		const c1 = new StubContainer();
		const c2 = new StubContainer();
		c1.singleton("svc", () => "c1-real");
		c2.singleton("svc", () => "c2-real");
		useContainer(c1);

		await withTestContext(async () => {
			useContainer(c2);
			// Inside the frame, override resolves on c2.
			override("svc", "c2-fake");
			await expect(c2.resolve("svc")).resolves.toBe("c2-fake");
		});

		// Frame closed → activeContainer is back to c1, c2's override drained.
		await expect(c2.resolve("svc")).resolves.toBe("c2-real");
		// Re-issue override on the (now-active) c1 to prove c1 survived.
		await withTestContext(async () => {
			override("svc", "c1-fake");
			await expect(c1.resolve("svc")).resolves.toBe("c1-fake");
		});
		await expect(c1.resolve("svc")).resolves.toBe("c1-real");
	});

	it("async cleanup is awaited before the frame returns (M4)", async () => {
		const container = new StubContainer();
		container.singleton("svc", () => "real");
		useContainer(container);
		// Custom token whose restore is async — proves the cleanup queue
		// awaits each step rather than fire-and-forget.
		const restoreLog: string[] = [];
		const realRestore = container.restore.bind(container);
		container.restore = (async (token?: unknown) => {
			await new Promise((r) => setTimeout(r, 5));
			restoreLog.push(String(token));
			return realRestore(token);
		}) as typeof container.restore;

		await withTestContext(async () => {
			override("svc", "fake");
		});

		// If the cleanup wasn't awaited, restoreLog would still be empty.
		expect(restoreLog).toEqual(["svc"]);
	});
});
