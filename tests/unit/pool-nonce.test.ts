import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resultNonce, runPool } from "../../src/cli/pool.js";

const crypto = vi.hoisted(() => ({ fail: false }));

vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		randomBytes: (size: number) => {
			if (crypto.fail) throw new Error("entropy source unavailable");
			return actual.randomBytes(size);
		},
	};
});

afterEach(() => {
	crypto.fail = false;
});

const silent = {
	onFileStart() {},
	onFileResult() {},
	onFileError() {},
	onSummary() {},
};

/**
 * The nonce is what keeps test code from forging `__HELIX_RESULT__` frames.
 * It used to end in `Date.now()` and `Math.random()`, which code under test
 * can guess; it is now 128 bits from the OS CSPRNG, like the native pool's.
 */
describe("resultNonce", () => {
	it("is the pid then 32 hex characters of OS randomness", () => {
		expect(resultNonce()).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{32}$`));
	});

	it("differs on every draw", () => {
		expect(resultNonce()).not.toBe(resultNonce());
	});

	it("fails the file without spawning a worker when the OS has no randomness", async () => {
		crypto.fail = true;
		// A worker that cannot be spawned: reaching the spawn would add a
		// different error, so a lone nonce error proves the pool stopped first.
		const { results, errors } = await runPool(
			["a.test.ts"],
			{
				workerEntry: "/nonexistent/worker.js",
				nodeBin: "/nonexistent/node",
				threads: 1,
			},
			silent,
		);
		expect(results).toEqual([]);
		expect(errors).toEqual([
			{
				file: path.resolve("a.test.ts"),
				message:
					"cannot draw the result nonce from the OS random source: entropy source unavailable",
			},
		]);
	});
});
