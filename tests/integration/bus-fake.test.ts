/**
 * Integration tests for `helix.bus.fake` (Story 43.3).
 *
 * Helix is agnostic — no `@c9up/pulsar` import. Local `StubFakeBus`
 * proves the duck-typed contract.
 */

import { Container } from "@c9up/ream";
import { afterEach, describe, expect, it } from "vitest";
import type { BusFakeLike } from "../../src/bus/fake.js";
import {
	assertEmitted,
	assertNotEmitted,
	current,
	fake,
	getEmitted,
	getRequests,
	reset,
} from "../../src/bus/fake.js";
import {
	clearActiveContainer,
	useContainer,
} from "../../src/container/override.js";
import { withTestContext } from "../../src/runtime/test-context.js";

interface StubEmit {
	name: string;
	data: string;
	correlationId?: string;
}

class StubFakeBus implements BusFakeLike {
	captured: StubEmit[] = [];
	requests: StubEmit[] = [];
	handlers = new Map<
		string,
		(data: string, reply: (r: string) => void) => void
	>();
	subId = 0;
	resetCount = 0;

	emit(name: string, data: string): Promise<string> {
		this.captured.push({ name, data });
		return Promise.resolve("ok");
	}
	subscribe(): number {
		this.subId += 1;
		return this.subId;
	}
	unsubscribe(): Promise<void> {
		return Promise.resolve();
	}
	onRequest(
		name: string,
		cb: (d: string, r: (x: string) => void) => void,
	): void {
		this.handlers.set(name, cb);
	}
	request(name: string, data: string): Promise<string> {
		this.requests.push({ name, data });
		return Promise.resolve("reply");
	}
	matchesWildcard(pattern: string, eventName: string): boolean {
		return pattern === eventName || pattern === "**";
	}
	subscriptionCount(): Promise<number> {
		return Promise.resolve(0);
	}
	getEmitted(): unknown[] {
		return this.captured.slice();
	}
	getRequests(): unknown[] {
		return this.requests.slice();
	}
	reset(): void {
		this.captured = [];
		this.requests = [];
		this.resetCount += 1;
	}
	assertEmitted(name: string): void {
		if (!this.captured.some((c) => c.name === name)) {
			throw new Error(`stub.assertEmitted failed: ${name}`);
		}
	}
	assertNotEmitted(name: string): void {
		if (this.captured.some((c) => c.name === name)) {
			throw new Error(`stub.assertNotEmitted failed: ${name}`);
		}
	}
}

describe("bus.fake — instance + binding", () => {
	afterEach(() => clearActiveContainer());

	it("returns a fresh instance inside a test frame", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeBus, { bind: false });
			expect(f).toBeInstanceOf(StubFakeBus);
			expect(current()).toBe(f);
		});
	});

	it("auto-binds to active container as 'bus'", async () => {
		const c = new Container();
		c.singleton("bus", () => ({ real: true }));
		useContainer(c);
		await withTestContext(async () => {
			const f = fake(StubFakeBus);
			expect(c.resolve("bus")).toBe(f);
		});
	});

	it("bindToken option overrides a non-default token", async () => {
		const c = new Container();
		c.singleton("custom-bus", () => ({ real: true }));
		useContainer(c);
		await withTestContext(async () => {
			const f = fake(StubFakeBus, { bindToken: "custom-bus" });
			expect(c.resolve("custom-bus")).toBe(f);
		});
	});

	it("bind: false skips container override but still sets activeFake", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeBus, { bind: false });
			expect(current()).toBe(f);
		});
	});

	it("throws outside a test frame", () => {
		expect(() => fake(StubFakeBus, { bind: false })).toThrow(/inside a test/);
	});

	it("failed bind does NOT pollute activeFake (no active container)", async () => {
		await withTestContext(async () => {
			expect(() => fake(StubFakeBus)).toThrow(/no active container/);
			expect(current()).toBeNull();
		});
	});
});

describe("bus.fake — forwarders", () => {
	afterEach(() => clearActiveContainer());

	it("assertEmitted / assertNotEmitted / getEmitted forward to the active fake", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeBus, { bind: false });
			await f.emit("order.created", "{}");
			expect(() => assertEmitted("order.created")).not.toThrow();
			expect(() => assertNotEmitted("payment.received")).not.toThrow();
			expect(() => assertEmitted("payment.received")).toThrow(
				/stub.assertEmitted failed/,
			);
			expect(getEmitted()).toHaveLength(1);
		});
	});

	it("getRequests forwards", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeBus, { bind: false });
			await f.request("ping", "{}");
			expect(getRequests()).toHaveLength(1);
		});
	});

	it("reset is a no-op when no active fake (mirrors helix.relay.reset)", () => {
		expect(() => reset()).not.toThrow();
	});

	it("reset on the active fake clears its captured state without dropping the binding", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeBus, { bind: false });
			await f.emit("captured", "{}");
			expect(f.captured).toHaveLength(1);
			reset();
			expect(f.captured).toHaveLength(0);
			expect(f.resetCount).toBe(1);
			// Asymmetric contract: reset does NOT tear the fake down — current()
			// still returns it. Other forwarders are still callable.
			expect(current()).toBe(f);
			expect(getEmitted()).toEqual([]);
		});
	});

	it("forwarders throw when no active fake", () => {
		expect(() => assertEmitted("a")).toThrow(/no active fake/);
		expect(() => getEmitted()).toThrow(/no active fake/);
	});
});

describe("bus.fake — auto-restore + LIFO cleanup", () => {
	afterEach(() => clearActiveContainer());

	it("frame close clears activeFake AND restores container binding", async () => {
		const c = new Container();
		const real = { tag: "real" };
		c.singleton("bus", () => real);
		useContainer(c);

		await withTestContext(async () => {
			const f = fake(StubFakeBus);
			expect(current()).toBe(f);
			expect(c.resolve("bus")).toBe(f);
		});

		// activeFake cleared FIRST (registered after the container override
		// cleanup → LIFO drain runs it first), container restored SECOND.
		expect(current()).toBeNull();
		expect(c.resolve("bus")).toBe(real);
	});

	it("double-fake within the same frame swaps cleanly and restores the original post-frame", async () => {
		const c = new Container();
		const real = { tag: "real" };
		c.singleton("bus", () => real);
		useContainer(c);

		await withTestContext(async () => {
			const first = fake(StubFakeBus);
			await first.emit("alpha", "{}");
			const second = fake(StubFakeBus);
			expect(current()).toBe(second);
			expect(c.resolve("bus")).toBe(second);
			expect(second.getEmitted()).toHaveLength(0);
		});

		// LIFO drain must walk both override layers back to the original
		// singleton — neither fake should remain bound after the frame.
		expect(current()).toBeNull();
		expect(c.resolve("bus")).toBe(real);
	});

	it("restoring an absent binding does not leak (bind: false)", async () => {
		await withTestContext(async () => {
			fake(StubFakeBus, { bind: false });
			expect(current()).not.toBeNull();
		});
		expect(current()).toBeNull();
	});
});
