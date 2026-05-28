/**
 * Self-test: `helix.nova.fake` end-to-end through the helix runtime.
 *
 * Helix is agnostic — no `@c9up/nova` import. We use a local
 * `StubFakeNova` (same shape as the integration test). Auto-clear
 * is verified by two sequential tests: test A registers a fake and
 * never clears it explicitly, test B asserts `nova.current() === null`.
 *
 * Mirror of `mail-fake.test.ts` self-test (Story 42.5).
 */

import {
	afterEach,
	clearActiveContainer,
	describe,
	expect,
	nova,
	test,
	useContainer,
} from "@c9up/helix";
import { Container } from "@c9up/ream";

interface CapturedCall {
	kind: "single" | "fan-out";
	userId?: string;
	endpoint?: string;
	title?: string;
}
interface StubPredicate {
	userId?: string;
	title?: string;
}
class StubFakeNova {
	captured: CapturedCall[] = [];
	async push(subscription: unknown, payload: unknown): Promise<unknown> {
		const sub = subscription as { endpoint: string };
		const p = payload as { title?: string };
		this.captured.push({
			kind: "single",
			endpoint: sub.endpoint,
			title: p.title,
		});
		return { ok: true, status: 201, endpoint: sub.endpoint };
	}
	async pushToUser(userId: string, payload: unknown): Promise<unknown[]> {
		const p = payload as { title?: string };
		this.captured.push({ kind: "fan-out", userId, title: p.title });
		return [];
	}
	getPushed(): CapturedCall[] {
		return this.captured.slice();
	}
	reset(): void {
		this.captured = [];
	}
	assertPushed(predicate: unknown): void {
		const p = predicate as StubPredicate;
		if (!this.captured.some((c) => match(c, p))) {
			throw new Error(`assertPushed failed: ${JSON.stringify(p)}`);
		}
	}
	assertNotPushed(predicate: unknown): void {
		const p = predicate as StubPredicate;
		if (this.captured.some((c) => match(c, p))) {
			throw new Error(`assertNotPushed failed: ${JSON.stringify(p)}`);
		}
	}
}
function match(c: CapturedCall, p: StubPredicate): boolean {
	if (p.userId !== undefined && c.userId !== p.userId) return false;
	if (p.title !== undefined && c.title !== p.title) return false;
	return true;
}

describe("helix.nova.fake — end-to-end through helix runtime", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	test("fake + assertPushed works under the helix runtime", async () => {
		const container = new Container();
		container.singleton("nova", () => ({ real: true }));
		useContainer(container);

		const f = nova.fake(StubFakeNova);
		await f.pushToUser("user-A", { title: "Welcome" });
		nova.assertPushed({ userId: "user-A", title: "Welcome" });
		expect(nova.getPushed()).toHaveLength(1);
	});

	test("fake auto-binds container; resolve returns the fake", async () => {
		const container = new Container();
		container.singleton("nova", () => ({ real: true }));
		useContainer(container);

		const f = nova.fake(StubFakeNova);
		expect(container.resolve("nova")).toBe(f);
	});
});

describe("helix.nova — auto-clear between tests", () => {
	test("test A registers a fake and never clears it", () => {
		const container = new Container();
		container.singleton("nova", () => ({ real: true }));
		useContainer(container);
		nova.fake(StubFakeNova);
		expect(nova.current()).not.toBeNull();
	});

	test("test B sees no active fake (auto-cleared after test A)", () => {
		expect(nova.current()).toBeNull();
	});
});

describe("helix.nova — forwarders without an active fake", () => {
	test("assertPushed / getPushed throw before any fake() call", () => {
		expect(() => nova.assertPushed({})).toThrow(/no active fake/);
		expect(() => nova.getPushed()).toThrow(/no active fake/);
	});

	test("reset is idempotent — no-op when no active fake", () => {
		expect(() => nova.reset()).not.toThrow();
	});
});
