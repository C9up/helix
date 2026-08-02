/**
 * Golden spec — group hooks and their execution order.
 *
 * This body is byte-identical to its twin under `specs/helix/`; only the
 * runner import differs. `golden.test.ts` runs BOTH under their own runner and
 * asserts the emitted event journals match.
 */

import assert from "node:assert/strict";
import { test } from "@japa/runner";

const order: string[] = [];

test.group("lifecycle", (group) => {
	group.setup(() => {
		order.push("setup");
	});

	group.teardown(() => {
		order.push("teardown");
	});

	group.each.setup(() => {
		order.push("each.setup");
	});

	group.each.teardown(() => {
		order.push("each.teardown");
	});

	test("first", () => {
		order.push("first");
	});

	test("second", () => {
		assert.deepEqual(order, [
			"setup",
			"each.setup",
			"first",
			"each.teardown",
			"each.setup",
		]);
	});
});
