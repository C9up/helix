/**
 * The test deadline: a real, referenced timer that exists only while a test
 * (or hook) is pending. Referenced, so a test awaiting a promise nothing will
 * settle still times out instead of letting its worker exit. That it never
 * holds a worker open once its test is over is checked on real workers, in
 * tests/integration/error-codes-output.test.ts.
 */

import { describe as vDescribe, expect as vExpect, it as vIt } from "vitest";
import { executeRoot } from "../../../src/runtime/run.js";
import { resetRoot, test } from "../../../src/runtime/suite.js";
import { vi } from "../../../src/runtime/vi/index.js";
import { defined } from "../../__helpers__/defined.js";

const never = (): Promise<void> => new Promise(() => {});

vDescribe("the test deadline", () => {
	vIt("fails a body that never settles with E_HELIX_TIMEOUT", async () => {
		const root = resetRoot();
		test("hangs", never).timeout(50);
		const result = await executeRoot(root, "inline");
		const error = defined(result.tests[0]).error;
		vExpect(error?.code).toBe("E_HELIX_TIMEOUT");
		vExpect(error?.message).toBe('test "hangs" exceeded 50ms timeout');
	});

	vIt("resetTimeout mid-test replaces the deadline", async () => {
		const root = resetRoot();
		test("shortened", async (ctx) => {
			ctx.test.resetTimeout(40);
			await never();
		}).timeout(60_000);
		const result = await executeRoot(root, "inline");
		vExpect(defined(result.tests[0]).error?.message).toBe(
			'test "shortened" exceeded 40ms timeout',
		);
	});

	vIt(
		"still fires under vi.useFakeTimers(), and is not on the fake clock",
		async () => {
			const root = resetRoot();
			let fakeCount: number | undefined;
			test("hangs on a fake clock", async () => {
				vi.useFakeTimers();
				fakeCount = vi.getTimerCount();
				await never();
			}).timeout(50);
			try {
				const result = await executeRoot(root, "inline");
				vExpect(defined(result.tests[0]).error?.code).toBe("E_HELIX_TIMEOUT");
				vExpect(fakeCount).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		},
	);
});
