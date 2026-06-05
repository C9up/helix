import { afterEach, describe, expect, it } from "vitest";
import { matchers } from "../../../../src/runtime/matchers.js";
import { vi } from "../../../../src/runtime/vi/index.js";

describe("vi + toHaveBeenCalled* end-to-end", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("vi.fn satisfies the Helix spy matchers", () => {
		const spy = vi.fn((a: number) => a + 1);
		spy(1);
		spy(2);
		expect(matchers.toHaveBeenCalled(spy).pass).toBe(true);
		expect(matchers.toHaveBeenCalledTimes(spy, 2).pass).toBe(true);
		expect(matchers.toHaveBeenCalledWith(spy, 2).pass).toBe(true);
		expect(matchers.toHaveBeenCalledWith(spy, 99).pass).toBe(false);
		expect(matchers.toHaveBeenCalledOnce(spy).pass).toBe(false);
	});

	it("vi.spyOn produces a spy that matches too", () => {
		const obj = {
			go(x: number): number {
				return x * 2;
			},
		};
		const spy = vi.spyOn(obj, "go");
		obj.go(3);
		obj.go(4);
		expect(matchers.toHaveBeenCalledTimes(spy, 2).pass).toBe(true);
		expect(matchers.toHaveBeenCalledWith(spy, 4).pass).toBe(true);
	});

	it("restoreAllMocks restores all spied methods at once", () => {
		const a = {
			fn(): number {
				return 1;
			},
		};
		const b = {
			fn(): number {
				return 2;
			},
		};
		const sa = vi.spyOn(a, "fn").mockReturnValue(99);
		const sb = vi.spyOn(b, "fn").mockReturnValue(98);
		expect(a.fn()).toBe(99);
		expect(b.fn()).toBe(98);
		vi.restoreAllMocks();
		expect(a.fn()).toBe(1);
		expect(b.fn()).toBe(2);
		// Spies themselves are still callable but disconnected.
		expect(sa.__helixIsSpy).toBe(true);
		expect(sb.__helixIsSpy).toBe(true);
	});

	it("clearAllMocks empties calls without removing implementations", () => {
		const spy = vi.fn<() => string>().mockReturnValue("x");
		spy();
		spy();
		vi.clearAllMocks();
		expect(spy.mock.calls.length).toBe(0);
		// Implementation intact.
		expect(spy()).toBe("x");
	});
});
