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
