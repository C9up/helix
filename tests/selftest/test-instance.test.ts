/**
 * Self-test: the Japa Test model — `ctx.test` instance, `test(name).with().run()`
 * datasets, per-test `setup`/`teardown`, `cleanup(hasError, test)` args, and
 * conditional `skip(condition)`.
 */

import { expect, test } from "@c9up/helix";

test("ctx.test exposes the running test's instance", (ctx) => {
	expect(ctx.test.title).toBe("ctx.test exposes the running test's instance");
	expect(ctx.test.fullName).toContain(ctx.test.title);
	expect(ctx.test.options.timeout).toBeGreaterThan(0);
	expect(ctx.test.isPinned).toBe(false);
	expect(ctx.test.dataset).toBeUndefined();
});

const rows = [
	{ a: 1, b: 2, sum: 3 },
	{ a: 4, b: 5, sum: 9 },
];
// Japa dataset API: `test(name).with(rows).run((ctx, row) => …)`.
test("adds a + b")
	.with(rows)
	.run((ctx, row) => {
		expect(row.a + row.b).toBe(row.sum);
		// The full dataset is available on the instance.
		expect(ctx.test.dataset).toBe(rows);
	});

const order: string[] = [];
test("per-test setup/teardown wrap the body", (ctx) => {
	// setup already ran before the body.
	expect(order).toEqual(["setup"]);
	order.push("body");
	ctx.cleanup(() => order.push("cleanup"));
})
	.setup(() => {
		order.push("setup");
	})
	.teardown(() => {
		order.push("teardown");
	});

let cleanupArgs: { hasError: boolean | undefined; title: string | undefined } =
	{
		hasError: undefined,
		title: undefined,
	};
test("cleanup receives (hasError, test)", (ctx) => {
	ctx.cleanup((hasError, t) => {
		cleanupArgs = { hasError, title: t?.title };
	});
	expect(true).toBe(true);
});

test("setup ran, teardown+cleanup ran after the earlier test", () => {
	// setup → body → teardown (in runAttempt) → cleanup (frame-drain finally).
	expect(order).toEqual(["setup", "body", "teardown", "cleanup"]);
	// From "cleanup receives (hasError, test)": passing test → hasError false.
	expect(cleanupArgs.hasError).toBe(false);
	expect(cleanupArgs.title).toBe("cleanup receives (hasError, test)");
});

test("skip(condition) skips only when true", () => {
	expect(1).toBe(2); // would fail — but the condition below skips it
}).skip(true, "intentionally skipped");

test("skip(false) does NOT skip", () => {
	expect(1).toBe(1);
}).skip(false);

// F5: an async skip condition is awaited at run time (a Promise used to be
// truthy → always-skip). This one resolves false, so the test MUST run.
test("skip(async () => false) does NOT skip", () => {
	expect(1).toBe(1);
}).skip(async () => false);

test("skip(async () => true) skips when the promise resolves true", () => {
	expect(1).toBe(2); // would fail — but the async condition skips it
}).skip(async () => true);

// F4: a test declared with no body is reported as `todo`, not a silent pass.
test("a bodiless test is reported as todo");

// F3 primary form: `test(name, fn).with(rows)` re-homes the body and runs it
// once per row (Japa's main dataset shape).
let rehomedRuns = 0;
test("primary-form dataset re-homes the body", (ctx) => {
	rehomedRuns += 1;
	expect(ctx.test.dataset).toEqual([10, 20]);
}).with([10, 20]);

test("primary-form dataset ran once per row", () => {
	expect(rehomedRuns).toBe(2);
});
