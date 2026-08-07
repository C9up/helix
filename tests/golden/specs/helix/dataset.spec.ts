/**
 * Golden spec — dataset expansion and title interpolation.
 *
 * This body is byte-identical to its twin under `specs/japa/`; only the
 * runner import differs. `golden.test.ts` runs BOTH under their own runner and
 * asserts the emitted event journals match.
 */

import assert from "node:assert/strict";
import { test } from "@c9up/helix";

test("adds {a} and {b} (row {$i})")
	.with([
		{ a: 1, b: 2 },
		{ a: 3, b: 4 },
	])
	.run((_ctx, row) => {
		assert.equal(typeof row.a, "number");
		assert.equal(typeof row.b, "number");
	});

// No interpolation token at all: Japa repeats the SAME title for every row.
// helix used to suffix ` (row N)`; the golden never caught it because every
// spec here happened to use a token.
test("plain title, no token")
	.with([1, 2, 3])
	.run((_ctx, row) => {
		assert.equal(typeof row, "number");
	});

// A primitive row with no token — same rule.
test("primitive rows without a token")
	.with(["a", "b"])
	.run((_ctx, row) => {
		assert.equal(typeof row, "string");
	});
