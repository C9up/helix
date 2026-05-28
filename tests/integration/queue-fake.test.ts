/**
 * Integration tests for `helix.queue.fake` (Story 42.6).
 *
 * Helix is agnostic — these tests do NOT import `@c9up/bay`. We
 * use a local `StubFakeQueue` to demonstrate the duck-typed
 * `QueueFakeLike` contract is sufficient.
 *
 * Direct port of `mail-fake.test.ts` from 42.5 with all the
 * review-batch lessons baked in upfront (C1 ordering test,
 * idempotent reset, double-fake cleanup, class-token bindToken,
 * inside-frame-without-fake throws).
 */

import { Container } from "@c9up/ream";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearActiveContainer,
	useContainer,
} from "../../src/container/override.js";
import type { QueueFakeLike } from "../../src/queue/fake.js";
import {
	assertNotPushed,
	assertPushed,
	current,
	fake,
	getPushed,
	reset,
} from "../../src/queue/fake.js";
import { withTestContext } from "../../src/runtime/test-context.js";

interface CapturedJob {
	id?: string;
	name: string;
	payload?: unknown;
}
interface StubPredicate {
	payloadMatches?: (p: unknown) => boolean;
}

/** Local stub satisfying `QueueFakeLike`. ~30 lines. */
class StubFakeQueue implements QueueFakeLike {
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
	assertPushed(name: string, predicate?: unknown): void {
		const match = (j: CapturedJob) => matches(j, name, predicate);
		if (!this.captured.some(match)) {
			throw new Error(`assertPushed failed: ${name}`);
		}
	}
	assertNotPushed(name: string, predicate?: unknown): void {
		const match = (j: CapturedJob) => matches(j, name, predicate);
		if (this.captured.some(match)) {
			throw new Error(`assertNotPushed failed: ${name}`);
		}
	}
}
function matches(j: CapturedJob, name: string, predicate: unknown): boolean {
	if (j.name !== name) return false;
	if (typeof predicate === "function") {
		return (predicate as (j: CapturedJob) => boolean)(j);
	}
	if (predicate && typeof predicate === "object") {
		const p = predicate as StubPredicate;
		if (p.payloadMatches && !p.payloadMatches(j.payload)) return false;
	}
	return true;
}

describe("queue.fake — instance creation", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("returns a fresh instance of the provided class", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeQueue, { bind: false });
			expect(f).toBeInstanceOf(StubFakeQueue);
		});
	});

	it("each call returns a distinct instance", async () => {
		await withTestContext(async () => {
			const a = fake(StubFakeQueue, { bind: false });
			const b = fake(StubFakeQueue, { bind: false });
			expect(a).not.toBe(b);
		});
	});

	it("throws when called outside a test frame", () => {
		expect(() => fake(StubFakeQueue, { bind: false })).toThrow(/inside a test/);
	});

	it("double-fake within one frame: both cleanups run, container fully restored", async () => {
		const container = new Container();
		const realQueue = { tag: "real" };
		container.singleton("queue", () => realQueue);
		useContainer(container);

		await withTestContext(async () => {
			const a = fake(StubFakeQueue);
			expect(container.resolve("queue")).toBe(a);
			const b = fake(StubFakeQueue);
			expect(container.resolve("queue")).toBe(b);
			expect(current()).toBe(b);
		});

		expect(current()).toBeNull();
		expect(container.resolve("queue")).toBe(realQueue);
	});
});

describe("queue.fake — container binding", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("auto-binds to the active container as 'queue' by default", async () => {
		const container = new Container();
		container.singleton("queue", () => ({ real: true }));
		useContainer(container);

		await withTestContext(async () => {
			const f = fake(StubFakeQueue);
			expect(container.resolve("queue")).toBe(f);
		});

		expect((container.resolve("queue") as { real?: boolean }).real).toBe(true);
	});

	it("bindToken overrides the default 'queue' token", async () => {
		const container = new Container();
		const symToken = Symbol.for("helix-test/queue-driver");
		container.singleton(symToken, () => ({ tag: "real" }));
		useContainer(container);

		await withTestContext(async () => {
			const f = fake(StubFakeQueue, { bindToken: symToken });
			expect(container.resolve(symToken)).toBe(f);
		});
	});

	it("bindToken accepts a class token (constructor)", async () => {
		class JobQueue {
			push(): void {}
		}
		const container = new Container();
		container.singleton(JobQueue, () => new JobQueue());
		useContainer(container);

		await withTestContext(async () => {
			const f = fake(StubFakeQueue, { bindToken: JobQueue });
			expect(container.resolve<JobQueue>(JobQueue)).toBe(f);
		});
	});

	it("bind: false skips the container override entirely", async () => {
		const container = new Container();
		const realInstance = { tag: "real" };
		container.singleton("queue", () => realInstance);
		useContainer(container);

		await withTestContext(async () => {
			fake(StubFakeQueue, { bind: false });
			expect(container.resolve("queue")).toBe(realInstance);
		});
	});

	it("container option targets a specific container", async () => {
		const c1 = new Container();
		const c2 = new Container();
		c1.singleton("queue", () => ({ which: "c1" }));
		c2.singleton("queue", () => ({ which: "c2" }));
		useContainer(c1);

		await withTestContext(async () => {
			const f = fake(StubFakeQueue, { container: c2 });
			expect(c2.resolve("queue")).toBe(f);
			expect((c1.resolve("queue") as { which: string }).which).toBe("c1");
		});
	});

	it("default bind without active container throws (cascade through helix.override)", async () => {
		await withTestContext(async () => {
			expect(() => fake(StubFakeQueue)).toThrow(/no active container/);
		});
	});

	it("failed bind does NOT pollute activeFake (C1 — review fix)", async () => {
		await withTestContext(async () => {
			expect(() => fake(StubFakeQueue)).toThrow(/no active container/);
			expect(current()).toBeNull();
		});
		expect(current()).toBeNull();
	});
});

describe("queue.fake — forwarding surface", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("assertPushed forwards correctly", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeQueue, { bind: false });
			await f.push({ name: "send-email", payload: { to: "u@x.com" } });
			expect(() => assertPushed("send-email")).not.toThrow();
			expect(() => assertPushed("process-payment")).toThrow(
				/assertPushed failed/,
			);
		});
	});

	it("assertPushed with predicate narrows the match", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeQueue, { bind: false });
			await f.push({ name: "notify", payload: { userId: 1 } });
			expect(() =>
				assertPushed("notify", {
					payloadMatches: (p: unknown) =>
						(p as { userId: number }).userId === 1,
				}),
			).not.toThrow();
			expect(() =>
				assertPushed("notify", {
					payloadMatches: (p: unknown) =>
						(p as { userId: number }).userId === 99,
				}),
			).toThrow(/assertPushed failed/);
		});
	});

	it("assertNotPushed forwards correctly", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeQueue, { bind: false });
			await f.push({ name: "a" });
			expect(() => assertNotPushed("b")).not.toThrow();
			expect(() => assertNotPushed("a")).toThrow(/assertNotPushed failed/);
		});
	});

	it("getPushed returns the captured array", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeQueue, { bind: false });
			await f.push({ name: "a" });
			await f.push({ name: "b" });
			const pushed = getPushed() as CapturedJob[];
			expect(pushed).toHaveLength(2);
			expect(pushed[0].name).toBe("a");
		});
	});

	it("reset clears the captured array", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeQueue, { bind: false });
			await f.push({ name: "a" });
			expect(getPushed()).toHaveLength(1);
			reset();
			expect(getPushed()).toHaveLength(0);
		});
	});

	it("assert/getPushed forwarders throw when no active fake (outside frame)", () => {
		expect(() => assertPushed("a")).toThrow(/no active fake/);
		expect(() => assertNotPushed("a")).toThrow(/no active fake/);
		expect(() => getPushed()).toThrow(/no active fake/);
	});

	it("assert/getPushed forwarders throw inside a frame too if fake() was never called", async () => {
		await withTestContext(async () => {
			expect(() => assertPushed("a")).toThrow(/no active fake/);
			expect(() => assertNotPushed("a")).toThrow(/no active fake/);
			expect(() => getPushed()).toThrow(/no active fake/);
		});
	});

	it("reset() is idempotent — no-op when no active fake", () => {
		expect(() => reset()).not.toThrow();
	});

	it("reset() inside a frame without a fake is a no-op", async () => {
		await withTestContext(async () => {
			expect(() => reset()).not.toThrow();
		});
	});
});

describe("queue.current — introspection", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("returns null when no fake is active", () => {
		expect(current()).toBeNull();
	});

	it("returns the active instance after fake()", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeQueue, { bind: false });
			expect(current()).toBe(f);
		});
	});

	it("returns null after the frame closes (auto-clear)", async () => {
		await withTestContext(async () => {
			fake(StubFakeQueue, { bind: false });
			expect(current()).not.toBeNull();
		});
		expect(current()).toBeNull();
	});
});

describe("queue.fake — composition with 42.3 container override", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("auto-restores both activeFake AND container binding", async () => {
		const container = new Container();
		const realQueue = { tag: "real-queue" };
		container.singleton("queue", () => realQueue);
		useContainer(container);

		await withTestContext(async () => {
			const f = fake(StubFakeQueue);
			expect(container.resolve("queue")).toBe(f);
			expect(current()).toBe(f);
		});

		expect(current()).toBeNull();
		expect(container.resolve("queue")).toBe(realQueue);
	});
});
