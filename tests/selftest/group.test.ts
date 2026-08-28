/**
 * Self-test: `test.group(name, group => …)` (helix parity) — group setup/teardown
 * run once, each.setup/each.teardown run around every test, and the injected
 * context (assert) works inside grouped tests.
 */

import { expect, test } from "@c9up/helix";

const events: string[] = [];

test.group("db suite", (group) => {
	group.setup(() => {
		events.push("setup");
	});
	group.teardown(() => {
		events.push("teardown");
	});
	group.each.setup(() => {
		events.push("each.setup");
	});
	group.each.teardown(() => {
		events.push("each.teardown");
	});

	test("first grouped test uses ctx.assert", ({ assert }) => {
		assert.equal(1, 1);
		events.push("test1");
	});

	test("second grouped test", () => {
		events.push("test2");
	});
});

// This top-level test runs AFTER the group above (collection order), so by the
// time it executes the group's setup + per-test hooks have fired.
test("group hooks fired in the right order", () => {
	// setup once, each.setup/teardown wrap each test, tests ran in order.
	expect(events.indexOf("setup")).toBe(0);
	expect(events.filter((e) => e === "setup")).toHaveLength(1);
	expect(events.filter((e) => e === "each.setup")).toHaveLength(2);
	expect(events.filter((e) => e === "each.teardown")).toHaveLength(2);
	expect(events.indexOf("test1")).toBeLessThan(events.indexOf("test2"));
	// each.setup precedes its test; each.teardown follows it.
	expect(events.indexOf("each.setup")).toBeLessThan(events.indexOf("test1"));
});
