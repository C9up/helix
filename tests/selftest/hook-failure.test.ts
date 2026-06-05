/**
 * Self-test: hook-failure attribution.
 *
 * Verifies the runtime's `runtime/run.ts` `attributeHookFailure`
 * logic — when a `beforeAll` / `beforeEach` hook throws, every
 * descendant test is marked failed (not skipped, not passed) and
 * each carries the hook's error.
 *
 * Strategy: build a `SuiteNode` programmatically (NOT via the global
 * `describe`/`test` registry, which would interleave with this very
 * test) and call `executeRoot` directly. The OUTER selftest passes
 * because we INSPECT the inner FileResult — we don't let the inner
 * failure propagate to the outer runner.
 */

import { describe, expect, test } from "@c9up/helix";
import type {
	Hook,
	SuiteNode,
	SuiteResult,
	TestNode,
	TestResult,
} from "@c9up/helix/runtime";
import { executeRoot } from "@c9up/helix/runtime";

function flattenTests(suites: SuiteResult[]): TestResult[] {
	const out: TestResult[] = [];
	for (const s of suites) {
		for (const child of s.children) {
			if ("status" in child && !("children" in child)) {
				out.push(child as TestResult);
			} else {
				out.push(...flattenTests([child as SuiteResult]));
			}
		}
	}
	return out;
}

function makeSuite(name: string, parent: SuiteNode | undefined): SuiteNode {
	return {
		kind: "suite",
		name,
		mode: "run",
		parent,
		children: [],
		hooks: [],
	};
}

function makeTest(name: string, parent: SuiteNode, fn: () => void): TestNode {
	return {
		kind: "test",
		name,
		fn,
		mode: "run",
		parent,
	};
}

function addHook(suite: SuiteNode, hook: Hook): void {
	suite.hooks.push(hook);
}

describe("hook-failure — attribution", () => {
	test("a throwing beforeAll fails every descendant test", async () => {
		const root = makeSuite("__root__", undefined);
		const inner = makeSuite("inner", root);
		root.children.push(inner);
		addHook(inner, {
			type: "beforeAll",
			fn: () => {
				throw new Error("boom-before-all");
			},
		});
		let test1Ran = false;
		let test2Ran = false;
		inner.children.push(
			makeTest("t1", inner, () => {
				test1Ran = true;
			}),
		);
		inner.children.push(
			makeTest("t2", inner, () => {
				test2Ran = true;
			}),
		);

		const result = await executeRoot(root, "synthetic-file.ts");

		// Neither test body ran — the hook short-circuited the suite.
		expect(test1Ran).toBe(false);
		expect(test2Ran).toBe(false);

		// The descendant tests are reported, both failed, both carrying
		// the hook's error.
		const flat = flattenTests(result.suites).concat(result.tests);
		expect(flat.length).toBeGreaterThanOrEqual(2);
		const failed = flat.filter((t) => t.status === "fail");
		expect(failed.length).toBeGreaterThanOrEqual(2);
		expect(failed[0].error?.message).toContain("boom-before-all");
	});

	test("a throwing beforeEach fails the next test but later siblings", async () => {
		const root = makeSuite("__root__", undefined);
		const inner = makeSuite("inner", root);
		root.children.push(inner);
		addHook(inner, {
			type: "beforeEach",
			fn: () => {
				throw new Error("boom-before-each");
			},
		});
		inner.children.push(makeTest("t1", inner, () => {}));
		inner.children.push(makeTest("t2", inner, () => {}));

		const result = await executeRoot(root, "synthetic-file.ts");

		const flat = flattenTests(result.suites).concat(result.tests);
		const failed = flat.filter((t) => t.status === "fail");
		// At LEAST one test fails because of the hook error; runtime may
		// also fail t2 (each iteration runs beforeEach).
		expect(failed.length).toBeGreaterThanOrEqual(1);
		expect(failed[0].error?.message).toContain("boom-before-each");
	});
});
