/**
 * Integration tests for `helix.nova.fake` (Story 48.5).
 *
 * Helix is agnostic — these tests do NOT import `@c9up/nova`. We
 * use a local `StubFakeNova` to demonstrate that the duck-typed
 * `NovaFakeLike` contract is sufficient. Any class with the same
 * shape (Nova's `FakeNova`, a hand-rolled stub, a different
 * framework's fake) plugs in identically.
 *
 * Mirror of `mail-fake.test.ts` from Story 42.5.
 */

import { Container } from "@c9up/ream";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearActiveContainer,
	useContainer,
} from "../../src/container/override.js";
import type { NovaFakeLike } from "../../src/nova/fake.js";
import {
	assertNotPushed,
	assertPushed,
	current,
	fake,
	getPushed,
	reset,
} from "../../src/nova/fake.js";
import { withTestContext } from "../../src/runtime/test-context.js";

/** Local stub that satisfies `NovaFakeLike`. Mirrors Nova's
 *  `FakeNova` surface but is import-free so the test suite proves
 *  helix really is agnostic. */
interface CapturedCall {
	kind: "single" | "fan-out";
	userId?: string;
	endpoint?: string;
	title?: string;
}
interface StubPredicate {
	userId?: string;
	endpoint?: string;
	title?: string;
}
class StubFakeNova implements NovaFakeLike {
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
		const match = this.captured.some((c) => matches(c, p));
		if (!match) {
			throw new Error(`assertPushed failed: ${JSON.stringify(p)}`);
		}
	}
	assertNotPushed(predicate: unknown): void {
		const p = predicate as StubPredicate;
		const match = this.captured.find((c) => matches(c, p));
		if (match) {
			throw new Error(
				`assertNotPushed failed: matched ${JSON.stringify(match)}`,
			);
		}
	}
}
function matches(c: CapturedCall, p: StubPredicate): boolean {
	if (p.userId !== undefined && c.userId !== p.userId) return false;
	if (p.endpoint !== undefined && c.endpoint !== p.endpoint) return false;
	if (p.title !== undefined && c.title !== p.title) return false;
	return true;
}

describe("nova.fake — instance creation", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("returns a fresh instance of the provided class", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeNova, { bind: false });
			expect(f).toBeInstanceOf(StubFakeNova);
		});
	});

	it("each call returns a distinct instance (no implicit reuse)", async () => {
		await withTestContext(async () => {
			const a = fake(StubFakeNova, { bind: false });
			const b = fake(StubFakeNova, { bind: false });
			expect(a).not.toBe(b);
		});
	});

	it("throws when called outside a test frame", () => {
		expect(() => fake(StubFakeNova, { bind: false })).toThrow(/inside a test/);
	});

	it("double-fake within one frame: both cleanups run, container fully restored", async () => {
		const container = new Container();
		const realNova = { tag: "real" };
		container.singleton("nova", () => realNova);
		useContainer(container);

		await withTestContext(async () => {
			const a = fake(StubFakeNova);
			expect(container.resolve("nova")).toBe(a);
			const b = fake(StubFakeNova);
			expect(container.resolve("nova")).toBe(b);
			expect(current()).toBe(b);
		});

		expect(current()).toBeNull();
		expect(container.resolve("nova")).toBe(realNova);
	});
});

describe("nova.fake — container binding", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("auto-binds to the active container as 'nova' by default", async () => {
		const container = new Container();
		container.singleton("nova", () => ({ real: true }));
		useContainer(container);

		await withTestContext(async () => {
			const f = fake(StubFakeNova);
			expect(container.resolve("nova")).toBe(f);
		});

		expect((container.resolve("nova") as { real?: boolean }).real).toBe(true);
	});

	it("bindToken overrides the default 'nova' token", async () => {
		const container = new Container();
		const symToken = Symbol.for("helix-test/nova-instance");
		container.singleton(symToken, () => ({ tag: "real" }));
		useContainer(container);

		await withTestContext(async () => {
			const f = fake(StubFakeNova, { bindToken: symToken });
			expect(container.resolve(symToken)).toBe(f);
		});
	});

	it("bindToken on a never-bound token: end-of-frame restore does not leak the override", async () => {
		const container = new Container();
		const neverBound = Symbol.for("helix-test/nova-never-bound");
		// NO singleton registered for `neverBound` — `helix.override`
		// snapshots the absence then restores it after the frame.
		useContainer(container);

		await withTestContext(async () => {
			const f = fake(StubFakeNova, { bindToken: neverBound });
			expect(container.resolve(neverBound)).toBe(f);
		});

		// After the frame: the token is back to its prior state — namely,
		// not bound. Resolving it should throw rather than serve the fake.
		expect(() => container.resolve(neverBound)).toThrow(
			/CONTAINER_NOT_FOUND|No binding found/,
		);
	});

	it("bind: false skips the container override entirely", async () => {
		const container = new Container();
		const realInstance = { tag: "real" };
		container.singleton("nova", () => realInstance);
		useContainer(container);

		await withTestContext(async () => {
			fake(StubFakeNova, { bind: false });
			expect(container.resolve("nova")).toBe(realInstance);
		});
	});

	it("default bind without active container throws (cascade through helix.override)", async () => {
		await withTestContext(async () => {
			expect(() => fake(StubFakeNova)).toThrow(/no active container/);
		});
	});
});

describe("nova.fake — forwarders", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("assertPushed / assertNotPushed / getPushed work through the forwarders", async () => {
		const container = new Container();
		container.singleton("nova", () => ({ real: true }));
		useContainer(container);

		await withTestContext(async () => {
			const f = fake(StubFakeNova);
			await f.pushToUser("user-A", { title: "Welcome" });
			assertPushed({ userId: "user-A" });
			assertNotPushed({ userId: "user-B" });
			expect(getPushed()).toHaveLength(1);
		});
	});

	it("forwarders throw when called before any fake() (assertions / getPushed)", () => {
		expect(() => assertPushed({})).toThrow(/no active fake/);
		expect(() => assertNotPushed({})).toThrow(/no active fake/);
		expect(() => getPushed()).toThrow(/no active fake/);
	});

	it("reset() is idempotent — no-op when no active fake (documented exception)", () => {
		expect(() => reset()).not.toThrow();
	});

	it("reset() clears captures while keeping the fake active", async () => {
		const container = new Container();
		container.singleton("nova", () => ({ real: true }));
		useContainer(container);

		await withTestContext(async () => {
			const f = fake(StubFakeNova);
			await f.pushToUser("user-A", { title: "x" });
			expect(getPushed()).toHaveLength(1);
			reset();
			expect(getPushed()).toHaveLength(0);
			expect(current()).toBe(f);
		});
	});
});

describe("nova.fake — auto-clear between frames", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("frame A registers a fake; frame B sees no active fake", async () => {
		const container = new Container();
		container.singleton("nova", () => ({ real: true }));
		useContainer(container);

		await withTestContext(async () => {
			fake(StubFakeNova);
			expect(current()).not.toBeNull();
		});
		// Outside the frame: cleanup ran, current() is null.
		expect(current()).toBeNull();

		// Second frame: starts clean.
		await withTestContext(async () => {
			expect(current()).toBeNull();
		});
	});
});
