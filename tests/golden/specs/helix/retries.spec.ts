/**
 * Golden spec — a flaky test reported once, after its retries.
 *
 * This body is byte-identical to its twin under `specs/japa/`; only the
 * runner import differs. `golden.test.ts` runs BOTH under their own runner and
 * asserts the emitted event journals match.
 */

import assert from "node:assert/strict";
import { test } from "@c9up/helix";

let attempts = 0;

test("passes on the third attempt", () => {
	attempts += 1;
	assert.ok(attempts >= 3, `attempt ${attempts} is too early`);
}).retry(2);
