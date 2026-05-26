/**
 * Integration tests for `helix.relay.fake` (Story 42.7).
 *
 * Helix is agnostic — no `@c9up/relay` import. Local
 * `StubFakeRelay` proves the duck-typed contract.
 */

import { Container } from "@c9up/ream";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearActiveContainer,
	useContainer,
} from "../../src/container/override.js";
import type { RelayFakeLike } from "../../src/relay/fake.js";
import {
	assertNotSent,
	assertSent,
	current,
	fake,
	getSent,
	reset,
} from "../../src/relay/fake.js";
import { withTestContext } from "../../src/runtime/test-context.js";

interface StubBroadcast {
	channel: string;
	data: unknown;
}
class StubFakeRelay implements RelayFakeLike {
	captured: StubBroadcast[] = [];
	broadcast(channel: string, data: unknown): number {
		this.captured.push({ channel, data });
		return 0;
	}
	getSent(): StubBroadcast[] {
		return this.captured.slice();
	}
	reset(): void {
		this.captured = [];
	}
	assertSent(channel: string): void {
		if (!this.captured.some((c) => c.channel === channel)) {
			throw new Error(`assertSent failed: ${channel}`);
		}
	}
	assertNotSent(channel: string): void {
		if (this.captured.some((c) => c.channel === channel)) {
			throw new Error(`assertNotSent failed: ${channel}`);
		}
	}
}

describe("relay.fake — instance + binding", () => {
	afterEach(() => clearActiveContainer());

	it("returns a fresh instance", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeRelay, { bind: false });
			expect(f).toBeInstanceOf(StubFakeRelay);
		});
	});

	it("auto-binds to active container as 'relay'", async () => {
		const c = new Container();
		c.singleton("relay", () => ({ real: true }));
		useContainer(c);
		await withTestContext(async () => {
			const f = fake(StubFakeRelay);
			expect(c.resolve("relay")).toBe(f);
		});
	});

	it("throws outside test frame", () => {
		expect(() => fake(StubFakeRelay, { bind: false })).toThrow(/inside a test/);
	});

	it("failed bind does NOT pollute activeFake (C1)", async () => {
		await withTestContext(async () => {
			expect(() => fake(StubFakeRelay)).toThrow(/no active container/);
			expect(current()).toBeNull();
		});
	});
});

describe("relay.fake — forwarders", () => {
	afterEach(() => clearActiveContainer());

	it("assertSent / assertNotSent / getSent forward correctly", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeRelay, { bind: false });
			f.broadcast("notifications", { msg: "hi" });
			expect(() => assertSent("notifications")).not.toThrow();
			expect(() => assertNotSent("comments")).not.toThrow();
			expect(() => assertSent("comments")).toThrow(/assertSent failed/);
			expect(getSent()).toHaveLength(1);
		});
	});

	it("reset is idempotent", () => {
		expect(() => reset()).not.toThrow();
	});

	it("forwarders throw when no active fake", () => {
		expect(() => assertSent("a")).toThrow(/no active fake/);
		expect(() => getSent()).toThrow(/no active fake/);
	});
});

describe("relay.fake — auto-restore", () => {
	afterEach(() => clearActiveContainer());

	it("frame close clears activeFake + restores container", async () => {
		const c = new Container();
		const real = { tag: "real" };
		c.singleton("relay", () => real);
		useContainer(c);

		await withTestContext(async () => {
			const f = fake(StubFakeRelay);
			expect(current()).toBe(f);
		});

		expect(current()).toBeNull();
		expect(c.resolve("relay")).toBe(real);
	});

	it("double-fake within the same frame swaps cleanly", async () => {
		const c = new Container();
		c.singleton("relay", () => ({ real: true }));
		useContainer(c);

		await withTestContext(async () => {
			const first = fake(StubFakeRelay);
			first.broadcast("alpha", { n: 1 });
			const second = fake(StubFakeRelay);
			expect(current()).toBe(second);
			expect(c.resolve("relay")).toBe(second);
			expect(second.getSent()).toHaveLength(0);
		});
	});
});
