import { describe as vDescribe, expect as vExpect, it as vIt } from "vitest";
import { expect } from "../../../src/runtime/expect.js";
import { executeRoot } from "../../../src/runtime/run.js";
import { describe, resetRoot, test } from "../../../src/runtime/suite.js";
import {
	applyTaps,
	registerTestTap,
	resetTaps,
} from "../../../src/runtime/suite-taps.js";
import { defined } from "../../__helpers__/defined.js";

vDescribe("allowOnly: false", () => {
	vIt(
		"fails a .only test instead of running it, and still skips the rest",
		async () => {
			const root = resetRoot();
			let ran = false;
			// biome-ignore lint/suspicious/noFocusedTests: helix's own, under test
			test.only("focused", () => {
				ran = true;
			});
			test("other", () => {
				expect(1).toBe(2);
			});
			const result = await executeRoot(root, "inline", { allowOnly: false });
			vExpect(ran).toBe(false);
			vExpect(result.totals).toMatchObject({ pass: 0, fail: 1, skip: 1 });
			vExpect(defined(result.tests[0]).error?.message).toBe(
				"Unexpected .only modifier. Remove it or pass --allow-only to bypass this error",
			);
		},
	);

	vIt("fails every test a focused group selects", async () => {
		const root = resetRoot();
		// biome-ignore lint/suspicious/noFocusedTests: helix's own, under test
		describe.only("focused group", () => {
			test("a", () => {});
			test("b", () => {});
		});
		test("outside", () => {});
		const result = await executeRoot(root, "inline", { allowOnly: false });
		vExpect(result.totals).toMatchObject({ pass: 0, fail: 2, skip: 1 });
	});

	vIt("names .pin() when that is the modifier", async () => {
		const root = resetRoot();
		test("pinned", () => {}).pin();
		const result = await executeRoot(root, "inline", { allowOnly: false });
		vExpect(defined(result.tests[0]).error?.message).toMatch(
			/^Unexpected \.pin\(\) modifier/,
		);
	});

	vIt("changes nothing for a file without a focus modifier", async () => {
		const root = resetRoot();
		test("plain", () => {});
		const result = await executeRoot(root, "inline", { allowOnly: false });
		vExpect(result.totals).toMatchObject({ pass: 1, fail: 0 });
	});

	vIt("keeps .only narrowing the run by default", async () => {
		const root = resetRoot();
		// biome-ignore lint/suspicious/noFocusedTests: helix's own, under test
		test.only("focused", () => {});
		test("other", () => {});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals).toMatchObject({ pass: 1, skip: 1 });
	});
});

vDescribe("pin() through a suite tap", () => {
	// `configureSuite`'s `suite.onTest((t) => t.pin())` is the same `.pin()` as
	// the test handle's: it narrows the run, and fails under CI.
	function pinA(): void {
		registerTestTap((t) => {
			if (t.title === "a") t.pin();
		});
	}

	vIt("narrows the run to the tapped test", async () => {
		const root = resetRoot();
		test("a", () => {});
		test("b", () => {});
		pinA();
		applyTaps(root);
		resetTaps();
		const result = await executeRoot(root, "inline", {});
		vExpect(result.tests.map((t) => `${t.name}:${t.status}`)).toEqual([
			"a:pass",
			"b:skip",
		]);
	});

	vIt("fails the tapped test when .pin() is not allowed", async () => {
		const root = resetRoot();
		test("a", () => {});
		test("b", () => {});
		pinA();
		applyTaps(root);
		resetTaps();
		const result = await executeRoot(root, "inline", { allowOnly: false });
		vExpect(result.totals).toMatchObject({ pass: 0, fail: 1, skip: 1 });
		vExpect(defined(result.tests[0]).error?.message).toMatch(
			/^Unexpected \.pin\(\) modifier/,
		);
	});

	vIt("leaves a skipped test skipped", async () => {
		const root = resetRoot();
		test.skip("a", () => {});
		test("b", () => {});
		pinA();
		applyTaps(root);
		resetTaps();
		const result = await executeRoot(root, "inline", {});
		vExpect(result.totals).toMatchObject({ pass: 1, fail: 0, skip: 1 });
	});
});
