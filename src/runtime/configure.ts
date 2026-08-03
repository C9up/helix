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

import { type CLIArgs, readCLIArgs } from "./cli-args.js";
import { type TestContext, TestContextRegistry } from "./context.js";
import { type Emitter, emitter } from "./emitter.js";
import { Runner } from "./runner.js";

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

/**
 * The API handed to each plugin at {@link configure} time.
 *
 * Japa hands its plugins `{ config, cliArgs, runner, emitter }`; helix passes
 * the same four, so a Japa plugin's body ports over unchanged, plus two helix
 * additions — `context` (Japa reaches the same registry through the imported
 * `TestContext` class) and `cleanup` (Japa uses `config.teardown`).
 */
export interface PluginApi {
	/** The resolved options this run was configured with (Japa `config`). */
	config: Readonly<ConfigureOptions>;
	/** The flags the CLI forwarded to this worker (Japa `cliArgs`). */
	cliArgs: CLIArgs;
	/** Run-level counters, readable once the run ends (Japa `runner`). */
	runner: Runner;
	/** Lifecycle events — `test:start`, `group:end`, … (Japa `emitter`). */
	emitter: Emitter;
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

/**
 * Filters applied to the tests a file declares (Japa `config.filters`).
 *
 * Named deviation: Japa's `filters` also carries `files` and `suites`. Those
 * select which FILES run, and helix settles that list in the CLI process
 * before any worker — and therefore any bootstrap — exists. They stay CLI-side
 * (`--files`, and a suite positional), where they can still avoid a spawn.
 */
export interface ConfigureFilters {
	/** Only tests carrying one of these tags (`~@tag`/`!@tag` excludes). */
	tags?: string[];
	/** Only groups with these exact titles. */
	groups?: string[];
	/** Only tests with these exact titles. */
	tests?: string[];
	/** Require EVERY tag in `tags` instead of any (Japa `--match-all`). */
	matchAll?: boolean;
}

/** Runtime configuration passed to {@link configure}. */
export interface ConfigureOptions {
	/** Plugins to install — each extends the test context (Japa parity). */
	plugins?: Plugin[];
	/**
	 * Filters to apply to this file's tests (Japa `config.filters`). The CLI
	 * flags win: a filter typed at the prompt overrides the configured one.
	 */
	filters?: ConfigureFilters;
	/**
	 * How a test file is imported (Japa `config.importer`). Defaults to
	 * `import(file.href)`. Receives the URL helix would have imported —
	 * cache-busting query included, so repeated runs still re-evaluate.
	 */
	importer?: (file: URL) => void | Promise<void>;
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
	/**
	 * The name of the suite these tests belong to — surfaced as
	 * `ctx.test.options.meta.suite` and on the `suite:*` events. Defaults to
	 * `"default"`, the name Japa gives its implicit suite. Overridden by
	 * `--suite`.
	 */
	suite?: string;
}

/** Teardowns to run after the run — from `configure({ teardown })` + `api.cleanup`. */
const runnerTeardowns: RunnerHook[] = [];

/** Run-level defaults from `configure({ timeout, retries, suite, filters })`. */
interface ConfiguredDefaults {
	timeout?: number;
	retries?: number;
	suite?: string;
	filters?: ConfigureFilters;
	importer?: (file: URL) => void | Promise<void>;
}

const configuredDefaults: ConfiguredDefaults = {};

/** The defaults set by {@link configure}, if any. */
export function getConfiguredDefaults(): Readonly<ConfiguredDefaults> {
	return configuredDefaults;
}

/** Tracks the run by listening to {@link emitter} — handed to plugins. */
const runner = new Runner(emitter);

/** The options the last {@link configure} call resolved to (Japa `config`). */
let resolvedConfig: ConfigureOptions = {};

const api: PluginApi = {
	// A getter so a plugin reads the config of the `configure()` call it is
	// running under, not an empty object captured at module load.
	get config(): Readonly<ConfigureOptions> {
		return resolvedConfig;
	},
	get cliArgs(): CLIArgs {
		return readCLIArgs();
	},
	runner,
	emitter,
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
	resolvedConfig = options;
	if (options.timeout !== undefined)
		configuredDefaults.timeout = options.timeout;
	if (options.retries !== undefined)
		configuredDefaults.retries = options.retries;
	if (options.suite !== undefined) configuredDefaults.suite = options.suite;
	if (options.filters !== undefined)
		configuredDefaults.filters = options.filters;
	if (options.importer !== undefined)
		configuredDefaults.importer = options.importer;
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
