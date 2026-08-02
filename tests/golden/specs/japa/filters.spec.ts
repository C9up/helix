/**
 * Golden spec — tag / title / group filtering, driven by the same CLI flags.
 *
 * This body is byte-identical to its twin under `specs/helix/`; only the
 * runner import differs. `golden.test.ts` runs BOTH under their own runner and
 * asserts the emitted event journals match.
 */

import assert from "node:assert/strict";
import { test } from "@japa/runner";

test.group("alpha", () => {
	test("plain alpha test", () => {
		assert.ok(true);
	});

	test("tagged alpha test", () => {
		assert.ok(true);
	}).tags(["@slow", "@db"]);
});

test.group("beta", () => {
	test("plain beta test", () => {
		assert.ok(true);
	});

	test("tagged beta test", () => {
		assert.ok(true);
	}).tags(["@slow"]);
});
