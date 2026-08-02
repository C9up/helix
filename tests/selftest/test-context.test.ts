/**
 * Self-test: the injected TestContext (Japa parity).
 *
 * Proves the foundation the capability plugins build on:
 *   - every test body receives a context object as its FIRST argument,
 *   - `TestContextRegistry.macro` / `.getter` graft properties onto it,
 *   - getters are lazy + cached per context,
 *   - `ctx.cleanup(fn)` runs after the test (verified across two tests).
 */

import { expect, TestContextRegistry, test } from "@c9up/helix";

// Typing side: plugins pair a runtime registration with a declaration-merge so
// `ctx.answer` / `ctx.lazy` are fully typed (the Japa pattern).
declare module "@c9up/helix" {
	interface TestContext {
		answer: number;
		lazy: string;
	}
}

// Registered during the collection phase (module load), before any test runs.
TestContextRegistry.macro("answer", 42);

let getterCalls = 0;
TestContextRegistry.getter("lazy", () => {
	getterCalls += 1;
	return "computed";
});

let cleanupRan = false;

test("context is injected with cleanup + registered macro", (ctx) => {
	expect(typeof ctx.cleanup).toBe("function");
	expect(ctx.answer).toBe(42);
	ctx.cleanup(() => {
		cleanupRan = true;
	});
});

test("getter is lazy and cached per context", (ctx) => {
	const before = getterCalls;
	expect(ctx.lazy).toBe("computed"); // first read → computes
	expect(ctx.lazy).toBe("computed"); // second read → cached
	expect(getterCalls).toBe(before + 1);
});

test("cleanup from a previous test ran after it finished", () => {
	expect(cleanupRan).toBe(true);
});
