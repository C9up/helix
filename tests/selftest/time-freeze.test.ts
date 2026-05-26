/**
 * Self-test: `helix.time` end-to-end through the helix runtime.
 *
 * Auto-restore is verified by two sequential tests — the first
 * freezes time and never unfreezes; the second asserts the real
 * clock is back. This is the strongest signal that the per-test
 * `withTestContext` frame drains the cleanup queue between tests.
 *
 * Helix is agnostic — no `@c9up/chronos` import. We test that
 * `Date.now()` and `new Date()` reflect the frozen epoch; downstream
 * libraries that read "now" via those primitives inherit the pin.
 */

import { afterEach, describe, expect, test, time } from "@c9up/helix";

describe("helix.time.freeze — pins clock for the test", () => {
	afterEach(() => {
		// Defensive — the per-test frame already auto-restores, but a
		// direct `unfreeze()` keeps tests independent if the frame
		// shape ever changes.
		time.unfreeze();
	});

	test("freeze pins Date.now and new Date()", () => {
		time.freeze("2026-01-01T00:00:00Z");
		expect(Date.now()).toBe(1767225600000);
		// `new Date()` (no args) constructor is also shimmed — assert
		// via toISOString to hit a different path than Date.now().
		expect(new Date().toISOString()).toBe("2026-01-01T00:00:00.000Z");
	});

	test("freeze + travel composes (calendar arithmetic)", () => {
		time.freeze("2026-01-01T00:00:00Z");
		time.travel(7, "day");
		expect(new Date(Date.now()).toISOString()).toBe("2026-01-08T00:00:00.000Z");
	});

	test("frozenAt reports the pinned epoch", () => {
		time.freeze("2030-06-15T12:00:00Z");
		expect(time.frozenAt()).toBe(Date.parse("2030-06-15T12:00:00Z"));
	});

	test("freeze accepts a duck-typed { toMillis } input", () => {
		const dtLike = { toMillis: () => Date.parse("2027-07-07T07:07:07Z") };
		time.freeze(dtLike);
		expect(Date.now()).toBe(Date.parse("2027-07-07T07:07:07Z"));
	});
});

describe("helix.time — auto-restore between tests", () => {
	test("test A freezes the clock and never unfreezes", () => {
		time.freeze("2099-12-31T23:59:59Z");
		expect(new Date(Date.now()).toISOString()).toBe("2099-12-31T23:59:59.000Z");
	});

	test("test B sees the real clock (auto-restored after test A)", () => {
		// `frozenAt()` must report null — the per-test frame ran the
		// cleanup queued by test A's `freeze` call.
		expect(time.frozenAt()).toBeNull();
	});
});

describe("helix.time.unfreeze — explicit early restore", () => {
	test("unfreeze mid-test, then freeze again, both observable", () => {
		time.freeze("2026-01-01T00:00:00Z");
		expect(time.frozenAt()).not.toBeNull();
		time.unfreeze();
		expect(time.frozenAt()).toBeNull();
		time.freeze("2030-01-01T00:00:00Z");
		expect(new Date(Date.now()).toISOString()).toBe("2030-01-01T00:00:00.000Z");
	});
});

describe("helix.time.travel — implicit freeze", () => {
	test("travel without prior freeze freezes relative to real now", () => {
		// Smoke check — after travel, frozenAt() is non-null.
		time.travel(1, "hour");
		expect(time.frozenAt()).not.toBeNull();
	});
});
