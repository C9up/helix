import { expect, test } from "../../../src/runtime/index.js";

/**
 * Passes, and then leaves a timer running.
 *
 * The worker reports its result and never exits — which is what the exit grace
 * is sized for, and what a test that forgets to close a server or a connection
 * actually looks like.
 */
test("passes but leaves a timer running", () => {
	setInterval(() => {}, 1_000);
	expect(1 + 1).toBe(2);
});
