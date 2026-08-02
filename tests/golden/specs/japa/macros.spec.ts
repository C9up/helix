/**
 * Golden spec — resource macros (`test.macro`) and `t.cleanup`.
 *
 * This body is byte-identical to its twin under `specs/helix/`; only the
 * runner import differs. `golden.test.ts` runs BOTH under their own runner and
 * asserts the emitted event journals match.
 */

import assert from "node:assert/strict";
import { test } from "@japa/runner";

const cleaned: string[] = [];

const useResource = test.macro((t, label: string) => {
	t.cleanup(() => {
		cleaned.push(label);
	});
	return `resource:${label}`;
});

test("a resource macro binds the running test", () => {
	assert.equal(useResource("db"), "resource:db");
	// The cleanup belongs to THIS test — it has not fired yet.
	assert.deepEqual(cleaned, []);
});

test("the macro cleanup ran once its test finished", () => {
	assert.deepEqual(cleaned, ["db"]);
});
