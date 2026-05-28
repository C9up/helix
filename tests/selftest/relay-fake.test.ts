/**
 * Self-test: `helix.relay.fake` end-to-end through the helix
 * runtime. Helix is agnostic — no `@c9up/relay` import.
 */

import {
	afterEach,
	clearActiveContainer,
	describe,
	expect,
	relay,
	test,
	useContainer,
} from "@c9up/helix";
import { Container } from "@c9up/ream";

class StubFakeRelay {
	captured: Array<{ channel: string; data: unknown }> = [];
	broadcast(channel: string, data: unknown): number {
		this.captured.push({ channel, data });
		return 0;
	}
	getSent(): unknown[] {
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

describe("helix.relay.fake — end-to-end", () => {
	afterEach(() => clearActiveContainer());

	test("fake + assertSent works under the helix runtime", () => {
		const c = new Container();
		c.singleton("relay", () => ({ real: true }));
		useContainer(c);
		const f = relay.fake(StubFakeRelay);
		f.broadcast("notifications", { msg: "hi" });
		relay.assertSent("notifications");
		expect(relay.getSent()).toHaveLength(1);
	});
});

describe("helix.relay — auto-clear between tests", () => {
	test("test A registers a fake and never clears it", () => {
		const c = new Container();
		c.singleton("relay", () => ({ real: true }));
		useContainer(c);
		relay.fake(StubFakeRelay);
		expect(relay.current()).not.toBeNull();
	});

	test("test B sees no active fake (auto-cleared after test A)", () => {
		expect(relay.current()).toBeNull();
	});
});
