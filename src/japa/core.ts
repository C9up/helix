/**
 * `@japa/runner/core`, as much of it as a PLUGIN touches.
 *
 * An official Japa plugin does not talk to the runner through an interface — it
 * imports the classes and instruments them:
 *
 *     import { Test, TestContext } from "@japa/runner/core"
 *     TestContext.getter("assert", () => new Assert(), true)
 *     Test.executed((test, hasError) => { … })
 *
 * Nothing helix does at runtime can change what that import resolves to, which
 * is why "the API is the same shape" was never enough. What CAN change it is
 * module resolution: `japa-alias.mjs` redirects the specifier to this file, and
 * these two classes forward to helix's own registry. The plugin is then
 * instrumenting helix without knowing it.
 *
 * Deliberately not a reimplementation of Japa's classes: only the STATIC
 * surface a plugin uses is here. Anything else a plugin reached for would be
 * absent rather than wrong, which is the failure mode to prefer.
 */

import { TestContextRegistry } from "../runtime/context.js";
import { registerExecutedHook } from "../runtime/test-context.js";

/** What a plugin's `Test.executed` callback receives. */
export type ExecutedCallback = (
	test: { options: unknown; context: unknown },
	hasError: boolean,
) => void | Promise<void>;

/**
 * Japa's `Test` — the static hooks a plugin registers on it. Instances come
 * from helix's own runtime, so nothing here constructs a test.
 */
export class Test {
	/** Run after every test of the run (Japa `Test.executed`). */
	static executed(callback: ExecutedCallback): void {
		registerExecutedHook(callback);
	}

	/** Japa's `Test.macro`, mapped onto helix's context registry. */
	static macro(name: string, value: unknown): void {
		TestContextRegistry.macro(name, value);
	}
}

/**
 * Japa's `TestContext` — the registrars a plugin uses to put something on every
 * test's context.
 */
export class TestContext {
	/**
	 * Add a lazily-computed property (Japa `TestContext.getter`). Japa's third
	 * argument asks for the value to be cached per context; helix's getters are
	 * always cached per context, so it is accepted and has nothing to change.
	 */
	static getter(
		name: string,
		accumulator: () => unknown,
		_singleton?: boolean,
	): void {
		TestContextRegistry.getter(name, () => accumulator());
	}

	/** Add a shared property (Japa `TestContext.macro`). */
	static macro(name: string, value: unknown): void {
		TestContextRegistry.macro(name, value);
	}
}
