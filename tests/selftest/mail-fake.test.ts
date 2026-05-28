/**
 * Self-test: `helix.mail.fake` end-to-end through the helix runtime.
 *
 * Helix is agnostic — no `@c9up/rover` import. We use a local
 * `StubFakeMail` (same shape as the integration test). Auto-clear
 * is verified by two sequential tests sharing nothing — test A
 * registers a fake and never clears it explicitly, test B asserts
 * `mail.current() === null` (proven via the per-test
 * `withTestContext` frame).
 */

import {
	afterEach,
	clearActiveContainer,
	describe,
	expect,
	mail,
	test,
	useContainer,
} from "@c9up/helix";
import { Container } from "@c9up/ream";

interface CapturedMessage {
	to?: string;
	subject?: string;
	body?: string;
}
interface StubPredicate {
	to?: string;
	subject?: string;
}
class StubFakeMail {
	captured: CapturedMessage[] = [];
	async send(message: unknown): Promise<unknown> {
		this.captured.push(message as CapturedMessage);
		return undefined;
	}
	getSent(): CapturedMessage[] {
		return this.captured.slice();
	}
	reset(): void {
		this.captured = [];
	}
	assertSent(predicate: unknown): void {
		const p = predicate as StubPredicate;
		if (!this.captured.some((m) => match(m, p))) {
			throw new Error(`assertSent failed: ${JSON.stringify(p)}`);
		}
	}
	assertNotSent(predicate: unknown): void {
		const p = predicate as StubPredicate;
		if (this.captured.some((m) => match(m, p))) {
			throw new Error(`assertNotSent failed: ${JSON.stringify(p)}`);
		}
	}
}
function match(m: CapturedMessage, p: StubPredicate): boolean {
	if (p.to !== undefined && m.to !== p.to) return false;
	if (p.subject !== undefined && m.subject !== p.subject) return false;
	return true;
}

describe("helix.mail.fake — end-to-end through helix runtime", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	test("fake + assertSent works under the helix runtime", async () => {
		const container = new Container();
		container.singleton("mail", () => ({ real: true }));
		useContainer(container);

		const f = mail.fake(StubFakeMail);
		await f.send({ to: "u@x.com", subject: "Welcome" });
		mail.assertSent({ to: "u@x.com", subject: "Welcome" });
		expect(mail.getSent()).toHaveLength(1);
	});

	test("fake auto-binds container; resolve returns the fake", async () => {
		const container = new Container();
		container.singleton("mail", () => ({ real: true }));
		useContainer(container);

		const f = mail.fake(StubFakeMail);
		expect(container.resolve("mail")).toBe(f);
	});
});

describe("helix.mail — auto-clear between tests", () => {
	test("test A registers a fake and never clears it", () => {
		const container = new Container();
		container.singleton("mail", () => ({ real: true }));
		useContainer(container);
		mail.fake(StubFakeMail);
		expect(mail.current()).not.toBeNull();
	});

	test("test B sees no active fake (auto-cleared after test A)", () => {
		expect(mail.current()).toBeNull();
	});
});

describe("helix.mail — forwarders without an active fake", () => {
	test("assertSent / getSent throw before any fake() call", () => {
		expect(() => mail.assertSent({})).toThrow(/no active fake/);
		expect(() => mail.getSent()).toThrow(/no active fake/);
	});

	test("reset is idempotent — no-op when no active fake", () => {
		expect(() => mail.reset()).not.toThrow();
	});
});
