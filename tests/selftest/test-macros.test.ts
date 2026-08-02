/**
 * Self-test: Japa Test-surface parity —
 *   - `Test.macro(name, fn)` extends every handle (class-level, chainable);
 *   - `test.macro(callback)` builds a resource macro whose `t` carries `cleanup`;
 *   - `test.group()` returns the SAME instance its hooks receive (`self === group`).
 */

import { expect, Test, test } from "@c9up/helix";

// --- Test.macro: class-level handle extension (chainable) ---
// Typing side: a macro pairs a runtime registration with a declaration merge.
declare module "@c9up/helix" {
	interface TestHandle {
		asSlow(): TestHandle;
	}
}

// Registered during collection, before the test that uses it is declared.
// `this` is contextually typed as the TestHandle from `Test.macro`'s signature.
Test.macro("asSlow", function () {
	this.tags(["@slow"], "append");
	return this;
});

test("Test.macro extends the handle and chains", (ctx) => {
	expect(ctx.test.options.tags).toContain("@slow");
	// ctx.test.options carries the title + isTodo (Japa parity).
	expect(ctx.test.options.title).toBe(
		"Test.macro extends the handle and chains",
	);
	expect(ctx.test.options.isTodo).toBe(false);
}).asSlow();

// --- test.macro: resource macro receiving the running test `t` (Japa parity) ---
let cleaned = false;
const useResource = test.macro((t, label: string) => {
	t.cleanup(() => {
		cleaned = true;
	});
	return `resource:${label}`;
});

test("test.macro returns a bound fn and exposes t.cleanup", () => {
	const handle = useResource("db");
	// The callback's return value flows back out of the bound fn.
	expect(handle).toBe("resource:db");
	// The cleanup is registered for THIS test — it hasn't fired yet.
	expect(cleaned).toBe(false);
});

test("the resource macro's cleanup ran after its test finished", () => {
	expect(cleaned).toBe(true);
});

// --- test.group returns the SAME instance passed to its hooks (Japa `self === group`) ---
let bodyHandle: unknown;
let hookSelf: unknown;
const group = test.group("returning group", (g) => {
	// Captured for comparison after `group` is bound (it's in the TDZ here).
	bodyHandle = g;
	g.setup((self) => {
		hookSelf = self;
	});
	test("inner test runs", () => {
		expect(1).toBe(1);
	});
	// `ctx.test.options.meta.group` is the enclosing Group object (Japa parity),
	// not a bare name — and the SAME instance the body/hooks/return share.
	test("meta.group is the enclosing group instance", (ctx) => {
		expect(ctx.test.options.meta.group).toBe(group);
	});
});

test("test.group returned the group instance", () => {
	expect(group.title).toBe("returning group");
	expect(group.fullName).toBe("returning group");
	// The handle passed to the body IS the returned instance.
	expect(bodyHandle).toBe(group);
});

test("group hooks receive the same instance the body returned", () => {
	expect(hookSelf).toBe(group);
});
