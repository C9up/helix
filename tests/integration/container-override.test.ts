/**
 * Tests for `helix.override` (Story 42-3, FR69) — value-based override,
 * manual + auto restore, and the `withTestContext` cleanup lifecycle.
 *
 * helix's override facade operates on a duck-typed `HelixContainer`
 * (`override` + `restore`), so this suite drives it with a minimal in-test
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
	resolve(token: unknown): unknown {
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
			expect(container.resolve("svc")).toBe("fake");
		});

		// withTestContext drained the cleanup queue → original is back.
		expect(container.resolve("svc")).toBe("real");
	});

	it("overrideOn() targets a specific container instance", async () => {
		const c1 = new StubContainer();
		const c2 = new StubContainer();
		c1.singleton("svc", () => "c1-real");
		c2.singleton("svc", () => "c2-real");

		await withTestContext(async () => {
			overrideOn(c1, "svc", "c1-fake");
			expect(c1.resolve("svc")).toBe("c1-fake");
			expect(c2.resolve("svc")).toBe("c2-real");
		});

		expect(c1.resolve("svc")).toBe("c1-real");
		expect(c2.resolve("svc")).toBe("c2-real");
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
			expect(c2.resolve("svc")).toBe("c2-fake");
		});

		// Frame closed → activeContainer is back to c1, c2's override drained.
		expect(c2.resolve("svc")).toBe("c2-real");
		// Re-issue override on the (now-active) c1 to prove c1 survived.
		await withTestContext(async () => {
			override("svc", "c1-fake");
			expect(c1.resolve("svc")).toBe("c1-fake");
		});
		expect(c1.resolve("svc")).toBe("c1-real");
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
