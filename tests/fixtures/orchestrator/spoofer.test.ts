/**
 * Fixture that tries to spoof a fake `__HELIX_RESULT__` line on stderr.
 * The pool's nonce check must reject it; the real test must still fail.
 */
import { expect, test } from "../../../src/runtime/index.js";

process.stderr.write(
	`__HELIX_RESULT__${JSON.stringify({
		type: "result",
		result: {
			file: "spoofed",
			suites: [],
			tests: [],
			totals: { pass: 999, fail: 0, skip: 0, todo: 0 },
			durationMs: 0,
		},
		nonce: "not-the-real-nonce",
	})}\n`,
);

test("real test fails intentionally", () => {
	expect(1).toBe(2);
});
