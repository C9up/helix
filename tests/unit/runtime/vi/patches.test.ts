/**
 * Coverage for the review patches applied on 2026-04-24: `this` forwarding
 * in spyOn, per-context system time, Vitest-parity mock semantics, timer
 * edge cases, AC 8 isolation test, etc.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	resetFallbackState,
	vi,
	withViContext,
} from "../../../../src/runtime/vi/index.js";

describe("vi patches — spyOn `this` forwarding", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetFallbackState();
	});

	it("forwards the call-site receiver to the original method", () => {
		class Point {
			x = 10;
			read(): number {
				return this.x;
			}
		}
		const spy = vi.spyOn(Point.prototype, "read");
		const a = new Point();
		a.x = 42;
		expect(a.read()).toBe(42); // was `undefined` before the fix (this === Proto)
		expect(spy.mock.calls.length).toBe(1);
	});

	it("forwards receiver through getter accessors on a prototype", () => {
		class Holder {
			n = 0;
			get value(): number {
				return this.n;
			}
		}
		const spy = vi.spyOn(Holder.prototype, "value", { accessor: "get" });
		const a = new Holder();
		a.n = 99;
		expect(a.value).toBe(99);
		expect(spy.mock.calls.length).toBe(1);
	});

	it("double-spy throws instead of silently double-counting", () => {
		const obj = {
			fn(): number {
				return 1;
			},
		};
		vi.spyOn(obj, "fn");
		expect(() => vi.spyOn(obj, "fn")).toThrow(/already a spy/);
	});
});

describe("vi patches — Vitest parity semantics", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetFallbackState();
	});

	it("mockReset on vi.fn CLEARS implementation (not restores default)", () => {
		const spy = vi.fn((x: number) => x + 1);
		expect(spy(5)).toBe(6);
		spy.mockReset();
		expect(spy(5)).toBe(undefined);
	});

	it("mockReset on spyOn keeps the call-through", () => {
		const obj = {
			fn(): number {
				return 7;
			},
		};
		const spy = vi.spyOn(obj, "fn");
		spy.mockReturnValue(42);
		expect(obj.fn()).toBe(42);
		spy.mockReset();
		expect(obj.fn()).toBe(7);
	});

	it("mock.results length matches mock.calls for in-flight async", async () => {
		const spy = vi.fn(async (x: number) => x * 2);
		const promise = spy(3);
		// Synchronously after the call, results has an incomplete entry.
		expect(spy.mock.calls.length).toBe(1);
		expect(spy.mock.results.length).toBe(1);
		expect(spy.mock.results[0].type).toBe("return");
		await promise;
	});

	it("restoreAllMocks leaves vi.fn spies as-is", () => {
		const pure = vi.fn(() => 7);
		pure();
		pure();
		const obj = {
			fn(): number {
				return 1;
			},
		};
		const onto = vi.spyOn(obj, "fn").mockReturnValue(99);
		expect(obj.fn()).toBe(99);

		vi.restoreAllMocks();

		// spyOn restored.
		expect(obj.fn()).toBe(1);
		// pure still has its calls + implementation intact.
		expect(pure.mock.calls.length).toBe(2);
		expect(pure()).toBe(7);
		// __isSpyOn tag differentiates them.
		expect(pure.__isSpyOn).toBe(false);
		expect(onto.__isSpyOn).toBe(true);
	});

	it("spy default name is 'spy'", () => {
		expect(vi.fn().name).toBe("spy");
	});
});

describe("vi patches — fake timer edge cases", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.useRealSystemTime();
		resetFallbackState();
	});

	it("setTimeout(cb, NaN) normalises to 0", () => {
		vi.useFakeTimers();
		let fired = false;
		setTimeout(() => {
			fired = true;
		}, Number.NaN);
		vi.advanceTimersByTime(0);
		expect(fired).toBe(true);
	});

	it("second useFakeTimers({ now }) updates the clock", () => {
		vi.useFakeTimers({ now: 1000 });
		expect(Date.now()).toBe(1000);
		vi.useFakeTimers({ now: 5000 });
		expect(Date.now()).toBe(5000);
	});

	it("useFakeTimers pins Date.now / new Date", () => {
		const pin = new Date("2026-06-01T00:00:00Z");
		vi.useFakeTimers({ now: pin });
		expect(new Date().getUTCMonth()).toBe(5);
		expect(Date.now()).toBe(pin.getTime());
	});

	it("advanceTimersByTime advances Date.now in lockstep", () => {
		vi.useFakeTimers({ now: 0 });
		vi.advanceTimersByTime(10_000);
		expect(Date.now()).toBe(10_000);
	});

	it("advanceTimersByTime rejects negative", () => {
		vi.useFakeTimers();
		expect(() => vi.advanceTimersByTime(-50)).toThrow(/negative/);
	});

	it("drain aborts cleanly when a callback throws and advance succeeds after", () => {
		vi.useFakeTimers({ now: 0 });
		setTimeout(() => {
			throw new Error("boom");
		}, 50);
		let second = false;
		setTimeout(() => {
			second = true;
		}, 100);
		expect(() => vi.advanceTimersByTime(200)).toThrow("boom");
		// Clock should still advance so subsequent drains aren't stuck.
		expect(Date.now()).toBe(200);
		vi.advanceTimersByTime(0);
		expect(second).toBe(true);
	});

	it("runAllTimers infinite-loop guard catches self-rescheduling", () => {
		vi.useFakeTimers();
		const scheduleForever = () => setTimeout(scheduleForever, 1);
		scheduleForever();
		expect(() => vi.runAllTimers()).toThrow(/10 000 iterations/);
	});

	it("setImmediate works under fake timers", () => {
		vi.useFakeTimers();
		let fired = false;
		setImmediate(() => {
			fired = true;
		});
		vi.advanceTimersByTime(0);
		expect(fired).toBe(true);
	});

	it("runOnlyPendingTimers fires in due-time order", () => {
		vi.useFakeTimers({ now: 0 });
		const order: string[] = [];
		setTimeout(() => order.push("late"), 100);
		setTimeout(() => order.push("early"), 10);
		vi.runOnlyPendingTimers();
		expect(order).toEqual(["early", "late"]);
	});

	it("getMockedSystemTime returns the pinned epoch", () => {
		expect(vi.getMockedSystemTime()).toBeNull();
		vi.setSystemTime(42);
		expect(vi.getMockedSystemTime()).toBe(42);
		vi.useRealSystemTime();
		expect(vi.getMockedSystemTime()).toBeNull();
	});

	it("setSystemTime rejects NaN / Invalid Date", () => {
		expect(() => vi.setSystemTime(Number.NaN)).toThrow(/finite/);
		expect(() => vi.setSystemTime(new Date("invalid"))).toThrow(/finite/);
	});

	it("performance.now tracks the fake clock when available", () => {
		if (
			typeof performance === "undefined" ||
			typeof performance.now !== "function"
		)
			return;
		vi.useFakeTimers({ now: 100 });
		expect(performance.now()).toBe(100);
		vi.advanceTimersByTime(50);
		expect(performance.now()).toBe(150);
	});

	it("util.promisify(setTimeout) honours the fake clock", async () => {
		vi.useFakeTimers({ now: 0 });
		let resolved = false;
		const promisify = Reflect.get(setTimeout, "__promisify__") as (
			ms: number,
			v: unknown,
		) => Promise<unknown>;
		const p = promisify(500, "done");
		p.then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
		vi.advanceTimersByTime(500);
		await Promise.resolve();
		expect(resolved).toBe(true);
	});

	it("resetAllMocks clears calls + implementations on vi.fn", () => {
		const spy = vi.fn(() => 1).mockReturnValue(42);
		spy();
		vi.resetAllMocks();
		expect(spy.mock.calls.length).toBe(0);
		expect(spy()).toBe(undefined);
	});
});

describe("vi patches — AsyncLocalStorage isolation (AC 6 + AC 8)", () => {
	it("each withViContext owns its mocked system time; globals reset afterwards", async () => {
		const [a, b] = await Promise.all([
			withViContext(async () => {
				vi.useFakeTimers({ now: 1000 });
				// Yield via a microtask — NOT setImmediate (which is now fake
				// and would be queued in our own queue).
				await Promise.resolve();
				return vi.getMockedSystemTime();
			}),
			withViContext(async () => {
				vi.useFakeTimers({ now: 9000 });
				await Promise.resolve();
				return vi.getMockedSystemTime();
			}),
		]);
		// Each context's OWN `getMockedSystemTime` reflects its own pin.
		expect(a).toBe(1000);
		expect(b).toBe(9000);
		// After both resolve, the Date shim is fully uninstalled — no pin.
		expect(Date.now()).not.toBe(1000);
		expect(Date.now()).not.toBe(9000);
		expect(
			Math.abs(Date.now() - Date.parse(new Date().toISOString())),
		).toBeLessThan(1000);
	});

	it("withViContext survives a spy restore that throws", async () => {
		const obj1 = {
			fn(): number {
				return 1;
			},
		};
		const obj2 = {
			fn(): number {
				return 2;
			},
		};
		await withViContext(async () => {
			const s1 = vi.spyOn(obj1, "fn");
			vi.spyOn(obj2, "fn");
			// Monkey the restore to throw.
			s1.__setRestore(() => {
				throw new Error("restore boom");
			});
		});
		// Even after s1's restore threw, s2 was still restored.
		expect(obj2.fn()).toBe(2);
	});
});
