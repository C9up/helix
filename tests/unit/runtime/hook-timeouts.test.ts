/**
 * A per-test hook that never settles fails its test under the test's timeout,
 * named — instead of hanging the file until the worker is killed and every
 * result in it is lost.
 */

import { describe as vDescribe, expect as vExpect, it as vIt } from "vitest";
import { executeRoot } from "../../../src/runtime/run.js";
import {
	afterEach,
	beforeEach,
	describe,
	resetRoot,
	test,
} from "../../../src/runtime/suite.js";
import { defined } from "../../__helpers__/defined.js";

const never = (): Promise<void> => new Promise(() => {});

vDescribe("per-test hook timeouts", () => {
	vIt(
		"fails the test whose beforeEach hangs, and keeps the others",
		async () => {
			const root = resetRoot();
			test("before the group", () => {});
			describe("hung", () => {
				beforeEach(never);
				test("never reached", () => {});
			});
			const result = await executeRoot(root, "inline", { timeoutMs: 100 });
			vExpect(result.totals).toMatchObject({ pass: 1, fail: 1 });
			vExpect(defined(result.tests[1]).error?.message).toBe(
				"beforeEach hook exceeded 100ms timeout",
			);
		},
	);

	vIt("fails the test whose afterEach hangs", async () => {
		const root = resetRoot();
		describe("hung", () => {
			afterEach(never);
			test("body passes", () => {});
		});
		const result = await executeRoot(root, "inline", { timeoutMs: 100 });
		vExpect(result.totals.fail).toBe(1);
		vExpect(defined(result.tests[0]).error?.message).toBe(
			"afterEach hook exceeded 100ms timeout",
		);
	});

	vIt(
		"bounds test.setup and test.teardown by the test's own timeout",
		async () => {
			const root = resetRoot();
			test("setup hangs", () => {})
				.setup(never)
				.timeout(80);
			test("teardown hangs", () => {}).teardown(never);
			const result = await executeRoot(root, "inline", { timeoutMs: 100 });
			vExpect(result.totals.fail).toBe(2);
			vExpect(defined(result.tests[0]).error?.message).toBe(
				"beforeEach hook exceeded 80ms timeout",
			);
			vExpect(defined(result.tests[1]).error?.message).toBe(
				"afterEach hook exceeded 100ms timeout",
			);
		},
	);

	vIt("leaves a hook unbounded when the timeout is disabled", async () => {
		const root = resetRoot();
		let done = false;
		describe("slow", () => {
			beforeEach(async () => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				done = true;
			});
			test("waits", () => {});
		});
		const result = await executeRoot(root, "inline", { timeoutMs: 0 });
		vExpect(done).toBe(true);
		vExpect(result.totals.pass).toBe(1);
	});
});
