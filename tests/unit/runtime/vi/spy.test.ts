import { describe, expect, it } from "vitest";
import { vi } from "../../../../src/runtime/vi/index.js";

describe("vi.fn", () => {
	it("records every call and its arguments", () => {
		const spy = vi.fn((a: number, b: number) => a + b);
		expect(spy(2, 3)).toBe(5);
		expect(spy(10, 20)).toBe(30);
		expect(spy.mock.calls).toEqual([
			[2, 3],
			[10, 20],
		]);
		expect(spy.callCount).toBe(2);
		expect(spy.mock.results).toEqual([
			{ type: "return", value: 5 },
			{ type: "return", value: 30 },
		]);
	});

	it("records throws as result type 'throw'", () => {
		const spy = vi.fn(() => {
			throw new Error("boom");
		});
		expect(() => spy()).toThrow("boom");
		expect(spy.mock.results[0].type).toBe("throw");
	});

	it("mockReturnValue / mockReturnValueOnce", () => {
		const spy = vi.fn<() => number>();
		spy.mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValue(99);
		expect(spy()).toBe(1);
		expect(spy()).toBe(2);
		expect(spy()).toBe(99);
		expect(spy()).toBe(99);
	});

	it("mockResolvedValue / mockRejectedValue", async () => {
		const ok = vi.fn<() => Promise<string>>().mockResolvedValue("hi");
		await expect(ok()).resolves.toBe("hi");
		const bad = vi
			.fn<() => Promise<never>>()
			.mockRejectedValue(new Error("nope"));
		await expect(bad()).rejects.toThrow("nope");
	});

	it("mockClear keeps implementation, mockReset wipes it", () => {
		const spy = vi.fn<() => number>().mockReturnValue(42);
		spy();
		expect(spy.mock.calls.length).toBe(1);
		spy.mockClear();
		expect(spy.mock.calls.length).toBe(0);
		expect(spy()).toBe(42);
		spy.mockReset();
		// After reset, default impl is undefined.
		expect(spy()).toBe(undefined);
	});

	it("carries the __helixIsSpy brand", () => {
		const spy = vi.fn();
		expect(vi.isMockFunction(spy)).toBe(true);
		expect(vi.isMockFunction(() => {})).toBe(false);
	});
});
