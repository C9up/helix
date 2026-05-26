import { describe, expect, it } from "vitest";

function arityOf(fn: unknown): number {
	if (typeof fn !== "function") {
		throw new Error("arityOf: not a function");
	}
	return fn.length;
}

/**
 * Smoke tests proving the three Helix sub-barrels resolve at import time.
 * Catches broken re-exports from the source packages (missing `./testing`
 * subpaths, moved symbols, etc.) that TS would otherwise miss until CI.
 */

describe("helix > barrels", () => {
	it("@c9up/helix/http exposes the TestClient + RequestBuilder + http.request factory", async () => {
		const mod = await import("../../src/http/index.js");
		expect(typeof mod.TestClient).toBe("function");
		expect(typeof mod.RequestBuilder).toBe("function");
		expect(typeof mod.createTestClient).toBe("function");
		expect(typeof mod.http.request).toBe("function");
		expect(typeof mod.partialMatch).toBe("function");
	});

	it("@c9up/helix/db re-exports atlas factory / useTransaction / truncateAll / Database", async () => {
		const mod = await import("../../src/db/index.js");
		expect(typeof mod.factory).toBe("function");
		expect(typeof mod.useTransaction).toBe("function");
		expect(typeof mod.truncateAll).toBe("function");
		expect(typeof mod.Database).toBe("function");
	});

	it("@c9up/helix/bus re-exports pulsar bus helpers", async () => {
		const mod = await import("../../src/bus/index.js");
		// Pulsar helix helpers include at least `assertEmitted` / `waitForChain`.
		// Soft-check: module object has at least one exported function.
		const exported = Object.entries(mod).filter(
			([, v]) => typeof v === "function",
		);
		expect(exported.length).toBeGreaterThan(0);
	});

	it("@c9up/helix/bus `assertEmitted` resolves to the new facade arity (Story 43.3)", async () => {
		// Export order in `bus/index.ts` places `./fake.js` AFTER the
		// pulsar helpers re-export — so `assertEmitted` here is the new
		// facade form `(name, predicate?)` (arity 2), NOT the older
		// `(events, name, payload?)` observer form (arity 3). Pins the
		// resolution so a future re-ordering trips this test instead of
		// silently flipping the surface.
		const mod = await import("../../src/bus/index.js");
		expect(arityOf(mod.assertEmitted)).toBe(2);
		expect(arityOf(mod.assertNotEmitted)).toBe(2);
		expect(typeof mod.fake).toBe("function");
		expect(typeof mod.current).toBe("function");
		expect(typeof mod.getEmitted).toBe("function");
	});

	it("@c9up/helix/bus all five facade forwarders resolve to local ./fake.js (Story 43.3)", async () => {
		// Identity check guards against a future pulsar/helix re-export
		// adding any of these names (`fake`, `current`, `getEmitted`,
		// `getRequests`, `reset`, `assertEmitted`, `assertNotEmitted`) and
		// silently winning over the helix-local override. Identity diverges
		// the moment the barrel resolves a non-local symbol.
		const barrel = await import("../../src/bus/index.js");
		const local = await import("../../src/bus/fake.js");
		expect(barrel.fake).toBe(local.fake);
		expect(barrel.current).toBe(local.current);
		expect(barrel.getEmitted).toBe(local.getEmitted);
		expect(barrel.getRequests).toBe(local.getRequests);
		expect(barrel.reset).toBe(local.reset);
		expect(barrel.assertEmitted).toBe(local.assertEmitted);
		expect(barrel.assertNotEmitted).toBe(local.assertNotEmitted);
	});

	it("@c9up/helix main barrel namespaces bus + spreads http + db", async () => {
		const mod = await import("../../src/index.js");
		// `bus` is a namespace (not spread) to avoid name collisions.
		expect(typeof mod.bus).toBe("object");
		// `http` comes from ./http/index.js (spread).
		expect(typeof mod.http).toBe("object");
		expect(typeof mod.http.request).toBe("function");
		// `factory` comes from ./db/index.js (spread).
		expect(typeof mod.factory).toBe("function");
	});
});
