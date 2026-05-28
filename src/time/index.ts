/**
 * `@c9up/helix/time` — time freeze / travel for tests.
 *
 * Pins `Date.now()`, `new Date()`, and `DateTime.now()` to a fake
 * epoch. Auto-restored after each test via the per-test frame.
 *
 *   import { time } from "@c9up/helix";
 *
 *   time.freeze("2026-01-01");
 *   // ... test that depends on a fixed clock
 *   time.travel(7, "day");
 *   expect(DateTime.now().toISO()).toMatch(/^2026-01-08/);
 */

export type { TimeUnit } from "./freeze.js";
export { freeze, frozenAt, travel, travelTo, unfreeze } from "./freeze.js";
