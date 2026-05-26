/**
 * Self-test: DSL surface (test, describe, expect matchers).
 *
 * Runs under helix's own CLI — proves the runtime DSL is functional
 * end-to-end. Vitest never touches this file (excluded from
 * `vitest.config.ts`).
 */

import { describe, expect, test } from "@c9up/helix";

test("test() registers and executes a passing case", () => {
	expect(true).toBe(true);
});

describe("expect — equality matchers", () => {
	test("toBe uses Object.is identity", () => {
		expect(1 + 1).toBe(2);
		expect("hello").toBe("hello");
		const obj = { a: 1 };
		expect(obj).toBe(obj);
	});

	test("toEqual deep-compares structures", () => {
		expect({ a: 1, b: [2, 3] }).toEqual({ a: 1, b: [2, 3] });
		expect([1, [2, [3]]]).toEqual([1, [2, [3]]]);
	});

	test("toEqual distinguishes shallow-equal but deep-different", () => {
		expect(() => {
			expect({ a: { b: 1 } }).toEqual({ a: { b: 2 } });
		}).toThrow();
	});
});

describe("expect — type / value matchers", () => {
	test("toBeDefined / toBeUndefined", () => {
		expect(1).toBeDefined();
		expect(undefined).toBeUndefined();
	});

	test("toBeNull", () => {
		expect(null).toBeNull();
	});

	test("toContain on arrays and strings", () => {
		expect([1, 2, 3]).toContain(2);
		expect("hello world").toContain("world");
	});

	test("toMatch with regex and string", () => {
		expect("hello world").toMatch(/world/);
		expect("hello world").toMatch("world");
	});

	test("toHaveLength", () => {
		expect([1, 2, 3]).toHaveLength(3);
		expect("abc").toHaveLength(3);
	});
});

describe("expect — throw matcher", () => {
	test("toThrow catches a synchronous throw", () => {
		expect(() => {
			throw new Error("boom");
		}).toThrow();
	});

	test("toThrow with message substring", () => {
		expect(() => {
			throw new Error("boom: cascade failure");
		}).toThrow("cascade");
	});

	test("not.toThrow when the function returns cleanly", () => {
		expect(() => 42).not.toThrow();
	});
});

describe("describe — nested suites preserve path", () => {
	describe("level 2", () => {
		describe("level 3", () => {
			test("deeply nested test still runs", () => {
				expect(true).toBe(true);
			});
		});
	});
});
