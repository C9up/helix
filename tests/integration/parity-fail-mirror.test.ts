/**
 * Parity mirror — same failure-shape assertions as
 * `tests/selftest/parity-fail.test.ts`, run under vitest.
 */

import { describe, expect, test } from "vitest";

describe("parity — failure shape", () => {
	test("a failing toBe throws an Error mentioning both sides", () => {
		let caught: unknown;
		try {
			expect(1).toBe(2);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		const msg = (caught as Error).message;
		expect(msg).toContain("1");
		expect(msg).toContain("2");
	});

	test("a failing toThrow on a non-throwing fn throws an Error", () => {
		let caught: unknown;
		try {
			expect(() => 42).toThrow();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		const msg = (caught as Error).message.toLowerCase();
		expect(msg).toContain("throw");
	});
});
