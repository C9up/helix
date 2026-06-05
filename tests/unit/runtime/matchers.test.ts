import { describe, expect, it } from "vitest";
import { matchers } from "../../../src/runtime/matchers.js";

describe("core matchers — positive and negative", () => {
	it("toBe uses Object.is", () => {
		expect(matchers.toBe(1, 1).pass).toBe(true);
		expect(matchers.toBe(Number.NaN, Number.NaN).pass).toBe(true);
		expect(matchers.toBe({}, {}).pass).toBe(false);
	});

	it("toEqual deep equals", () => {
		expect(matchers.toEqual({ a: 1 }, { a: 1 }).pass).toBe(true);
		expect(matchers.toEqual({ a: 1 }, { a: 2 }).pass).toBe(false);
	});

	it("toMatchObject partial", () => {
		expect(matchers.toMatchObject({ a: 1, b: 2 }, { a: 1 }).pass).toBe(true);
		expect(matchers.toMatchObject({ a: 1 }, { b: 2 }).pass).toBe(false);
	});

	it("toContain works on string/array/Set", () => {
		expect(matchers.toContain("abc", "b").pass).toBe(true);
		expect(matchers.toContain([1, 2, 3], 2).pass).toBe(true);
		expect(matchers.toContain([{ id: 1 }], { id: 1 }).pass).toBe(true);
		expect(matchers.toContain(new Set([1, 2]), 1).pass).toBe(true);
	});

	it("toMatch string/regex", () => {
		expect(matchers.toMatch("hello world", /world/).pass).toBe(true);
		expect(matchers.toMatch("hello world", "world").pass).toBe(true);
		expect(matchers.toMatch("hello", /bye/).pass).toBe(false);
	});

	it("toHaveLength", () => {
		expect(matchers.toHaveLength([1, 2, 3], 3).pass).toBe(true);
		expect(matchers.toHaveLength("abc", 3).pass).toBe(true);
		expect(matchers.toHaveLength({}, 0).pass).toBe(false);
	});

	it("toBeDefined / Undefined / Null — positive + negative", () => {
		expect(matchers.toBeDefined(1).pass).toBe(true);
		expect(matchers.toBeDefined(undefined).pass).toBe(false);
		expect(matchers.toBeUndefined(undefined).pass).toBe(true);
		expect(matchers.toBeUndefined(null).pass).toBe(false);
		expect(matchers.toBeUndefined(0).pass).toBe(false);
		expect(matchers.toBeNull(null).pass).toBe(true);
		expect(matchers.toBeNull(undefined).pass).toBe(false);
	});

	it("toBeInstanceOf", () => {
		expect(matchers.toBeInstanceOf(new Date(), Date).pass).toBe(true);
		expect(matchers.toBeInstanceOf({}, Date).pass).toBe(false);
	});

	it("toBeGreaterThan / OrEqual — positive + negative + bigint", () => {
		expect(matchers.toBeGreaterThan(5, 3).pass).toBe(true);
		expect(matchers.toBeGreaterThan(3, 5).pass).toBe(false);
		expect(matchers.toBeGreaterThan(3, 3).pass).toBe(false);
		expect(matchers.toBeGreaterThan(5n, 3n).pass).toBe(true);
		expect(matchers.toBeGreaterThanOrEqual(5, 5).pass).toBe(true);
		expect(matchers.toBeGreaterThanOrEqual(4, 5).pass).toBe(false);
		// Non-number received rejected with pass: false.
		const nonNumeric: unknown = "x";
		expect(matchers.toBeGreaterThanOrEqual(nonNumeric, 5).pass).toBe(false);
	});

	it("toThrow without expected", () => {
		const r = matchers.toThrow(() => {
			throw new Error("nope");
		});
		expect(r.pass).toBe(true);
	});

	it("toThrow with string substring", () => {
		const r = matchers.toThrow(() => {
			throw new Error("boom kaboom");
		}, "kaboom");
		expect(r.pass).toBe(true);
	});

	it("toThrow with RegExp", () => {
		const r = matchers.toThrow(() => {
			throw new Error("boom");
		}, /bo+m/);
		expect(r.pass).toBe(true);
	});

	it("toThrow fails when function doesn't throw", () => {
		expect(matchers.toThrow(() => {}).pass).toBe(false);
	});

	it("spy matchers — positive, negative, and shape validation", () => {
		expect(matchers.toHaveBeenCalled(() => {}).pass).toBe(false);
		// Fake-brand without a calls array must not be accepted as a spy.
		const notASpy = { __helixIsSpy: true, calls: "nope", callCount: 3 };
		expect(matchers.toHaveBeenCalled(notASpy).pass).toBe(false);
		const spy = {
			__helixIsSpy: true as const,
			calls: [[1, 2]],
			callCount: 1,
		};
		expect(matchers.toHaveBeenCalled(spy).pass).toBe(true);
		expect(matchers.toHaveBeenCalledTimes(spy, 1).pass).toBe(true);
		expect(matchers.toHaveBeenCalledTimes(spy, 2).pass).toBe(false);
		expect(matchers.toHaveBeenCalledOnce(spy).pass).toBe(true);
		const twice = {
			__helixIsSpy: true as const,
			calls: [[1], [2]],
			callCount: 2,
		};
		expect(matchers.toHaveBeenCalledOnce(twice).pass).toBe(false);
		expect(matchers.toHaveBeenCalledWith(spy, 1, 2).pass).toBe(true);
		expect(matchers.toHaveBeenCalledWith(spy, 3, 4).pass).toBe(false);
	});

	it("toBeInstanceOf rejects arrow functions with a clean AssertionError", () => {
		const arrow = (x: number) => x;
		expect(matchers.toBeInstanceOf({}, arrow).pass).toBe(false);
	});

	it("toThrow hints when received is async", () => {
		const result = matchers.toThrow(async () => {
			throw new Error("boom");
		});
		expect(result.pass).toBe(false);
		expect(result.message()).toContain("rejects.toThrow");
	});

	it("toContain deep-equality on Set", () => {
		expect(matchers.toContain(new Set([{ id: 1 }]), { id: 1 }).pass).toBe(true);
		expect(matchers.toContain(new Set([{ id: 1 }]), { id: 2 }).pass).toBe(
			false,
		);
	});
});
