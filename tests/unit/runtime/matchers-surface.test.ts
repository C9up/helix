/**
 * The matcher surface, each one both ways.
 *
 * A matcher answers `{ pass, message }`, and the message is only read when it
 * fails — so a matcher that never fails in a test has an unread message and an
 * unproven verdict. Every one below is asked a question it must answer yes to,
 * and one it must answer no to.
 */
import { describe, expect as vExpect, it as vIt } from "vitest";
import { matchers } from "../../../src/runtime/matchers.js";

/** `[name, arguments that pass, arguments that fail]` */
type Row = [string, unknown[], unknown[]];

const rows: Row[] = [
	["toBe", [1, 1], [1, 2]],
	["toEqual", [{ a: [1] }, { a: [1] }], [{ a: [1] }, { a: [2] }]],
	["toStrictEqual", [{ a: 1 }, { a: 1 }], [{ a: 1 }, { a: 1, b: undefined }]],
	["toMatchObject", [{ a: 1, b: 2 }, { a: 1 }], [{ a: 1 }, { b: 2 }]],
	["toContain", [[1, 2], 2], [[1, 2], 3]],
	["toMatch", ["abc", /b/], ["abc", /z/]],
	["toHaveLength", [[1, 2], 2], [[1, 2], 3]],
	["toBeDefined", [1], [undefined]],
	["toBeUndefined", [undefined], [1]],
	["toBeNull", [null], [undefined]],
	["toBeInstanceOf", [new Error("x"), Error], [{}, Error]],
	["toBeGreaterThan", [2, 1], [1, 2]],
	["toBeGreaterThanOrEqual", [1, 1], [0, 1]],
	["toBeLessThan", [1, 2], [2, 1]],
	["toBeLessThanOrEqual", [1, 1], [2, 1]],
	["toBeTruthy", ["x"], [""]],
	["toBeFalsy", [""], ["x"]],
	["toBeNaN", [Number.NaN], [1]],
	["toBeCloseTo", [1.001, 1, 2], [1.5, 1, 2]],
	["toHaveProperty", [{ a: { b: 1 } }, "a.b"], [{ a: {} }, "a.b"]],
];

const run = (name: string, args: unknown[]) => {
	const matcher = (
		matchers as unknown as Record<
			string,
			(...a: unknown[]) => { pass: boolean; message(): string }
		>
	)[name];
	return matcher(...args);
};

describe("helix > every matcher answers both ways", () => {
	for (const [name, passing, failing] of rows) {
		vIt(`${name} passes on what it should`, () => {
			vExpect(run(name, passing).pass, name).toBe(true);
		});
		vIt(`${name} fails on what it should, with a message`, () => {
			const result = run(name, failing);
			vExpect(result.pass, name).toBe(false);
			// The message is what a failing test prints; an empty one leaves the
			// reader with nothing.
			vExpect(result.message().length, name).toBeGreaterThan(0);
		});
	}
});

describe("helix > the matchers with more than one shape", () => {
	vIt("toContain reads a string, an array, a Set and a Map key", () => {
		vExpect(matchers.toContain("hello", "ell").pass).toBe(true);
		vExpect(matchers.toContain([1, 2], 1).pass).toBe(true);
		vExpect(matchers.toContain(new Set([1]), 1).pass).toBe(true);
		vExpect(matchers.toContain("hello", "xyz").pass).toBe(false);
	});

	vIt("toMatch takes a substring as well as a pattern", () => {
		vExpect(matchers.toMatch("hello", "ell").pass).toBe(true);
		vExpect(matchers.toMatch("hello", "xyz").pass).toBe(false);
	});

	vIt("toHaveLength reads `.length`, and says so when there is none", () => {
		vExpect(matchers.toHaveLength("abc", 3).pass).toBe(true);
		vExpect(matchers.toHaveLength([1, 2], 2).pass).toBe(true);
		vExpect(matchers.toHaveLength({ length: 4 }, 4).pass).toBe(true);

		// A Set carries `.size`, not `.length` — the message has to say that
		// rather than report a mismatch the reader cannot explain.
		const noLength = matchers.toHaveLength(new Set([1, 2]), 2);
		vExpect(noLength.pass).toBe(false);
		vExpect(noLength.message()).toContain("no .length");
	});

	vIt("toHaveProperty walks a bracketed path, and can check the value", () => {
		const value = { list: [{ id: 7 }] };

		vExpect(matchers.toHaveProperty(value, "list[0].id").pass).toBe(true);
		vExpect(matchers.toHaveProperty(value, "list[0].id", 7).pass).toBe(true);
		vExpect(matchers.toHaveProperty(value, "list[0].id", 8).pass).toBe(false);
		vExpect(matchers.toHaveProperty(value, "list[1].id").pass).toBe(false);
	});

	vIt("compares a bigint against a number without losing the verdict", () => {
		vExpect(matchers.toBeGreaterThan(10n, 5).pass).toBe(true);
		vExpect(matchers.toBeGreaterThan(5, 10n).pass).toBe(false);
		vExpect(matchers.toBeLessThan(5n, 10n).pass).toBe(true);
		vExpect(matchers.toBeGreaterThanOrEqual(10n, 10n).pass).toBe(true);
		vExpect(matchers.toBeLessThanOrEqual(10n, 10n).pass).toBe(true);
	});

	vIt("toStrictEqual tells an absent key from one holding undefined", () => {
		// This is the whole difference between it and toEqual.
		vExpect(matchers.toEqual({ a: 1 }, { a: 1, b: undefined }).pass).toBe(true);
		vExpect(matchers.toStrictEqual({ a: 1 }, { a: 1, b: undefined }).pass).toBe(
			false,
		);
	});
});

describe("helix > toThrow", () => {
	const boom = () => {
		throw new TypeError("boom happened");
	};

	vIt("passes on a thrower and fails on one that returns", () => {
		vExpect(matchers.toThrow(boom).pass).toBe(true);
		vExpect(matchers.toThrow(() => 1).pass).toBe(false);
	});

	vIt("narrows on a substring, a pattern and a class", () => {
		vExpect(matchers.toThrow(boom, "boom").pass).toBe(true);
		vExpect(matchers.toThrow(boom, /happened/).pass).toBe(true);
		vExpect(matchers.toThrow(boom, TypeError).pass).toBe(true);
		vExpect(matchers.toThrow(boom, "elsewhere").pass).toBe(false);
		vExpect(matchers.toThrow(boom, RangeError).pass).toBe(false);
	});

	vIt("says what it got when the expectation is not met", () => {
		vExpect(matchers.toThrow(() => 1).message().length).toBeGreaterThan(0);
		vExpect(
			matchers.toThrow(boom, RangeError).message().length,
		).toBeGreaterThan(0);
	});
});

describe("helix > the spy matchers", () => {
	const spy = (calls: unknown[][]) => ({
		__helixIsSpy: true as const,
		calls,
		callCount: calls.length,
	});

	vIt("reports whether the spy was called at all", () => {
		vExpect(matchers.toHaveBeenCalled(spy([[1]])).pass).toBe(true);
		vExpect(matchers.toHaveBeenCalled(spy([])).pass).toBe(false);
	});

	vIt("counts the calls", () => {
		vExpect(matchers.toHaveBeenCalledTimes(spy([[1], [2]]), 2).pass).toBe(true);
		vExpect(matchers.toHaveBeenCalledTimes(spy([[1]]), 2).pass).toBe(false);
	});

	vIt("reads exactly one call", () => {
		vExpect(matchers.toHaveBeenCalledOnce(spy([[1]])).pass).toBe(true);
		vExpect(matchers.toHaveBeenCalledOnce(spy([[1], [2]])).pass).toBe(false);
	});

	vIt("matches the arguments of any call", () => {
		const called = spy([
			[1, "a"],
			[2, "b"],
		]);

		vExpect(matchers.toHaveBeenCalledWith(called, 2, "b").pass).toBe(true);
		vExpect(matchers.toHaveBeenCalledWith(called, 3, "c").pass).toBe(false);
	});

	vIt("matches the LAST call specifically", () => {
		const called = spy([[1], [2]]);

		vExpect(matchers.toHaveBeenLastCalledWith(called, 2).pass).toBe(true);
		// The first call matched something else — last means last.
		vExpect(matchers.toHaveBeenLastCalledWith(called, 1).pass).toBe(false);
	});

	vIt("matches the nth call, counting from one", () => {
		const called = spy([[1], [2], [3]]);

		vExpect(matchers.toHaveBeenNthCalledWith(called, 1, 1).pass).toBe(true);
		vExpect(matchers.toHaveBeenNthCalledWith(called, 3, 3).pass).toBe(true);
		vExpect(matchers.toHaveBeenNthCalledWith(called, 2, 3).pass).toBe(false);
		// A call that never happened is not a match.
		vExpect(matchers.toHaveBeenNthCalledWith(called, 9, 1).pass).toBe(false);
	});

	vIt("says so when handed something that is not a spy", () => {
		const result = matchers.toHaveBeenCalled({});

		vExpect(result.pass).toBe(false);
		vExpect(result.message().length).toBeGreaterThan(0);
	});
});
