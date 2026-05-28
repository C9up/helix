/**
 * Self-test: vi.useFakeTimers + setSystemTime + advanceTimersByTime.
 */

import { afterEach, describe, expect, test, vi } from "@c9up/helix";

describe("vi.useFakeTimers — setTimeout queue", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("setTimeout does NOT fire until time advances", () => {
		vi.useFakeTimers();
		let ticked = false;
		setTimeout(() => {
			ticked = true;
		}, 1000);
		expect(ticked).toBe(false);
		vi.advanceTimersByTime(999);
		expect(ticked).toBe(false);
		vi.advanceTimersByTime(1);
		expect(ticked).toBe(true);
	});

	test("multiple timers fire in scheduled order", () => {
		vi.useFakeTimers();
		const order: number[] = [];
		setTimeout(() => {
			order.push(2);
		}, 200);
		setTimeout(() => {
			order.push(1);
		}, 100);
		vi.advanceTimersByTime(250);
		expect(order).toEqual([1, 2]);
	});
});

describe("vi.setSystemTime — pins Date.now", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("Date.now returns the pinned epoch", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		expect(Date.now()).toBe(new Date("2026-01-01T00:00:00Z").getTime());
	});

	test("setSystemTime can be re-pinned mid-test", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const t1 = Date.now();
		vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
		const t2 = Date.now();
		expect(t2 - t1).toBe(60_000);
	});

	test("useRealTimers restores live system clock", () => {
		vi.useFakeTimers();
		const fakePin = new Date("2020-01-01T00:00:00Z").getTime();
		vi.setSystemTime(new Date(fakePin));
		expect(Date.now()).toBe(fakePin);
		vi.useRealTimers();
		// Strict inequality: if `useRealTimers` were silently broken and
		// the fake clock stayed pinned, `realNow === fakePin` would still
		// satisfy `>=`. The `not.toBe` and the `realNow > fakePin + 1s`
		// guards both have to fail to give a false positive — pick a
		// clearly-past pin (2020-01-01) so this holds on any reasonable
		// CI clock.
		const realNow = Date.now();
		expect(realNow).not.toBe(fakePin);
		expect(realNow > fakePin + 1000).toBe(true);
	});
});
