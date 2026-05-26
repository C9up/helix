/**
 * Self-test: `helix.queue.fake` end-to-end through the helix runtime.
 *
 * Helix is agnostic — no `@c9up/bay` import. Local `StubFakeQueue`
 * mirrors Bay's `FakeQueue` shape. Auto-clear is verified by the
 * sequential A/B pattern (helix runtime sequences tests within a
 * describe via `runSuite`'s for-await loop).
 */

import {
	afterEach,
	clearActiveContainer,
	describe,
	expect,
	queue,
	test,
	useContainer,
} from "@c9up/helix";
import { Container } from "@c9up/ream";

interface CapturedJob {
	name: string;
	payload?: unknown;
}

class StubFakeQueue {
	captured: CapturedJob[] = [];
	async push(job: unknown): Promise<unknown> {
		this.captured.push(job as CapturedJob);
		return undefined;
	}
	getPushed(): CapturedJob[] {
		return this.captured.slice();
	}
	reset(): void {
		this.captured = [];
	}
	assertPushed(name: string): void {
		if (!this.captured.some((j) => j.name === name)) {
			throw new Error(`assertPushed failed: ${name}`);
		}
	}
	assertNotPushed(name: string): void {
		if (this.captured.some((j) => j.name === name)) {
			throw new Error(`assertNotPushed failed: ${name}`);
		}
	}
}

describe("helix.queue.fake — end-to-end through helix runtime", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	test("fake + assertPushed works under the helix runtime", async () => {
		const container = new Container();
		container.singleton("queue", () => ({ real: true }));
		useContainer(container);

		const f = queue.fake(StubFakeQueue);
		await f.push({ name: "send-email", payload: { to: "u@x.com" } });
		queue.assertPushed("send-email");
		expect(queue.getPushed()).toHaveLength(1);
	});

	test("fake auto-binds container; resolve returns the fake", async () => {
		const container = new Container();
		container.singleton("queue", () => ({ real: true }));
		useContainer(container);

		const f = queue.fake(StubFakeQueue);
		expect(container.resolve("queue")).toBe(f);
	});
});

describe("helix.queue — auto-clear between tests", () => {
	test("test A registers a fake and never clears it", () => {
		const container = new Container();
		container.singleton("queue", () => ({ real: true }));
		useContainer(container);
		queue.fake(StubFakeQueue);
		expect(queue.current()).not.toBeNull();
	});

	test("test B sees no active fake (auto-cleared after test A)", () => {
		expect(queue.current()).toBeNull();
	});
});

describe("helix.queue — forwarders without an active fake", () => {
	test("assertPushed / getPushed throw before any fake() call", () => {
		expect(() => queue.assertPushed("a")).toThrow(/no active fake/);
		expect(() => queue.getPushed()).toThrow(/no active fake/);
	});

	test("reset is idempotent — no-op when no active fake", () => {
		expect(() => queue.reset()).not.toThrow();
	});
});
