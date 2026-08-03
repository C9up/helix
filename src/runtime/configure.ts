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

import { type CLIArgs, cliArgs } from "./cli-args.js";
import { type TestContext, TestContextRegistry } from "./context.js";
import { type Emitter, emitter } from "./emitter.js";
import { Runner } from "./runner.js";
import {
	makeSuiteHandle,
	type SuiteHook,
	type SuiteHookCleanup,
	setCurrentSuite,
} from "./suite-taps.js";

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

/** A runner-level hook — Japa's shape, defined once in `suite-taps.ts`. */
export type RunnerHook = SuiteHook;
export type RunnerHookCleanup = SuiteHookCleanup;

/**
 * The API handed to each plugin at {@link configure} time.
 *
 * Japa hands its plugins `{ config, cliArgs, runner, emitter }`; helix passes
 * the same four, so a Japa plugin's body ports over unchanged, plus two helix
 * additions — `context` (Japa reaches the same registry through the imported
 * `TestContext` class) and `cleanup` (Japa uses `config.teardown`).
 */
export interface PluginApi {
	/**
	 * The options this run was configured with (Japa `config`). Mutable: Japa
	 * plugins edit it, and helix reads it back once every plugin has run.
	 */
	config: ConfigureOptions;
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

/** Undos returned by `setup` hooks — drained BEFORE the teardowns. */
const runnerCleanups: RunnerHookCleanup[] = [];

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
	// running under, not an empty object captured at module load. Japa lets a
	// plugin EDIT it (that is how a plugin raises the default timeout), so the
	// object is handed over mutable and read back after every plugin has run.
	get config(): ConfigureOptions {
		return resolvedConfig;
	},
	// The same object every access, for the same reason: a plugin that writes
	// `api.cliArgs.tags = [...]` must actually steer the run.
	get cliArgs(): CLIArgs {
		return cliArgs();
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
 * Install plugins + runner hooks. Call once from a bootstrap file
 * (Japa/AdonisJS `bin/test.ts` / `tests/bootstrap.ts`).
 *
 * Order follows Japa: PLUGINS first, then the run's `setup` hooks, then the
 * `teardown` hooks are parked for after the run (see {@link
 * drainRunnerTeardowns}). That ordering is what makes a plugin's edits count —
 * it can raise `config.timeout`, push a `setup` hook, or reach for
 * `runner.onSuite`, and the run picks all of it up because nothing has been
 * read yet.
 */
export async function configure(options: ConfigureOptions): Promise<void> {
	resolvedConfig = options;
	// Hook arrays a plugin can append to (through `runner.onSuite`) — they must
	// exist before the plugins run, and they are the very arrays drained below.
	resolvedConfig.setup ??= [];
	resolvedConfig.teardown ??= [];
	const setup = resolvedConfig.setup;
	const teardown = resolvedConfig.teardown;
	setCurrentSuite(makeSuiteHandle(options.suite ?? "default", setup, teardown));

	for (const plugin of resolvedConfig.plugins ?? []) {
		await plugin(api);
	}

	// Read the defaults back AFTER the plugins, so a plugin that edited the
	// config steers the run rather than writing into a value already consumed.
	if (resolvedConfig.timeout !== undefined)
		configuredDefaults.timeout = resolvedConfig.timeout;
	if (resolvedConfig.retries !== undefined)
		configuredDefaults.retries = resolvedConfig.retries;
	if (resolvedConfig.suite !== undefined)
		configuredDefaults.suite = resolvedConfig.suite;
	if (resolvedConfig.filters !== undefined)
		configuredDefaults.filters = resolvedConfig.filters;
	if (resolvedConfig.importer !== undefined)
		configuredDefaults.importer = resolvedConfig.importer;

	for (const fn of setup) {
		// A `setup` hook may resolve to its own undo (the AdonisJS idiom); park it
		// with the teardowns so it runs in reverse order with everything else.
		const undo = await fn(runner);
		if (typeof undo === "function") runnerCleanups.push(undo);
	}
	for (const fn of teardown) runnerTeardowns.push(fn);
}

/**
 * Run every registered runner teardown (reverse order), then clear them — called
 * by the runtime after a file's tests finish. Failures are logged, not thrown,
 * so one bad teardown can't hide the test results.
 */
export async function drainRunnerTeardowns(): Promise<void> {
	// Cleanups returned by `setup` unwind first — they are the innermost thing
	// that was opened. `null` for the error: the drain only happens once the run
	// itself has finished, so there is no setup failure left to report.
	for (let i = runnerCleanups.length - 1; i >= 0; i -= 1) {
		try {
			await runnerCleanups[i](null, runner);
		} catch (err) {
			console.error("[helix] runner cleanup failed:", err);
		}
	}
	runnerCleanups.length = 0;
	for (let i = runnerTeardowns.length - 1; i >= 0; i -= 1) {
		try {
			await runnerTeardowns[i](runner);
		} catch (err) {
			console.error("[helix] runner teardown failed:", err);
		}
	}
	runnerTeardowns.length = 0;
}
