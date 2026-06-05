/**
 * Fixture exercising every `safeValue` branch in `worker.ts` — each test
 * fails with an assertion whose `actual` / `expected` contains something
 * `JSON.stringify` would choke on.
 */
import { expect, test } from "../../../src/runtime/index.js";

test("bigint", () => {
	expect(1n).toBe(2n);
});

test("symbol", () => {
	expect(Symbol("x")).toBe(Symbol("y"));
});

test("function", () => {
	expect(() => 1).toBe(() => 2);
});

test("circular object", () => {
	type Cyc = { self?: Cyc };
	const a: Cyc = {};
	a.self = a;
	expect(a).toEqual({ self: { self: { self: null } } });
});

test("Map with object keys", () => {
	const m = new Map<object, number>();
	m.set({ k: 1 }, 10);
	expect(m).toEqual(new Map([[{ k: 1 }, 99]]));
});

test("Set of objects", () => {
	expect(new Set([{ a: 1 }])).toEqual(new Set([{ a: 2 }]));
});

test("Date", () => {
	expect(new Date(0)).toEqual(new Date(1000));
});

test("RegExp", () => {
	expect(/a/g).toEqual(/b/i);
});

test("Error instance", () => {
	expect(new Error("a")).toEqual(new Error("b"));
});
