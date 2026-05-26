/**
 * Parity proof — failure case.
 *
 * Captures a deliberate assertion failure in-process and verifies the
 * thrown error has the expected shape. Mirror in
 * `tests/integration/parity-fail-mirror.test.ts` exercises the same
 * pattern under vitest. When both runners agree on the error shape,
 * we have a compat proof for failure semantics.
 *
 * In-process capture (rather than spawning a child helix) avoids
 * recursive CLI invocations and keeps the test fast and reliable.
 */

import { describe, expect, test } from "@c9up/helix";

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
