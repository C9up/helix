/**
 * Golden spec — pass / fail / skip / todo / tags, as reported to a reporter.
 *
 * This body is byte-identical to its twin under `specs/japa/`; only the
 * runner import differs. `golden.test.ts` runs BOTH under their own runner and
 * asserts the emitted event journals match.
 */

import assert from "node:assert/strict";
import { test } from "@c9up/helix";

test("passes", () => {
	assert.equal(1, 1);
});

test("fails", () => {
	assert.equal(1, 2);
});

test("is skipped", () => {
	throw new Error("a skipped body never runs");
}).skip();

test("is a todo");

test("carries tags", () => {
	assert.ok(true);
}).tags(["@slow"]);
