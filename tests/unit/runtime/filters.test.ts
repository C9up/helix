/**
 * helix-parity CLI filters at the executeRoot level: `--tags` (OR by default,
 * `--match-all` for AND, `~`/`!` to exclude), `--tests` (exact leaf titles),
 * and `--groups` (exact enclosing-group titles).
 */

import { describe as vDescribe, expect as vExpect, it as vIt } from "vitest";
import { executeRoot, type FileResult } from "../../../src/runtime/run.js";
import { resetRoot, test } from "../../../src/runtime/suite.js";

function statusOf(result: FileResult, name: string): string | undefined {
	return result.tests.find((t) => t.name === name)?.status;
}

vDescribe("run — helix filters", () => {
	vIt("--tags is OR by default (any required tag)", async () => {
		const root = resetRoot();
		test("a", () => {}, { tags: ["@a"] });
		test("b", () => {}, { tags: ["@b"] });
		test("c", () => {}, { tags: ["@c"] });
		const result = await executeRoot(root, "inline", { tags: ["@a", "@b"] });
		vExpect(statusOf(result, "a")).toBe("pass");
		vExpect(statusOf(result, "b")).toBe("pass");
		vExpect(statusOf(result, "c")).toBe("skip");
	});

	vIt("--match-all requires every tag (AND)", async () => {
		const root = resetRoot();
		test("both", () => {}, { tags: ["@a", "@b"] });
		test("onlyA", () => {}, { tags: ["@a"] });
		const result = await executeRoot(root, "inline", {
			tags: ["@a", "@b"],
			matchAll: true,
		});
		vExpect(statusOf(result, "both")).toBe("pass");
		vExpect(statusOf(result, "onlyA")).toBe("skip");
	});

	vIt("~@tag and !@tag both exclude", async () => {
		const root = resetRoot();
		test("slow1", () => {}, { tags: ["@slow"] });
		test("fast1", () => {}, { tags: ["@fast"] });
		const tilde = await executeRoot(root, "inline", { tags: ["~@slow"] });
		vExpect(statusOf(tilde, "slow1")).toBe("skip");
		vExpect(statusOf(tilde, "fast1")).toBe("pass");

		const root2 = resetRoot();
		test("slow2", () => {}, { tags: ["@slow"] });
		test("fast2", () => {}, { tags: ["@fast"] });
		const bang = await executeRoot(root2, "inline", { tags: ["!@slow"] });
		vExpect(statusOf(bang, "slow2")).toBe("skip");
		vExpect(statusOf(bang, "fast2")).toBe("pass");
	});

	vIt("--tests filters by exact leaf title", async () => {
		const root = resetRoot();
		test("keep me", () => {});
		test("drop me", () => {});
		const result = await executeRoot(root, "inline", { tests: ["keep me"] });
		vExpect(statusOf(result, "keep me")).toBe("pass");
		vExpect(statusOf(result, "drop me")).toBe("skip");
	});

	vIt("--groups filters by enclosing group title", async () => {
		const root = resetRoot();
		test.group("G1", () => {
			test("in g1", () => {});
		});
		test.group("G2", () => {
			test("in g2", () => {});
		});
		const result = await executeRoot(root, "inline", { groups: ["G1"] });
		vExpect(statusOf(result, "in g1")).toBe("pass");
		vExpect(statusOf(result, "in g2")).toBe("skip");
	});
});
