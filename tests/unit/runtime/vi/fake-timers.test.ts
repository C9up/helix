import { afterEach, describe, expect, it } from "vitest";
import { vi } from "../../../../src/runtime/vi/index.js";

describe("vi.useFakeTimers", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.useRealSystemTime();
	});

	it("captures setTimeout and advances on demand", () => {
		vi.useFakeTimers();
		let fired = false;
		setTimeout(() => {
			fired = true;
		}, 1000);
		expect(fired).toBe(false);
		vi.advanceTimersByTime(999);
		expect(fired).toBe(false);
		vi.advanceTimersByTime(1);
		expect(fired).toBe(true);
	});

	it("processes chained scheduling in a single advance", () => {
		vi.useFakeTimers();
		const events: number[] = [];
		setTimeout(() => {
			events.push(1);
			setTimeout(() => events.push(2), 10);
		}, 10);
		vi.advanceTimersByTime(25);
		expect(events).toEqual([1, 2]);
	});

	it("setInterval re-fires until cleared", () => {
		vi.useFakeTimers();
		let count = 0;
		const id = setInterval(() => {
			count += 1;
		}, 50);
		vi.advanceTimersByTime(200);
		expect(count).toBe(4);
		clearInterval(id);
		vi.advanceTimersByTime(200);
		expect(count).toBe(4);
	});

	it("runAllTimers drains everything scheduled so far", () => {
		vi.useFakeTimers();
		let hit = 0;
		setTimeout(() => {
			hit += 1;
		}, 100);
		setTimeout(() => {
			hit += 1;
		}, 500);
		vi.runAllTimers();
		expect(hit).toBe(2);
	});

	it("runOnlyPendingTimers fires current queue only, not newly-scheduled", () => {
		vi.useFakeTimers();
		const order: string[] = [];
		setTimeout(() => {
			order.push("a");
			setTimeout(() => order.push("b"), 10);
		}, 10);
		vi.runOnlyPendingTimers();
		expect(order).toEqual(["a"]);
	});

	it("setSystemTime pins Date.now and new Date()", () => {
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		expect(Date.now()).toBe(1767225600000);
		expect(new Date().getUTCFullYear()).toBe(2026);
		vi.useRealSystemTime();
		expect(new Date().getUTCFullYear()).toBeGreaterThanOrEqual(2026);
	});

	it("getTimerCount reports pending timers", () => {
		vi.useFakeTimers();
		expect(vi.getTimerCount()).toBe(0);
		setTimeout(() => {}, 10);
		setTimeout(() => {}, 20);
		expect(vi.getTimerCount()).toBe(2);
		vi.clearAllTimers();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("useRealTimers restores the real setTimeout", async () => {
		vi.useFakeTimers();
		vi.useRealTimers();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	});
});
