/**
 * A plugin may replace `assert`; it may not replace `cleanup` or `test`.
 *
 * helix ships an assert, and refusing the override left `@japa/assert`
 * registered but never reached — `plugins: [assert()]` looked wired and did
 * nothing. `cleanup` and `test` stay reserved: the runtime hands them to the
 * body and a test with someone else's `cleanup` is not a test.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	buildTestContext,
	TestContextRegistry,
} from "../../../src/runtime/context.js";
import type { TestInstance } from "../../../src/runtime/suite.js";

afterEach(() => {
	TestContextRegistry.clear();
});

/** A whole TestInstance — a partial one only typechecks by lying about it. */
function instance(): TestInstance {
	return {
		title: "t",
		fullName: "t",
		options: {
			title: "t",
			timeout: 0,
			retries: 0,
			tags: [],
			isTodo: false,
			isFailing: false,
			meta: {},
		},
		isPinned: false,
		resetTimeout: () => {},
		cleanup: () => {},
	};
}

describe("context registry vs the built-ins", () => {
	it("lets a plugin replace assert", () => {
		const mine = { plan: () => {} };
		TestContextRegistry.getter("assert", () => mine);

		expect(buildTestContext(instance()).assert).toBe(mine);
	});

	it("keeps cleanup and test to itself", () => {
		TestContextRegistry.macro("cleanup", "hijacked");
		TestContextRegistry.macro("test", "hijacked");

		const ctx = buildTestContext(instance());
		expect(ctx.cleanup).not.toBe("hijacked");
		expect(ctx.test).not.toBe("hijacked");
	});
});
