/**
 * Self-test: `test.waitForDone()` + the `done` callback (helix parity). The
 * runner must not complete the test until `done()` fires, even though the body
 * returns synchronously.
 */

import { expect, test } from "@c9up/helix";

const order: string[] = [];

test("waitForDone waits for the async done() before completing", (_ctx, done) => {
	// Body returns synchronously; the test must still wait for this callback.
	setTimeout(() => {
		order.push("done-called");
		done();
	}, 15);
}).waitForDone();

test("a plain async test still works without done", async () => {
	await new Promise((r) => setTimeout(r, 1));
	order.push("plain-async");
	expect(true).toBe(true);
});

test("the waitForDone test had completed before later tests ran", () => {
	// If the runner honoured waitForDone, done() fired (order recorded) before
	// this test executed — proving it waited on the callback, not the sync body.
	expect(order[0]).toBe("done-called");
	expect(order).toContain("plain-async");
});
