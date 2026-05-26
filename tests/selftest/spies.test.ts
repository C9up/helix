/**
 * Self-test: vi.fn spies + vi.spyOn original-restoration.
 *
 * Each test fully reconstructs its target so assertions are
 * independent of test execution order — a must-have when the runner
 * could one day add `--shuffle` or per-test concurrency.
 */

import { describe, expect, test, vi } from "@c9up/helix";

describe("vi.fn — basic spy", () => {
	test("records call count, args, and return values", () => {
		const fn = vi.fn((a: number, b: number) => a + b);
		expect(fn(2, 3)).toBe(5);
		expect(fn(10, 20)).toBe(30);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(fn).toHaveBeenCalledWith(2, 3);
		expect(fn.mock.calls).toEqual([
			[2, 3],
			[10, 20],
		]);
	});

	test("mockReturnValue overrides the implementation", () => {
		const fn = vi.fn();
		fn.mockReturnValue(42);
		expect(fn()).toBe(42);
		expect(fn("anything")).toBe(42);
		expect(fn).toHaveBeenCalledTimes(2);
	});
});

describe("vi.spyOn — wrap-and-restore lifecycle", () => {
	function makeTarget(): { greet(name: string): string } {
		return {
			greet(name: string): string {
				return `hello ${name}`;
			},
		};
	}

	test("install + intercept + manual mockRestore returns the original", () => {
		const target = makeTarget();
		const original = target.greet;
		const spy = vi.spyOn(target, "greet");

		// Spy preserves original behaviour by default.
		expect(target.greet("alice")).toBe("hello alice");
		expect(spy).toHaveBeenCalledOnce();
		expect(spy.mock.calls[0]).toEqual(["alice"]);

		// mockImplementation rewrites the wrapped method.
		spy.mockImplementation((name) => `bonjour ${name}`);
		expect(target.greet("alice")).toBe("bonjour alice");
		expect(spy).toHaveBeenCalledTimes(2);

		// mockRestore puts the original back AND breaks the spy linkage.
		spy.mockRestore();
		expect(target.greet("alice")).toBe("hello alice");
		expect(target.greet).toBe(original);
	});

	test("vi.restoreAllMocks restores every spy installed in this test", () => {
		const target = makeTarget();
		const original = target.greet;
		vi.spyOn(target, "greet").mockImplementation(() => "spied");
		expect(target.greet("anyone")).toBe("spied");

		vi.restoreAllMocks();

		expect(target.greet).toBe(original);
		expect(target.greet("alice")).toBe("hello alice");
	});
});
