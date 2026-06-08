import { describe, expect, it } from "vitest";
import { equals, partialEquals } from "../../../src/runtime/equals.js";

describe("equals — deep structural", () => {
	it("treats NaN as equal; ±0 equal in non-strict (Vitest toEqual semantics)", () => {
		expect(equals(Number.NaN, Number.NaN)).toBe(true);
		expect(equals(0, -0)).toBe(true);
		expect(equals(0, -0, { strict: true })).toBe(false);
	});

	it("undefined key vs missing key are equal in non-strict mode", () => {
		expect(equals({ a: 1, b: undefined }, { a: 1 })).toBe(true);
	});

	it("undefined key vs missing key differ in strict mode", () => {
		expect(equals({ a: 1, b: undefined }, { a: 1 }, { strict: true })).toBe(
			false,
		);
	});

	it("matches Dates by timestamp", () => {
		expect(equals(new Date(1234), new Date(1234))).toBe(true);
		expect(equals(new Date(1234), new Date(5678))).toBe(false);
	});

	it("matches RegExps by source+flags", () => {
		expect(equals(/foo/gi, /foo/gi)).toBe(true);
		expect(equals(/foo/g, /foo/i)).toBe(false);
	});

	it("matches Maps deeply", () => {
		expect(equals(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(true);
		expect(equals(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
	});

	it("matches Sets deeply", () => {
		expect(equals(new Set([{ a: 1 }]), new Set([{ a: 1 }]))).toBe(true);
	});

	it("handles circular references", () => {
		type Cyclic = { self?: Cyclic };
		const a: Cyclic = {};
		a.self = a;
		const b: Cyclic = {};
		b.self = b;
		expect(equals(a, b)).toBe(true);
	});

	it("typed array equality", () => {
		expect(equals(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(
			true,
		);
		expect(equals(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(
			false,
		);
	});
});

describe("equals — edge-case fixes", () => {
	it("Map with object keys matches structurally", () => {
		expect(
			equals(new Map([[{ id: 1 }, "a"]]), new Map([[{ id: 1 }, "a"]])),
		).toBe(true);
	});

	it("Set with object elements matches structurally", () => {
		expect(equals(new Set([{ a: 1 }]), new Set([{ a: 1 }]))).toBe(true);
		expect(equals(new Set([{ a: 1 }]), new Set([{ a: 2 }]))).toBe(false);
	});

	it("DataView compared byte-for-byte, not always-equal", () => {
		const a = new DataView(new ArrayBuffer(2));
		const b = new DataView(new ArrayBuffer(2));
		a.setUint8(0, 1);
		b.setUint8(0, 1);
		expect(equals(a, b)).toBe(true);
		b.setUint8(0, 2);
		expect(equals(a, b)).toBe(false);
	});

	it("typed arrays of different constructors are not equal", () => {
		expect(equals(new Uint8Array([1, 2, 3]), new Int8Array([1, 2, 3]))).toBe(
			false,
		);
	});

	it("NaN inside Float64Array compares equal", () => {
		expect(
			equals(new Float64Array([Number.NaN]), new Float64Array([Number.NaN])),
		).toBe(true);
	});

	it("boxed primitives compare by value", () => {
		expect(equals(new Number(1), new Number(1))).toBe(true);
		expect(equals(new Number(1), new Number(2))).toBe(false);
		expect(equals(new String("a"), new String("a"))).toBe(true);
		expect(equals(new Number(1), new String("1"))).toBe(false);
	});

	it("Error instances distinguish by message/name", () => {
		expect(equals(new Error("a"), new Error("a"))).toBe(true);
		expect(equals(new Error("a"), new Error("b"))).toBe(false);
		expect(equals(new Error("x"), new TypeError("x"))).toBe(false);
	});

	it("symbol-keyed properties are compared", () => {
		const sym = Symbol.for("k");
		expect(equals({ [sym]: 1 }, { [sym]: 1 })).toBe(true);
		expect(equals({ [sym]: 1 }, { [sym]: 2 })).toBe(false);
	});
});

describe("partialEquals", () => {
	it("matches subset of keys", () => {
		expect(partialEquals({ a: 1, b: 2, c: 3 }, { a: 1, c: 3 })).toBe(true);
	});

	it("arrays must have same length", () => {
		expect(partialEquals([1, 2, 3], [1, 2])).toBe(false);
		expect(partialEquals([1, 2, 3], [1, 2, 3])).toBe(true);
	});

	it("fails when expected key missing", () => {
		expect(partialEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
	});

	it("Map/Set/TypedArray expected values use full equality", () => {
		expect(partialEquals(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(true);
		expect(partialEquals(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
		expect(partialEquals(new Set([1, 2]), new Set([1, 2]))).toBe(true);
		expect(partialEquals(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(
			true,
		);
		expect(partialEquals(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(
			false,
		);
	});
});
