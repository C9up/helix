/**
 * Self-test: the Japa/Adonis plugin model — `configure({ plugins })`. A plugin
 * extends the injected test context via `api.context.macro` / `.getter`, and
 * pairs that with a `declare module` augmentation for the types.
 */

import { configure, expect, type Plugin, test } from "@c9up/helix";

// A plugin's typing side: augment TestContext (the Japa pattern).
declare module "@c9up/helix" {
	interface TestContext {
		greeting: string;
		counter: number;
	}
}

// A plugin registers context properties. Async is supported (e.g. to boot a
// server before exposing `client`).
let getterCalls = 0;
const greetingPlugin: Plugin = async (api) => {
	api.context.macro("greeting", "hello from plugin");
	// Returns an incrementing value on each COMPUTE — so a cached getter yields
	// the same value on repeated reads within a context, a non-cached one would
	// differ.
	api.context.getter("counter", () => ++getterCalls);
};

// Bootstrap: install plugins before the tests run (collection phase).
await configure({ plugins: [greetingPlugin] });

test("a plugin macro is present on the context", (ctx) => {
	expect(ctx.greeting).toBe("hello from plugin");
});

test("a plugin getter is lazy and cached within a context", (ctx) => {
	const first = ctx.counter;
	// Second read returns the cached value — the getter is not recomputed
	// (otherwise `getterCalls` would increment and the values would differ).
	expect(ctx.counter).toBe(first);
});
