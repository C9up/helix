/**
 * Self-test: group-level test defaults (Japa parity) — `group.each.timeout`,
 * `group.each.retry`, and `group.tap`.
 */

import { expect, test } from "@c9up/helix";

test.group("group defaults", (group) => {
	group.each.timeout(4321);
	group.tap((t) => t.tags("@tapped"));

	test("a test inherits group each.timeout + tap tags", (ctx) => {
		expect(ctx.test.options.timeout).toBe(4321);
		expect(ctx.test.options.tags).toContain("@tapped");
	});
});

let attempts = 0;
test.group("group retry", (group) => {
	group.each.retry(2);

	// Fails on the first attempt, passes on the retry — proves the group-level
	// retry default reaches the test (no per-test .retry()).
	test("retried on failure via group each.retry", () => {
		attempts += 1;
		if (attempts < 2) throw new Error("flaky first attempt");
	});
});

test("the group-retry test actually retried", () => {
	expect(attempts).toBe(2);
});
