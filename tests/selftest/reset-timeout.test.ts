/**
 * Self-test: `ctx.test.resetTimeout()` (helix parity) re-arms the running test's
 * deadline, and `test(name).with(() => rows).run(...)` accepts a lazy dataset.
 */

import { expect, test } from "@c9up/helix";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("resetTimeout() re-arms the deadline mid-test", async (ctx) => {
	// Timeout is 60ms. Two 40ms waits (=80ms total) would time out — but the
	// reset in between restarts the clock, so each wait sees a fresh 60ms.
	await wait(40);
	ctx.test.resetTimeout();
	await wait(40);
	expect(true).toBe(true);
}).timeout(60);

test("resetTimeout(ms) can set a new duration", async (ctx) => {
	ctx.test.resetTimeout(200);
	await wait(30);
	expect(true).toBe(true);
}).timeout(20);

// Lazy dataset — the function (may be async) is resolved at run time (helix).
test("lazy dataset yields even rows")
	.with(() => [2, 4, 6])
	.run((ctx, row) => {
		expect(row % 2).toBe(0);
		expect(ctx.test.dataset).toEqual([2, 4, 6]);
	});
