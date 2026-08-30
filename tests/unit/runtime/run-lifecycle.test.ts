/**
 * The runner's lifecycle corners: a skipped describe, a failing hook, and a
 * body that reports completion itself.
 *
 * A suite that is skipped still has to REPORT its tests, or a run silently
 * loses them from the count; a hook that throws has to fail its suite rather
 * than the test that happened to be next.
 */
import { describe as vDescribe, expect as vExpect, it as vIt } from "vitest";
import { executeRoot } from "../../../src/runtime/run.js";
import {
	afterAll,
	beforeAll,
	describe,
	resetRoot,
	test,
} from "../../../src/runtime/suite.js";

vDescribe("helix > a skipped suite still reports what is inside it", () => {
	vIt("counts every test it holds as skipped", async () => {
		const root = resetRoot();
		describe.skip("group", () => {
			test("a", () => {});
			test("b", () => {});
		});

		const result = await executeRoot(root, "inline");

		// Losing them from the count makes a skipped suite look like a smaller
		// test suite rather than a paused one.
		vExpect(result.totals.skip).toBe(2);
		vExpect(result.totals.pass).toBe(0);
	});

	vIt("keeps a todo inside it a todo, not a skip", async () => {
		const root = resetRoot();
		describe.skip("group", () => {
			test("someday");
			test("b", () => {});
		});

		const result = await executeRoot(root, "inline");

		vExpect(result.totals.todo).toBe(1);
		vExpect(result.totals.skip).toBe(1);
	});

	vIt("descends into nested suites", async () => {
		const root = resetRoot();
		describe.skip("outer", () => {
			describe("inner", () => {
				test("deep", () => {});
			});
		});

		const result = await executeRoot(root, "inline");

		vExpect(result.totals.skip).toBe(1);
	});

	vIt("runs none of the bodies", async () => {
		const root = resetRoot();
		let ran = false;
		describe.skip("group", () => {
			test("a", () => {
				ran = true;
			});
		});

		await executeRoot(root, "inline");

		vExpect(ran).toBe(false);
	});
});

vDescribe("helix > a hook that throws fails its suite", () => {
	vIt("fails the suite when beforeAll throws", async () => {
		const root = resetRoot();
		describe("group", () => {
			beforeAll(() => {
				throw new Error("setup blew up");
			});
			test("a", () => {});
		});

		const result = await executeRoot(root, "inline");

		vExpect(result.totals.fail).toBeGreaterThan(0);
	});

	vIt(
		"fails the suite when afterAll throws, after the tests passed",
		async () => {
			const root = resetRoot();
			let ran = false;
			describe("group", () => {
				afterAll(() => {
					throw new Error("teardown blew up");
				});
				test("a", () => {
					ran = true;
				});
			});

			const result = await executeRoot(root, "inline");

			// The test really ran; the suite is still not healthy.
			vExpect(ran).toBe(true);
			vExpect(result.suites[0]?.status).toBe("fail");
		},
	);

	vIt("collects the failure rather than stopping the run", async () => {
		const root = resetRoot();
		describe("bad", () => {
			afterAll(() => {
				throw new Error("boom");
			});
			test("a", () => {});
		});
		describe("good", () => {
			test("b", () => {});
		});

		const result = await executeRoot(root, "inline");

		vExpect(result.totals.pass).toBe(2);
		vExpect(result.suites.some((s) => s.status === "fail")).toBe(true);
	});
});

vDescribe("helix > a body that signals completion itself", () => {
	vIt("waits for done() rather than for the body to return", async () => {
		const root = resetRoot();
		let finished = false;
		test("async work", (_ctx, done: (error?: unknown) => void) => {
			setTimeout(() => {
				finished = true;
				done();
			}, 5);
		}).waitForDone();

		const result = await executeRoot(root, "inline");

		// Returning is not finishing here — the callback decides.
		vExpect(finished).toBe(true);
		vExpect(result.totals.pass).toBe(1);
	});

	vIt(
		"fails fast when the body rejects instead of waiting for done()",
		async () => {
			const root = resetRoot();
			test("async work", async () => {
				throw new Error("boom");
			}).waitForDone();

			const result = await executeRoot(root, "inline");

			// Without this the run would hang until the timeout on a body that
			// already told us it failed.
			vExpect(result.totals.fail).toBe(1);
		},
	);

	vIt("reports the error done() was handed", async () => {
		const root = resetRoot();
		test("async work", (_ctx, done: (error?: unknown) => void) => {
			setTimeout(() => done(new Error("reported")), 5);
		}).waitForDone();

		const result = await executeRoot(root, "inline");

		vExpect(result.totals.fail).toBe(1);
	});
});
