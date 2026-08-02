/**
 * Golden spec — `test.group()` returns the very instance its hooks receive.
 *
 * This body is byte-identical to its twin under `specs/helix/`; only the
 * runner import differs. `golden.test.ts` runs BOTH under their own runner and
 * asserts the emitted event journals match.
 */

import assert from "node:assert/strict";
import { test } from "@japa/runner";

let hookSelf: unknown;
let bodyHandle: unknown;

const group = test.group("identity", (self) => {
	bodyHandle = self;

	self.setup((instance) => {
		hookSelf = instance;
	});

	test("the body handle is the returned group", () => {
		assert.equal(bodyHandle, group);
	});

	test("the setup hook receives the same group", () => {
		assert.equal(hookSelf, group);
	});
});
