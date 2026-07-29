/**
 * Self-test: helix runs the suite with `NODE_ENV=test` (Adonis/Japa parity).
 *
 * This assertion executes inside a spawned worker, so a pass proves the
 * orchestrator's `process.env.NODE_ENV = "test"` (set in `run()` before the
 * pool spawns) reaches the process where app + test code is actually loaded —
 * across both the native and TS worker pools, which inherit the parent env.
 */

import { expect, test } from "@c9up/helix";

test("helix sets NODE_ENV=test in the worker (Adonis/Japa parity)", () => {
	expect(process.env.NODE_ENV).toBe("test");
});
