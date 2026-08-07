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
import { Emitter } from "../runtime/emitter.js";
import { registerExecutedHook } from "../runtime/test-context.js";

/**
 * `Emitter` is helix's own — same event names, same node shapes, verified by
 * the golden journals. A plugin subscribing through it subscribes to the run.
 */
export { Emitter };

/**
 * Japa's `Refiner` — a filter collector. Standalone until something reads it,
 * which is why `configure({ refiner })` is where one becomes load-bearing; this
 * class is what a plugin constructs to put there.
 */
export class Refiner {
	readonly filters: {
		tests: string[];
		groups: string[];
		tags: string[];
		matchAll: boolean;
	} = { tests: [], groups: [], tags: [], matchAll: false };

	add(layer: "tests" | "groups" | "tags", values: string[]): this {
		this.filters[layer].push(...values);
		return this;
	}

	matchAllTags(toggle = true): this {
		this.filters.matchAll = toggle;
		return this;
	}
}

/**
 * Raised by the classes a plugin can IMPORT but not construct.
 *
 * They exist so an import resolves and `instanceof` answers — a helix group is
 * not a Japa `Group`, and `false` is the right answer. Constructing one is what
 * cannot work: helix builds its own tree and drives its own run, so a Japa
 * `Suite` or `Runner` built here would be an object nothing ever looks at.
 */
export class JapaClassNotConstructibleError extends Error {
	constructor(name: string) {
		super(
			`new ${name}() is not available on helix: it builds its own test tree ` +
				"and drives its own run, so an instance here would be one nothing " +
				`reads. The class exists so \`import { ${name} }\` resolves and ` +
				"`instanceof` answers.",
		);
		this.name = "JapaClassNotConstructibleError";
	}
}

/** Japa's `BaseReporter`. Reporters are the CLI's — see `runner.registerReporter`. */
export class BaseReporter {
	constructor() {
		throw new JapaClassNotConstructibleError("BaseReporter");
	}
}

/** Japa's `Group`. helix builds groups from the file's own `describe`/`test`. */
export class Group {
	constructor() {
		throw new JapaClassNotConstructibleError("Group");
	}
}

/** Japa's `Suite`. helix's suites come from the config, one per worker. */
export class Suite {
	constructor() {
		throw new JapaClassNotConstructibleError("Suite");
	}
}

/** Japa's `Runner`. The CLI owns execution — see `RunnerNotDrivableError`. */
export class Runner {
	constructor() {
		throw new JapaClassNotConstructibleError("Runner");
	}
}

/** What a plugin's `Test.executed` callback receives. */
export type ExecutedCallback = (
	test: { options: unknown; context: unknown },
	hasError: boolean,
) => void | Promise<void>;

/**
 * Japa's `Test` — the static hooks a plugin registers on it. Instances come
 * from helix's own runtime, so nothing here constructs a test.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: stands in for a class Japa exports — an object literal breaks the day a plugin writes `instanceof` or `extends`, which is the one place being a class is the point.
export class Test {
	/**
	 * Tells the shim apart from the real `@japa/runner/core`. A plugin never
	 * needs it; it exists so "which one did this import resolve to?" has an
	 * answer, which is a question that costs an afternoon otherwise.
	 */
	static readonly isHelixShim = true;

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
// biome-ignore lint/complexity/noStaticOnlyClass: same as `Test` above — it replaces an exported class, not a namespace.
export class TestContext {
	/** @see Test.isHelixShim */
	static readonly isHelixShim = true;

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
