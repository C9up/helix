/**
 * `configure({ plugins })` — the Japa/AdonisJS bootstrap entry.
 *
 * Following Japa precisely: the runtime core is plugin-agnostic, and every
 * capability (HTTP `client`, `db`, fakes, …) ships as a PLUGIN that extends the
 * injected test context. A plugin is a function handed a {@link PluginApi};
 * it registers context properties via `api.context.macro` / `.getter` (the
 * `TestContext.macro`/`getter` of Japa) and pairs that with a `declare module`
 * augmentation for the types.
 *
 *   // tests/bootstrap.ts
 *   import { configure } from "@c9up/helix";
 *   import { apiClient } from "@c9up/ream/testing";
 *   await configure({ plugins: [apiClient({ baseUrl })] });
 *
 * This keeps `@c9up/helix` (the core) free of any ecosystem dependency: the
 * plugins live in each package's `/testing` subpath and depend on helix, never
 * the other way round — the Japa "runner + plugins" topology.
 */

import { type TestContext, TestContextRegistry } from "./context.js";

/**
 * What a plugin uses to extend the test context. Mirrors Japa's
 * `TestContext.macro(name, value)` / `TestContext.getter(name, fn)`.
 */
export interface PluginContext {
	/** Add a shared property present on every test context. */
	macro(name: string, value: unknown): void;
	/** Add a lazily-computed, per-context property (cached per context). */
	getter(name: string, fn: (ctx: TestContext) => unknown): void;
}

/** The API handed to each plugin at {@link configure} time. */
export interface PluginApi {
	/** Extend the injected test context. */
	context: PluginContext;
}

/**
 * A helix plugin — the Japa plugin shape adapted to helix. Runs once at
 * bootstrap; may be async (e.g. to boot a server before registering `client`).
 */
export type Plugin = (api: PluginApi) => void | Promise<void>;

/** Runtime configuration passed to {@link configure}. */
export interface ConfigureOptions {
	/** Plugins to install — each extends the test context (Japa parity). */
	plugins?: Plugin[];
}

const api: PluginApi = {
	context: {
		macro: (name, value) => TestContextRegistry.macro(name, value),
		getter: (name, fn) => TestContextRegistry.getter(name, fn),
	},
};

/**
 * Install plugins. Runs each in order, awaiting async ones so every context
 * extension is registered before the first test executes. Call this once from a
 * bootstrap file (Japa/AdonisJS `bin/test.ts` / `tests/bootstrap.ts`).
 */
export async function configure(options: ConfigureOptions): Promise<void> {
	for (const plugin of options.plugins ?? []) {
		await plugin(api);
	}
}
