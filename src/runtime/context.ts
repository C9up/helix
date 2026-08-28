/**
 * Injected test context — helix's defining mechanism.
 *
 * Every test body (and, later, group hooks) receives a `TestContext` as its
 * FIRST argument: `test("x", ({ assert, client, db, cleanup }) => …)`. The
 * context is EXTENSIBLE via declaration merging: capability plugins (HTTP
 * client, DB, fakes) both register a runtime property through
 * {@link TestContextRegistry} AND augment the `TestContext` interface:
 *
 *     declare module "@c9up/helix" {
 *       interface TestContext { client: ApiClient }
 *     }
 *
 * This is what lets `@c9up/helix/http`, `@c9up/helix/db`, … graft `client`,
 * `db`, … onto the context — fully typed — without the core depending on those
 * packages.
 *
 * Backwards compatible: passing the context as the first arg is a no-op for
 * existing zero-argument bodies (`test("x", () => …)`), which ignore it.
 */

import { type Assert, createAssert } from "./assert.js";
import type { TestInstance } from "./suite.js";
import { registerTestCleanup, type TestCleanup } from "./test-context.js";

/**
 * The per-test context. `cleanup` is always present; capability plugins add
 * `assert`, `client`, `db`, … by augmenting this interface (declaration
 * merging) alongside a matching {@link TestContextRegistry} registration.
 */
/**
 * A CLASS (not an interface) so plugins can add REQUIRED properties via
 * declaration merging — `declare module "@c9up/helix" { interface TestContext {
 * client: ApiClient } }` — without breaking the core's construction (an external
 * augmentation is not subject to helix's `strictPropertyInitialization`). This
 * is exactly how helix's `TestContext` works.
 */
export class TestContext {
	/**
	 * Add a shared property to every test context — helix's
	 * `TestContext.macro('sleep', fn)`, callable on the class itself so a helix
	 * plugin's registration code ports over unchanged.
	 */
	static macro(name: string, value: unknown): void {
		TestContextRegistry.macro(name, value);
	}

	/** Add a lazily-computed, per-context property (`TestContext.getter`). */
	static getter(name: string, fn: Getter): void {
		TestContextRegistry.getter(name, fn);
	}

	/** Chai-flavored assertions (`helix's assert` parity), alongside `expect`. */
	readonly assert: Assert;
	/** The running test's own instance — name, options, dataset (`ctx.test`). */
	readonly test: TestInstance;

	constructor(test: TestInstance) {
		this.assert = createAssert();
		this.test = test;
	}

	/**
	 * Register a teardown that runs at the end of THIS test, regardless of
	 * outcome (`ctx.cleanup`). Reverse-insertion order, isolated failures.
	 */
	cleanup(fn: TestCleanup): void {
		// Falls through to the active per-test frame; a false return means we were
		// called outside a frame (defensive — the runner always wraps).
		registerTestCleanup(fn);
	}
}

// Invoked with `this` bound to the context AND the context as the first arg, so
// both helix's `function () { return this.foo }` and `(ctx) => ctx.foo` work.
export type Getter = (this: TestContext, ctx: TestContext) => unknown;

const macros = new Map<string, unknown>();
const getters = new Map<string, Getter>();

/**
 * Registry through which plugins extend the test context at runtime. Mirrors
 * helix's `TestContext.macro(name, value)` / `TestContext.getter(name, fn)`.
 * Pair each call with a `declare module` augmentation for the types.
 */
export const TestContextRegistry = {
	/** Add a shared property present on every test context. */
	macro(name: string, value: unknown): void {
		macros.set(name, value);
	},
	/**
	 * Add a lazily-computed, per-context property. The getter runs the first
	 * time the property is read on a given context (inside that test's frame),
	 * and the result is cached for that context.
	 */
	getter(name: string, fn: Getter): void {
		getters.set(name, fn);
	},
	/** Remove a macro/getter (plugin teardown, tests). No arg clears all. */
	clear(name?: string): void {
		if (name === undefined) {
			macros.clear();
			getters.clear();
		} else {
			macros.delete(name);
			getters.delete(name);
		}
	},
	/** Whether any extension is registered under `name`. */
	has(name: string): boolean {
		return macros.has(name) || getters.has(name);
	},
};

/**
 * Build a fresh `TestContext` for one test attempt. MUST be called inside the
 * per-test frame (`withTestContext`) so `ctx.cleanup` reaches the right frame.
 * Applies registered macros (own value), then getters (lazy, cached per
 * context). Dynamic props are attached via `defineProperty` so no `cleanup`
 * override and no cast are needed.
 */
export function buildTestContext(test: TestInstance): TestContext {
	const ctx = new TestContext(test);
	// `cleanup` and `test` are structural — the runtime hands them to the body
	// and nothing may take their place. `assert` is NOT: helix ships one, and a
	// project installing `helix's assert` is asking for that one instead. Refusing
	// the override left the plugin registered but never reached, which is how
	// `plugins: [assert()]` could look wired and do nothing.
	const reserved = new Set(["cleanup", "test"]);

	for (const [name, value] of macros) {
		if (reserved.has(name)) continue;
		Object.defineProperty(ctx, name, {
			value,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}

	for (const [name, fn] of getters) {
		if (reserved.has(name)) continue;
		let computed = false;
		let cached: unknown;
		Object.defineProperty(ctx, name, {
			enumerable: true,
			configurable: true,
			get() {
				if (!computed) {
					cached = fn.call(ctx, ctx);
					computed = true;
				}
				return cached;
			},
		});
	}

	return ctx;
}
