/**
 * Self-test: helix-parity DSL fixes — `tags(array, strategy)` (replace default,
 * append/prepend), and `skip(function)`.
 */

import { expect, test } from "@c9up/helix";

test("tags(array) replaces by default", (ctx) => {
	expect(ctx.test.options.tags).toEqual(["@a", "@b"]);
}).tags(["@a", "@b"]);

test("tags append + prepend strategies", (ctx) => {
	// replace → ['@x'], append '@y' → ['@x','@y'], prepend '@w' → ['@w','@x','@y'].
	expect(ctx.test.options.tags).toEqual(["@w", "@x", "@y"]);
})
	.tags(["@x"])
	.tags(["@y"], "append")
	.tags(["@w"], "prepend");

test("a single-string tag is accepted", (ctx) => {
	expect(ctx.test.options.tags).toEqual(["@solo"]);
}).tags("@solo");

test("skip(function) skips when it returns true", () => {
	expect(1).toBe(2); // would fail — skipped by the condition below
}).skip(() => true, "conditionally skipped");

test("skip(function) does NOT skip when it returns false", () => {
	expect(1).toBe(1);
}).skip(() => false);
