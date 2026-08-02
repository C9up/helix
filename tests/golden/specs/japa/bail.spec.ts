/**
 * Golden spec — bail — what runs after the first failure.
 *
 * This body is byte-identical to its twin under `specs/helix/`; only the
 * runner import differs. `golden.test.ts` runs BOTH under their own runner and
 * asserts the emitted event journals match.
 */

import assert from "node:assert/strict";
import { test } from "@japa/runner";

test.group("first", () => {
	test("passes before the failure", () => {
		assert.ok(true);
	});

	test("fails and trips the bail", () => {
		assert.equal(1, 2);
	});

	test("comes after the failure", () => {
		assert.ok(true);
	});
});

test.group("second", () => {
	test("belongs to the next group", () => {
		assert.ok(true);
	});
});
