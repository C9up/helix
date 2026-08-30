/**
 * The handle a `test()` call returns — `.skip()`, `.pin()`, `.fails()`,
 * `.setup()`, `.teardown()`, `.with()` and friends.
 *
 * These are the knobs a test file reaches for, and each one changes whether a
 * test runs, how it is judged, or what runs around it. A knob that quietly
 * does nothing is worse than an absent one: the file reads as though the
 * intent was expressed.
 */
import { describe as vDescribe, expect as vExpect, it as vIt } from "vitest";
import { expect } from "../../../src/runtime/expect.js";
import { executeRoot } from "../../../src/runtime/run.js";
import { resetRoot, test } from "../../../src/runtime/suite.js";

vDescribe("helix > .fails() inverts the verdict", () => {
	vIt("counts a throwing test as a pass", async () => {
		const root = resetRoot();
		test("known broken", () => {
			throw new Error("boom");
		}).fails();

		const result = await executeRoot(root, "inline");

		vExpect(result.totals.pass).toBe(1);
		vExpect(result.totals.fail).toBe(0);
	});

	vIt(
		"counts a passing test as a failure — the bug was fixed and nobody said",
		async () => {
			const root = resetRoot();
			test("no longer broken", () => {}).fails();

			const result = await executeRoot(root, "inline");

			vExpect(result.totals.fail).toBe(1);
		},
	);

	vIt("carries the reason it was given", async () => {
		const root = resetRoot();
		test("known broken", () => {
			throw new Error("boom");
		}).fails("waiting on upstream");

		const result = await executeRoot(root, "inline");

		vExpect(result.totals.pass).toBe(1);
	});
});

vDescribe("helix > .skip() decides whether a test runs", () => {
	vIt("skips on a plain true", async () => {
		const root = resetRoot();
		let ran = false;
		test("skipped", () => {
			ran = true;
		}).skip();

		const result = await executeRoot(root, "inline");

		vExpect(ran).toBe(false);
		vExpect(result.totals.skip).toBe(1);
	});

	vIt("runs on a false condition", async () => {
		const root = resetRoot();
		let ran = false;
		test("kept", () => {
			ran = true;
		}).skip(false);

		await executeRoot(root, "inline");

		vExpect(ran).toBe(true);
	});

	vIt("defers a function condition to run time", async () => {
		const root = resetRoot();
		let asked = false;
		let ran = false;
		test("conditional", () => {
			ran = true;
		}).skip(() => {
			asked = true;
			return true;
		});

		// Not consulted at collection: the condition may depend on something
		// the file has not set up yet.
		vExpect(asked).toBe(false);

		const result = await executeRoot(root, "inline");

		vExpect(asked).toBe(true);
		vExpect(ran).toBe(false);
		vExpect(result.totals.skip).toBe(1);
	});

	vIt("awaits an async condition", async () => {
		const root = resetRoot();
		let ran = false;
		test("conditional", () => {
			ran = true;
		}).skip(async () => true);

		await executeRoot(root, "inline");

		vExpect(ran).toBe(false);
	});

	vIt("runs when the deferred condition says no", async () => {
		const root = resetRoot();
		let ran = false;
		test("conditional", () => {
			ran = true;
		}).skip(() => false);

		await executeRoot(root, "inline");

		vExpect(ran).toBe(true);
	});
});

vDescribe("helix > .pin() narrows the run to itself", () => {
	vIt("runs the pinned test and leaves the others", async () => {
		const root = resetRoot();
		let pinned = false;
		let other = false;
		test("pinned", () => {
			pinned = true;
		}).pin();
		test("other", () => {
			other = true;
		});

		await executeRoot(root, "inline");

		vExpect(pinned).toBe(true);
		vExpect(other).toBe(false);
	});
});

vDescribe("helix > .setup() and .teardown() bracket one test", () => {
	vIt("runs them around the body, in order", async () => {
		const root = resetRoot();
		const events: string[] = [];
		test("bracketed", () => {
			events.push("body");
		})
			.setup(() => {
				events.push("setup");
			})
			.teardown(() => {
				events.push("teardown");
			});

		await executeRoot(root, "inline");

		vExpect(events).toEqual(["setup", "body", "teardown"]);
	});

	vIt("runs several of each, in the order declared", async () => {
		const root = resetRoot();
		const events: string[] = [];
		test("bracketed", () => {
			events.push("body");
		})
			.setup(() => {
				events.push("setup-1");
			})
			.setup(() => {
				events.push("setup-2");
			})
			.teardown(() => {
				events.push("teardown-1");
			});

		await executeRoot(root, "inline");

		vExpect(events).toEqual(["setup-1", "setup-2", "body", "teardown-1"]);
	});

	vIt("still tears down after a failing body", async () => {
		const root = resetRoot();
		let torn = false;
		test("fails", () => {
			throw new Error("boom");
		}).teardown(() => {
			torn = true;
		});

		const result = await executeRoot(root, "inline");

		// A teardown skipped on failure leaks whatever the setup allocated.
		vExpect(result.totals.fail).toBe(1);
		vExpect(torn).toBe(true);
	});
});

vDescribe("helix > .with() turns one test into a row per case", () => {
	vIt("runs the body once per row", async () => {
		const root = resetRoot();
		const seen: number[] = [];
		test("each", (_ctx, row: number) => {
			seen.push(row);
		}).with([1, 2, 3]);

		const result = await executeRoot(root, "inline");

		vExpect(seen).toEqual([1, 2, 3]);
		vExpect(result.totals.pass).toBe(3);
	});

	vIt("takes the body through .run() instead", async () => {
		const root = resetRoot();
		const seen: number[] = [];
		test("each")
			.with([1, 2])
			.run((_ctx, row) => {
				seen.push(row);
			});

		const result = await executeRoot(root, "inline");

		vExpect(seen).toEqual([1, 2]);
		vExpect(result.totals.pass).toBe(2);
	});

	vIt("resolves the rows at run time, so an async source works", async () => {
		const root = resetRoot();
		const seen: number[] = [];
		test("each", (_ctx, row: number) => {
			seen.push(row);
		}).with(async () => [7, 8]);

		await executeRoot(root, "inline");

		vExpect(seen).toEqual([7, 8]);
	});

	vIt(
		"makes a body-less test runnable again instead of leaving it a todo",
		async () => {
			const root = resetRoot();
			let ran = 0;
			test("was a todo")
				.with([1])
				.run(() => {
					ran += 1;
				});

			const result = await executeRoot(root, "inline");

			vExpect(ran).toBe(1);
			vExpect(result.totals.todo).toBe(0);
		},
	);

	vIt("reports each row separately when one of them fails", async () => {
		const root = resetRoot();
		test("each", (_ctx, row: number) => {
			expect(row).toBeLessThan(3);
		}).with([1, 2, 3]);

		const result = await executeRoot(root, "inline");

		vExpect(result.totals.pass).toBe(2);
		vExpect(result.totals.fail).toBe(1);
	});
});
