/**
 * Self-test: `helix.bus.fake` end-to-end through the helix runtime.
 * Helix is agnostic — no `@c9up/pulsar` import.
 */

import {
	afterEach,
	bus,
	clearActiveContainer,
	describe,
	expect,
	test,
	useContainer,
} from "@c9up/helix";
import { Container } from "@c9up/ream";

class StubFakeBus {
	captured: Array<{ name: string; data: string }> = [];
	subId = 0;
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
	onRequest(): void {}
	request(): Promise<string> {
		return Promise.resolve("");
	}
	matchesWildcard(p: string, n: string): boolean {
		return p === n || p === "**";
	}
	subscriptionCount(): Promise<number> {
		return Promise.resolve(this.subId);
	}
	getEmitted(): unknown[] {
		return this.captured.slice();
	}
	getRequests(): unknown[] {
		return [];
	}
	reset(): void {
		this.captured = [];
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

describe("helix.bus.fake — end-to-end", () => {
	afterEach(() => clearActiveContainer());

	test("fake + assertEmitted works under the helix runtime", async () => {
		const c = new Container();
		c.singleton("bus", () => ({ real: true }));
		useContainer(c);
		const f = bus.fake(StubFakeBus);
		// Prove the container override actually swapped the `"bus"` binding —
		// otherwise the test could green-pass on the fake's internal capture
		// while production code resolving through the container still hit the
		// real bus.
		expect(c.resolve("bus")).toBe(f);
		await f.emit("order.created", "{}");
		bus.assertEmitted("order.created");
		expect(bus.getEmitted()).toHaveLength(1);
	});
});

// Two-test pattern: test A registers a fake and intentionally never clears
// it. Test B asserts the framework's per-test cleanup pump auto-clears
// `activeFake`. The `testARan` guard surfaces a clear failure if test B is
// somehow run in isolation (e.g. `test.only(testB)`), preventing a silent
// false-pass — the contract is meaningless without test A executing first.
let testARan = false;

describe("helix.bus — auto-clear between tests", () => {
	test("test A registers a fake and never clears it", () => {
		const c = new Container();
		c.singleton("bus", () => ({ real: true }));
		useContainer(c);
		bus.fake(StubFakeBus);
		expect(bus.current()).not.toBeNull();
		testARan = true;
	});

	test("test B sees no active fake (auto-cleared after test A)", () => {
		expect(testARan, "test B requires test A to have run first").toBe(true);
		expect(bus.current()).toBeNull();
	});
});
