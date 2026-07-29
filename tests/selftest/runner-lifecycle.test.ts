/**
 * Self-test: `configure({ setup, teardown })` + `api.cleanup` runner lifecycle.
 * `setup` runs at configure time; `teardown`/`api.cleanup` fire after the run
 * (drained by the worker — simulated here via `drainRunnerTeardowns`).
 */

import { configure, drainRunnerTeardowns, expect, test } from "@c9up/helix";

let setupRan = false;
const order: string[] = [];

await configure({
	setup: [
		() => {
			setupRan = true;
		},
	],
	teardown: [
		() => {
			order.push("teardown");
		},
	],
	plugins: [
		(api) => {
			api.cleanup(() => {
				order.push("api.cleanup");
			});
		},
	],
});

test("configure setup ran immediately, teardowns are deferred", () => {
	expect(setupRan).toBe(true);
	expect(order).toEqual([]);
});

test("drainRunnerTeardowns runs teardown + api.cleanup (reverse order)", async () => {
	await drainRunnerTeardowns();
	// Registration order is api.cleanup (during plugins) then teardown (after),
	// so the reverse drain runs teardown first, then api.cleanup.
	expect(order).toEqual(["teardown", "api.cleanup"]);
	// Draining is idempotent — the registry is cleared.
	await drainRunnerTeardowns();
	expect(order).toEqual(["teardown", "api.cleanup"]);
});
