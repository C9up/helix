/**
 * Parity proof mirror — same assertions as `tests/selftest/parity-pass.test.ts`,
 * but run under vitest. Both runners must verdict pass.
 */

import { describe, expect, test } from "vitest";

describe("parity — arithmetic", () => {
	test("addition", () => {
		expect(1 + 2).toBe(3);
		expect(0.1 + 0.2).not.toBe(0.3);
	});

	test("string concatenation", () => {
		expect("a" + "b").toBe("ab");
	});
});

describe("parity — deep object equality", () => {
	test("nested arrays / objects compare structurally", () => {
		const a = { id: 1, tags: ["x", "y"], meta: { v: 2 } };
		const b = { id: 1, tags: ["x", "y"], meta: { v: 2 } };
		expect(a).toEqual(b);
		expect(a).not.toBe(b);
	});
});

describe("parity — error throw", () => {
	test("toThrow with substring", () => {
		expect(() => {
			throw new Error("validation failed: missing 'name'");
		}).toThrow("missing 'name'");
	});
});
