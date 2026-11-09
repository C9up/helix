import { test } from "../../../src/runtime/index.js";

/** Stuck outside the reach of any test timeout: the event loop never turns. */
test("never yields", () => {
	for (;;) {
		// spin
	}
});
