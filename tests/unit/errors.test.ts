import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors } from "../../src/index.js";

describe("errors", () => {
	it("are exported from the entry as flare exceptions, one class per code", () => {
		const error = new errors.E_HELIX_TIMEOUT(["test", 50]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toMatchObject({
			code: "E_HELIX_TIMEOUT",
			status: 500,
			message: "test exceeded 50ms timeout",
		});
		for (const [name, ErrorClass] of Object.entries(errors)) {
			expect(ErrorClass.code).toBe(name);
		}
	});

	it("keeps what a reporter renders on E_HELIX_ASSERTION_FAILED", () => {
		const error = new errors.E_HELIX_ASSERTION_FAILED({
			message: "expected 1 to be 2",
			actual: 1,
			expected: 2,
			operator: "toBe",
		});
		expect(error).toBeInstanceOf(Exception);
		expect(error).toMatchObject({
			code: "E_HELIX_ASSERTION_FAILED",
			status: 500,
			name: "AssertionError",
			actual: 1,
			expected: 2,
			operator: "toBe",
			showDiff: true,
		});
	});
});
