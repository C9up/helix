/**
 * Structural equality on the types a plain key-walk gets wrong.
 *
 * A deep-equal that reads a Map by its keys, or a typed array by its indices,
 * silently calls two different values equal — and that verdict is what every
 * `toEqual` in a consumer's suite rests on.
 */
import { describe, expect, it } from "vitest";
import { equals, partialEquals } from "../../../src/runtime/equals.js";

describe("helix > equals on boxed primitives", () => {
	it("compares them by their value", () => {
		expect(equals(new Number(1), new Number(1))).toBe(true);
		expect(equals(new String("a"), new String("a"))).toBe(true);
		expect(equals(new Boolean(true), new Boolean(true))).toBe(true);
		expect(equals(new Number(1), new Number(2))).toBe(false);
	});

	it("does not call a box equal to its primitive", () => {
		// They behave differently everywhere else; calling them equal here
		// hides a bug rather than tolerating one.
		expect(equals(new Number(1), 1)).toBe(false);
		expect(equals(new String("a"), "a")).toBe(false);
	});
});

describe("helix > equals on dates and errors", () => {
	it("compares dates by instant", () => {
		expect(equals(new Date(0), new Date(0))).toBe(true);
		expect(equals(new Date(0), new Date(1))).toBe(false);
		expect(equals(new Date(0), 0)).toBe(false);
	});

	it("compares errors by name, message and own keys", () => {
		expect(equals(new Error("boom"), new Error("boom"))).toBe(true);
		expect(equals(new Error("boom"), new Error("other"))).toBe(false);
		// A TypeError is not an Error with the same message.
		expect(equals(new TypeError("boom"), new Error("boom"))).toBe(false);
	});

	it("reads the properties an error carries beyond its message", () => {
		const a = Object.assign(new Error("boom"), { code: "E_A" });
		const b = Object.assign(new Error("boom"), { code: "E_B" });

		expect(equals(a, Object.assign(new Error("boom"), { code: "E_A" }))).toBe(
			true,
		);
		expect(equals(a, b)).toBe(false);
	});
});

describe("helix > equals on binary views", () => {
	it("compares typed arrays element by element", () => {
		expect(equals(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
		expect(equals(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
		expect(equals(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
	});

	it("does not call two different array types equal", () => {
		// The bytes match; the meaning does not.
		expect(equals(new Uint8Array([1]), new Int8Array([1]))).toBe(false);
	});

	it("treats NaN as equal to itself inside a float array", () => {
		expect(
			equals(new Float64Array([Number.NaN]), new Float64Array([Number.NaN])),
		).toBe(true);
	});

	it("compares a DataView byte for byte", () => {
		const of = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

		expect(equals(of([1, 2]), of([1, 2]))).toBe(true);
		expect(equals(of([1, 2]), of([1, 3]))).toBe(false);
		expect(equals(of([1]), of([1, 2]))).toBe(false);
		expect(equals(of([1]), new Uint8Array([1]))).toBe(false);
	});
});

describe("helix > equals on maps and sets", () => {
	it("compares maps by structure, not by key identity", () => {
		// Two distinct objects used as keys: a `has()` lookup finds neither.
		const a = new Map([[{ id: 1 }, "x"]]);
		const b = new Map([[{ id: 1 }, "x"]]);

		expect(equals(a, b)).toBe(true);
		expect(equals(a, new Map([[{ id: 2 }, "x"]]))).toBe(false);
		expect(equals(a, new Map([[{ id: 1 }, "y"]]))).toBe(false);
	});

	it("compares maps of different size as different", () => {
		expect(equals(new Map([["a", 1]]), new Map())).toBe(false);
		expect(equals(new Map(), new Set())).toBe(false);
	});

	it("compares sets by structure too", () => {
		expect(equals(new Set([{ id: 1 }]), new Set([{ id: 1 }]))).toBe(true);
		expect(equals(new Set([{ id: 1 }]), new Set([{ id: 2 }]))).toBe(false);
		expect(equals(new Set([1]), new Set([1, 2]))).toBe(false);
	});

	it("does not depend on insertion order", () => {
		expect(equals(new Set([1, 2]), new Set([2, 1]))).toBe(true);
		expect(
			equals(
				new Map([
					["a", 1],
					["b", 2],
				]),
				new Map([
					["b", 2],
					["a", 1],
				]),
			),
		).toBe(true);
	});
});

describe("helix > equals and the keys that are absent", () => {
	it("treats an absent key as undefined by default", () => {
		expect(equals({ a: 1 }, { a: 1, b: undefined })).toBe(true);
	});

	it("tells them apart under strict", () => {
		expect(equals({ a: 1 }, { a: 1, b: undefined }, { strict: true })).toBe(
			false,
		);
		expect(equals({ a: 1 }, { a: 1 }, { strict: true })).toBe(true);
	});
});

describe("helix > equals survives a cycle", () => {
	it("compares two identically-shaped cyclic objects", () => {
		type Node = { name: string; self?: Node };
		const a: Node = { name: "a" };
		a.self = a;
		const b: Node = { name: "a" };
		b.self = b;

		// Without cycle tracking this recurses until the stack gives out.
		expect(equals(a, b)).toBe(true);
	});

	it("still tells two cyclic objects apart when they differ", () => {
		type Node = { name: string; self?: Node };
		const a: Node = { name: "a" };
		a.self = a;
		const b: Node = { name: "b" };
		b.self = b;

		expect(equals(a, b)).toBe(false);
	});
});

describe("helix > partialEquals", () => {
	it("accepts an object that carries more than was asked for", () => {
		expect(partialEquals({ a: 1, b: 2 }, { a: 1 })).toBe(true);
		expect(partialEquals({ a: 1 }, { a: 2 })).toBe(false);
	});

	it("recurses into nested objects", () => {
		expect(partialEquals({ a: { b: 1, c: 2 } }, { a: { b: 1 } })).toBe(true);
		expect(partialEquals({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
	});

	it("requires arrays to match in full, not partially", () => {
		// A shorter expected array is a different list, not a subset.
		expect(partialEquals([1, 2], [1, 2])).toBe(true);
		expect(partialEquals([1, 2], [1])).toBe(false);
		// An object is not an array, whatever its keys look like.
		expect(partialEquals({ 0: 1 }, [1])).toBe(false);
	});

	it("falls back to full equality for the types with no partial meaning", () => {
		expect(partialEquals(new Date(0), new Date(0))).toBe(true);
		expect(partialEquals(new Date(0), new Date(1))).toBe(false);
		expect(partialEquals(new Set([1]), new Set([1]))).toBe(true);
	});

	it("compares primitives and null directly", () => {
		expect(partialEquals(1, 1)).toBe(true);
		expect(partialEquals(null, null)).toBe(true);
		expect(partialEquals({ a: 1 }, null)).toBe(false);
		expect(partialEquals(null, { a: 1 })).toBe(false);
		expect(partialEquals("x", "x")).toBe(true);
	});

	it("survives a cycle in the expected shape", () => {
		type Node = { name: string; self?: Node };
		const a: Node = { name: "a" };
		a.self = a;
		const b: Node = { name: "a" };
		b.self = b;

		expect(partialEquals(a, b)).toBe(true);
	});
});
