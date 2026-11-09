/**
 * `expect(p).resolves` / `.rejects` the body never awaited. The assertion
 * settles after the body returned, so without tracking it the test passed and
 * the failure went nowhere (or, on the TypeScript pool, surfaced as an
 * unhandled rejection that discarded the whole file). Each one now belongs to
 * the test that started it.
 */

import { describe as vDescribe, expect as vExpect, it as vIt } from "vitest";
import { expect } from "../../../src/runtime/expect.js";
import { executeRoot } from "../../../src/runtime/run.js";
import { resetRoot, test } from "../../../src/runtime/suite.js";
import { defined } from "../../__helpers__/defined.js";

function later<T>(value: T, ms = 30): Promise<T> {
	return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function laterReject(ms = 30): Promise<never> {
	return new Promise((_, reject) =>
		setTimeout(() => reject(new Error("nope")), ms),
	);
}

vDescribe("un-awaited async assertions", () => {
	vIt("fails the test that forgot to await a failing .resolves", async () => {
		const root = resetRoot();
		test("forgot to await", () => {
			expect(later(1)).resolves.toBe(2);
		});
		test("a sibling", () => {
			expect(1).toBe(1);
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals).toMatchObject({ pass: 1, fail: 1 });
		const failed = defined(result.tests[0]);
		vExpect(failed.name).toBe("forgot to await");
		vExpect(failed.error?.message).toMatch(/expected 1 to be 2/);
	});

	vIt("passes a test whose un-awaited assertion holds", async () => {
		const root = resetRoot();
		test("forgot to await, but it is right", () => {
			expect(later(1)).resolves.toBe(1);
			expect(laterReject()).rejects.toThrow("nope");
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals).toMatchObject({ pass: 1, fail: 0 });
	});

	vIt("fails on an un-awaited .rejects whose promise resolved", async () => {
		const root = resetRoot();
		test("expected a rejection", () => {
			expect(later("fine")).rejects.toThrow();
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.fail).toBe(1);
		vExpect(defined(result.tests[0]).error?.message).toMatch(
			/expected promise to reject/,
		);
	});

	vIt(
		"attributes an assertion that already failed before the body returned",
		async () => {
			const root = resetRoot();
			test("settles early", async () => {
				expect(Promise.resolve(1)).resolves.toBe(2);
				await later(undefined, 20);
			});
			const result = await executeRoot(root, "inline");
			vExpect(result.totals.fail).toBe(1);
			vExpect(defined(result.tests[0]).error?.message).toMatch(
				/expected 1 to be 2/,
			);
		},
	);

	vIt("leaves an awaited assertion exactly as before", async () => {
		const root = resetRoot();
		test("awaited and failing", async () => {
			await expect(later(1)).resolves.toBe(2);
		});
		test("awaited and caught on purpose", async () => {
			await expect(later(1))
				.resolves.toBe(2)
				.catch(() => undefined);
		});
		const result = await executeRoot(root, "inline");
		vExpect(defined(result.tests[0]).status).toBe("fail");
		vExpect(defined(result.tests[0]).error?.message).toMatch(
			/expected 1 to be 2/,
		);
		// The body saw the rejection and chose to handle it: not reported twice.
		vExpect(defined(result.tests[1]).status).toBe("pass");
	});

	vIt(
		"bounds an un-awaited assertion that never settles by the test timeout",
		async () => {
			const root = resetRoot();
			test("never settles", () => {
				expect(new Promise(() => {})).resolves.toBe(1);
			});
			const result = await executeRoot(root, "inline", { timeoutMs: 100 });
			vExpect(result.totals.fail).toBe(1);
			vExpect(defined(result.tests[0]).error?.message).toMatch(
				/exceeded 100ms timeout/,
			);
		},
	);
});
