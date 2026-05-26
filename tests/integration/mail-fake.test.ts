/**
 * Integration tests for `helix.mail.fake` (Story 42.5).
 *
 * Helix is agnostic — these tests do NOT import `@c9up/rover`. We
 * use a local `StubFakeMail` to demonstrate that the duck-typed
 * `MailFakeLike` contract is sufficient. Any class with the same
 * shape (Rover's `FakeMail`, a hand-rolled stub, a different
 * framework's fake) plugs in identically.
 */

import { Container } from "@c9up/ream";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearActiveContainer,
	useContainer,
} from "../../src/container/override.js";
import type { MailFakeLike } from "../../src/mail/fake.js";
import {
	assertNotSent,
	assertSent,
	current,
	fake,
	getSent,
	reset,
} from "../../src/mail/fake.js";
import { withTestContext } from "../../src/runtime/test-context.js";

/**
 * Local stub that satisfies `MailFakeLike`. Mirrors Rover's
 * `FakeMail` surface but is import-free so the test suite proves
 * helix really is agnostic. ~30 lines.
 */
interface CapturedMessage {
	to?: string;
	subject?: string;
	body?: string;
}
interface StubPredicate {
	to?: string;
	subject?: string;
	containing?: string;
}
class StubFakeMail implements MailFakeLike {
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
		const match = this.captured.some((m) => matches(m, p));
		if (!match) {
			throw new Error(`assertSent failed: ${JSON.stringify(p)}`);
		}
	}
	assertNotSent(predicate: unknown): void {
		const p = predicate as StubPredicate;
		const match = this.captured.find((m) => matches(m, p));
		if (match) {
			throw new Error(`assertNotSent failed: matched ${JSON.stringify(match)}`);
		}
	}
}
function matches(m: CapturedMessage, p: StubPredicate): boolean {
	if (p.to !== undefined && m.to !== p.to) return false;
	if (p.subject !== undefined && m.subject !== p.subject) return false;
	if (p.containing !== undefined && !(m.body ?? "").includes(p.containing)) {
		return false;
	}
	return true;
}

describe("mail.fake — instance creation", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("returns a fresh instance of the provided class", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeMail, { bind: false });
			expect(f).toBeInstanceOf(StubFakeMail);
		});
	});

	it("each call returns a distinct instance (no implicit reuse)", async () => {
		await withTestContext(async () => {
			const a = fake(StubFakeMail, { bind: false });
			const b = fake(StubFakeMail, { bind: false });
			expect(a).not.toBe(b);
		});
	});

	it("double-fake within one frame: both cleanups run, container is fully restored", async () => {
		const container = new Container();
		const realMail = { tag: "real" };
		container.singleton("mail", () => realMail);
		useContainer(container);

		await withTestContext(async () => {
			const a = fake(StubFakeMail);
			expect(container.resolve("mail")).toBe(a);
			const b = fake(StubFakeMail);
			expect(container.resolve("mail")).toBe(b);
			expect(current()).toBe(b);
		});

		// Both `mail.fake` cleanups + both `helix.override` cleanups
		// fire in reverse insertion order. Container's value-based
		// override + 42.3-M7 singleton-identity preservation: the
		// second `override` snapshots `a` (the prior override), the
		// first snapshots `realMail`. LIFO restore brings back `a`,
		// then `realMail`. Final state: real.
		expect(current()).toBeNull();
		expect(container.resolve("mail")).toBe(realMail);
	});

	it("throws when called outside a test frame", () => {
		expect(() => fake(StubFakeMail, { bind: false })).toThrow(/inside a test/);
	});
});

describe("mail.fake — container binding", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("auto-binds to the active container as 'mail' by default", async () => {
		const container = new Container();
		container.singleton("mail", () => ({
			send: async () => undefined,
			real: true,
		}));
		useContainer(container);

		await withTestContext(async () => {
			const f = fake(StubFakeMail);
			expect(container.resolve("mail")).toBe(f);
		});

		// 42.3's auto-restore reverts the binding after the frame.
		expect((container.resolve("mail") as { real?: boolean }).real).toBe(true);
	});

	it("bindToken overrides the default 'mail' token", async () => {
		const container = new Container();
		const symToken = Symbol.for("helix-test/mail-transport");
		container.singleton(symToken, () => ({ tag: "real" }));
		useContainer(container);

		await withTestContext(async () => {
			const f = fake(StubFakeMail, { bindToken: symToken });
			expect(container.resolve(symToken)).toBe(f);
		});
	});

	it("bind: false skips the container override entirely", async () => {
		const container = new Container();
		const realInstance = { tag: "real" };
		container.singleton("mail", () => realInstance);
		useContainer(container);

		await withTestContext(async () => {
			fake(StubFakeMail, { bind: false });
			// Container's 'mail' is untouched.
			expect(container.resolve("mail")).toBe(realInstance);
		});
	});

	it("container option targets a specific container instance", async () => {
		const c1 = new Container();
		const c2 = new Container();
		c1.singleton("mail", () => ({ which: "c1" }));
		c2.singleton("mail", () => ({ which: "c2" }));
		useContainer(c1);

		await withTestContext(async () => {
			const f = fake(StubFakeMail, { container: c2 });
			expect(c2.resolve("mail")).toBe(f);
			// c1 (the active one) is untouched.
			expect((c1.resolve("mail") as { which: string }).which).toBe("c1");
		});
	});

	it("default bind without active container throws (cascade through helix.override)", async () => {
		await withTestContext(async () => {
			expect(() => fake(StubFakeMail)).toThrow(/no active container/);
		});
	});

	it("failed bind does NOT pollute activeFake (C1 — review fix)", async () => {
		// Reproduces the original C1 bug: before the fix, `activeFake`
		// was set BEFORE the bind ran, so a thrown bind ('no active
		// container') left the slot populated permanently. Now the bind
		// runs first; the slot is only mutated after success.
		await withTestContext(async () => {
			expect(() => fake(StubFakeMail)).toThrow(/no active container/);
			expect(current()).toBeNull();
		});
		expect(current()).toBeNull();
	});

	it("bindToken accepts a class token (constructor)", async () => {
		class MailService {
			send(): string {
				return "real";
			}
		}
		const container = new Container();
		container.singleton(MailService, () => new MailService());
		useContainer(container);

		await withTestContext(async () => {
			const f = fake(StubFakeMail, { bindToken: MailService });
			expect(container.resolve<MailService>(MailService)).toBe(f);
		});
	});
});

describe("mail.fake — forwarding surface", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("assertSent forwards correctly", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeMail, { bind: false });
			await f.send({ to: "u@x.com", subject: "Hi", body: "Welcome" });
			expect(() => assertSent({ to: "u@x.com", subject: "Hi" })).not.toThrow();
			expect(() => assertSent({ to: "other@x.com" })).toThrow(
				/assertSent failed/,
			);
		});
	});

	it("assertNotSent forwards correctly", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeMail, { bind: false });
			await f.send({ to: "u@x.com", subject: "Hi" });
			expect(() => assertNotSent({ to: "other@x.com" })).not.toThrow();
			expect(() => assertNotSent({ to: "u@x.com" })).toThrow(
				/assertNotSent failed/,
			);
		});
	});

	it("getSent returns the captured array", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeMail, { bind: false });
			await f.send({ to: "a@x.com", subject: "1" });
			await f.send({ to: "b@x.com", subject: "2" });
			const sent = getSent() as CapturedMessage[];
			expect(sent).toHaveLength(2);
			expect(sent[0].to).toBe("a@x.com");
		});
	});

	it("reset clears the captured array", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeMail, { bind: false });
			await f.send({ to: "a@x.com", subject: "1" });
			expect(getSent()).toHaveLength(1);
			reset();
			expect(getSent()).toHaveLength(0);
		});
	});

	it("assert/getSent forwarders throw when no active fake (outside frame)", () => {
		// Outside any frame, no fake has been registered.
		expect(() => assertSent({})).toThrow(/no active fake/);
		expect(() => assertNotSent({})).toThrow(/no active fake/);
		expect(() => getSent()).toThrow(/no active fake/);
	});

	it("assert/getSent forwarders throw inside a frame too if fake() was never called", async () => {
		// The realistic user mistake: caller opens a test frame, forgets
		// to register a fake, then writes `assertSent`. Must throw the
		// same way as the outside-frame case.
		await withTestContext(async () => {
			expect(() => assertSent({})).toThrow(/no active fake/);
			expect(() => assertNotSent({})).toThrow(/no active fake/);
			expect(() => getSent()).toThrow(/no active fake/);
		});
	});

	it("reset() is idempotent — no-op when no active fake", () => {
		// `reset` is documented to be safe to call from teardown blocks.
		// Calling it without a registered fake should NOT throw.
		expect(() => reset()).not.toThrow();
	});

	it("reset() inside a frame without a fake is a no-op", async () => {
		await withTestContext(async () => {
			expect(() => reset()).not.toThrow();
		});
	});
});

describe("mail.current — introspection", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("returns null when no fake is active", () => {
		expect(current()).toBeNull();
	});

	it("returns the active instance after fake()", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeMail, { bind: false });
			expect(current()).toBe(f);
		});
	});

	it("returns null after the frame closes (auto-clear)", async () => {
		await withTestContext(async () => {
			fake(StubFakeMail, { bind: false });
			expect(current()).not.toBeNull();
		});
		expect(current()).toBeNull();
	});
});

describe("mail.fake — composition with 42.3 container override", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("auto-restores both the activeFake AND the container binding", async () => {
		const container = new Container();
		const realMail = { tag: "real-mail" };
		container.singleton("mail", () => realMail);
		useContainer(container);

		await withTestContext(async () => {
			const f = fake(StubFakeMail);
			expect(container.resolve("mail")).toBe(f);
			expect(current()).toBe(f);
		});

		// Frame closed: BOTH cleanups fired.
		expect(current()).toBeNull();
		expect(container.resolve("mail")).toBe(realMail);
	});
});
