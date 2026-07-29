/**
 * Injected test context — Japa's defining mechanism.
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
export interface TestContext {
	/**
	 * Register a teardown that runs at the end of THIS test, regardless of
	 * outcome (Japa `ctx.cleanup`). Reverse-insertion order, isolated failures.
	 */
	cleanup(fn: TestCleanup): void;
	/** Chai-flavored assertions (`@japa/assert` parity), alongside `expect`. */
	assert: Assert;
	/** The running test's own instance — name, options, dataset (Japa `ctx.test`). */
	test: TestInstance;
}

type Getter = (ctx: TestContext) => unknown;

const macros = new Map<string, unknown>();
const getters = new Map<string, Getter>();

/**
 * Registry through which plugins extend the test context at runtime. Mirrors
 * Japa's `TestContext.macro(name, value)` / `TestContext.getter(name, fn)`.
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
	const ctx: TestContext = {
		cleanup(fn: TestCleanup): void {
			// Falls through to the active per-test frame; a false return means we
			// were called outside a frame (defensive — the runner always wraps).
			registerTestCleanup(fn);
		},
		assert: createAssert(),
		test,
	};

	for (const [name, value] of macros) {
		if (name === "cleanup") continue;
		Object.defineProperty(ctx, name, {
			value,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}

	for (const [name, fn] of getters) {
		if (name === "cleanup") continue;
		let computed = false;
		let cached: unknown;
		Object.defineProperty(ctx, name, {
			enumerable: true,
			configurable: true,
			get() {
				if (!computed) {
					cached = fn(ctx);
					computed = true;
				}
				return cached;
			},
		});
	}

	return ctx;
}
