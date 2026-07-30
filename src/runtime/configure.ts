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

/** A runner-level hook (setup/teardown), run once around the whole run. */
export type RunnerHook = () => void | Promise<void>;

/** The API handed to each plugin at {@link configure} time. */
export interface PluginApi {
	/** Extend the injected test context. */
	context: PluginContext;
	/**
	 * Register a teardown that runs ONCE after all tests in the run finish
	 * (reverse registration order) — the place to close a booted server, a DB
	 * pool, etc. (Japa runner-teardown parity). Without this, a plugin that boots
	 * a resource at `configure()` has no clean shutdown point.
	 */
	cleanup(fn: RunnerHook): void;
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
	/** Run once before the tests (Japa runner `setup`). */
	setup?: RunnerHook[];
	/** Run once after the tests, reverse order (Japa runner `teardown`). */
	teardown?: RunnerHook[];
	/**
	 * Default per-test timeout in ms for this file's tests (Japa `configure({
	 * timeout })`). `0` disables. Overridden by `--timeout` and by a per-test
	 * `test.timeout(ms)` / `{ timeout }`.
	 */
	timeout?: number;
	/**
	 * Default extra attempts on failure for this file's tests (Japa `configure({
	 * retries })`). Overridden by `--retries` and by a per-test `test.retry(n)`.
	 */
	retries?: number;
}

/** Teardowns to run after the run — from `configure({ teardown })` + `api.cleanup`. */
const runnerTeardowns: RunnerHook[] = [];

/** Run-level defaults from `configure({ timeout, retries })`, read by the runtime. */
const configuredDefaults: { timeout?: number; retries?: number } = {};

/** The `timeout`/`retries` defaults set by {@link configure}, if any. */
export function getConfiguredDefaults(): Readonly<{
	timeout?: number;
	retries?: number;
}> {
	return configuredDefaults;
}

const api: PluginApi = {
	context: {
		macro: (name, value) => TestContextRegistry.macro(name, value),
		getter: (name, fn) => TestContextRegistry.getter(name, fn),
	},
	cleanup: (fn) => {
		runnerTeardowns.push(fn);
	},
};

/**
 * Install plugins + runner hooks. Runs each plugin in order (awaiting async
 * ones) so every context extension is registered before the first test runs.
 * `setup` hooks run now; `teardown` hooks + `api.cleanup` fire after the run
 * (see {@link drainRunnerTeardowns}). Call once from a bootstrap file
 * (Japa/AdonisJS `bin/test.ts` / `tests/bootstrap.ts`).
 */
export async function configure(options: ConfigureOptions): Promise<void> {
	if (options.timeout !== undefined)
		configuredDefaults.timeout = options.timeout;
	if (options.retries !== undefined)
		configuredDefaults.retries = options.retries;
	for (const fn of options.setup ?? []) await fn();
	for (const plugin of options.plugins ?? []) {
		await plugin(api);
	}
	for (const fn of options.teardown ?? []) runnerTeardowns.push(fn);
}

/**
 * Run every registered runner teardown (reverse order), then clear them — called
 * by the runtime after a file's tests finish. Failures are logged, not thrown,
 * so one bad teardown can't hide the test results.
 */
export async function drainRunnerTeardowns(): Promise<void> {
	for (let i = runnerTeardowns.length - 1; i >= 0; i -= 1) {
		try {
			await runnerTeardowns[i]();
		} catch (err) {
			console.error("[helix] runner teardown failed:", err);
		}
	}
	runnerTeardowns.length = 0;
}
