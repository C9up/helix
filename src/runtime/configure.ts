/**
 * `configure({ plugins })` — the helix/AdonisJS bootstrap entry.
 *
 * Following helix precisely: the runtime core is plugin-agnostic, and every
 * capability (HTTP `client`, `db`, fakes, …) ships as a PLUGIN that extends the
 * injected test context. A plugin is a function handed a {@link PluginApi};
 * it registers context properties via `api.context.macro` / `.getter` (the
 * `TestContext.macro`/`getter` of helix) and pairs that with a `declare module`
 * augmentation for the types.
 *
 *   // tests/bootstrap.ts
 *   import { configure } from "@c9up/helix";
 *   import { apiClient } from "@c9up/ream/testing";
 *   await configure({ plugins: [apiClient({ baseUrl })] });
 *
 * This keeps `@c9up/helix` (the core) free of any ecosystem dependency: the
 * plugins live in each package's `/testing` subpath and depend on helix, never
 * the other way round — the helix "runner + plugins" topology.
 */

import { type CLIArgs, cliArgs } from "./cli-args.js";
import { type TestContext, TestContextRegistry } from "./context.js";
import { type Emitter, emitter } from "./emitter.js";
import { Runner } from "./runner.js";
import {
	makeSuiteHandle,
	type SuiteHandle,
	type SuiteHook,
	type SuiteHookCleanup,
	setCurrentSuite,
} from "./suite-taps.js";

/**
 * What a plugin uses to extend the test context. Mirrors helix's
 * `TestContext.macro(name, value)` / `TestContext.getter(name, fn)`.
 */
export interface PluginContext {
	/** Add a shared property present on every test context. */
	macro(name: string, value: unknown): void;
	/** Add a lazily-computed, per-context property (cached per context). */
	getter(name: string, fn: (ctx: TestContext) => unknown): void;
}

/** A runner-level hook — helix's shape, defined once in `suite-taps.ts`. */
export type RunnerHook = SuiteHook;
export type RunnerHookCleanup = SuiteHookCleanup;

/**
 * The API handed to each plugin at {@link configure} time.
 *
 * Four members carry the run — `config`, `cliArgs`, `runner`, `emitter` — plus
 * two helix adds: `context`, so a plugin extends the injected test context
 * without importing the `TestContext` class, and `cleanup`, so a plugin that
 * boots something at configure time has a shutdown point.
 */
export interface PluginApi {
	/**
	 * The options this run was configured with. Mutable: a plugin edits it,
	 * and the runner reads it back once every plugin has run.
	 */
	config: ConfigureOptions;
	/** The flags the CLI forwarded to this worker (`cliArgs`). */
	cliArgs: CLIArgs;
	/** Run-level counters, readable once the run ends (`runner`). */
	runner: Runner;
	/** Lifecycle events — `test:start`, `group:end`, … (`emitter`). */
	emitter: Emitter;
	/** Extend the injected test context. */
	context: PluginContext;
	/**
	 * Register a teardown that runs ONCE after all tests in the run finish
	 * (reverse registration order) — the place to close a booted server, a DB
	 * pool, etc. (runner teardown). Without this, a plugin that boots
	 * a resource at `configure()` has no clean shutdown point.
	 */
	cleanup(fn: RunnerHook): void;
}

/**
 * A helix plugin. Runs once at bootstrap; may be async — e.g. to boot a server
 * before registering `client` on the test context.
 */
export type Plugin = (api: PluginApi) => void | Promise<void>;

/**
 * Filters applied to the tests a file declares (`config.filters`).
 *
 * `files` and `suites` are reported, not honoured: they select which FILES run,
 * and helix settles that list in the CLI process before any worker — and
 * therefore any bootstrap — exists. Setting them here cannot un-spawn a worker
 * that is already running, so they carry what the CLI decided and the CLI-side
 * flags (`--files`, a suite positional) remain the way to decide it.
 */
export interface ConfigureFilters {
	/**
	 * Path fragments the CLI matched files against (`filters.files`).
	 * Read-only here: helix settles the file list before a worker exists, so
	 * this reports what was selected rather than selecting.
	 */
	files?: string[];
	/** Suite names the run was limited to (`filters.suites`). Read-only. */
	suites?: string[];
	/** Only tests carrying one of these tags (`~@tag`/`!@tag` excludes). */
	tags?: string[];
	/** Only groups with these exact titles. */
	groups?: string[];
	/** Only tests with these exact titles. */
	tests?: string[];
	/** Require EVERY tag in `tags` instead of any (`--match-all`). */
	matchAll?: boolean;
}

/**
 * helix's `Refiner`, as much of it as means anything here: a handle that ADDS
 * filters. It writes straight into {@link ConfigureOptions.filters}, so a
 * plugin calling `refiner.add("tags", [...])` steers the run exactly as setting
 * the filter would — the object is a different door to the same room, not a
 * second mechanism.
 */
export interface Refiner {
	/** Add filter values for a layer (`refiner.add`). */
	add(layer: "tests" | "groups" | "tags", values: string[]): void;
	/** Require every tag instead of any (`refiner.matchAllTags`). */
	matchAllTags(toggle?: boolean): void;
}

/** Build a {@link Refiner} writing into `filters`. */
function makeRefiner(filters: ConfigureFilters): Refiner {
	return {
		add(layer, values) {
			filters[layer] = [...(filters[layer] ?? []), ...values];
		},
		matchAllTags(toggle = true) {
			filters.matchAll = toggle;
		},
	};
}

/** Runtime configuration passed to {@link configure}. */
export interface ConfigureOptions {
	/** Plugins to install — each extends the test context. */
	plugins?: Plugin[];
	/**
	 * The directory the run was launched from (`cwd`). Filled in by the
	 * runtime, so a plugin resolving a path against the project reads the same
	 * root the CLI discovered from.
	 */
	cwd?: string;
	/**
	 * Configure the suite before it runs (`configureSuite`). Applied AFTER
	 * the plugins, which is both helix's order and what lets a plugin read it or
	 * put its own in place.
	 *
	 * May return a promise — helix's is synchronous, but helix's per-suite
	 * `configure` has to re-import the config module, and hooks it registers must
	 * exist before the setup hooks are drained.
	 */
	configureSuite?: (suite: SuiteHandle) => void | Promise<void>;
	/**
	 * The reporters this run activated (`reporters.activated`). Read-only
	 * truth: reporters live in the CLI process, so naming one here would not
	 * make it run.
	 */
	reporters?: { activated: string[] };
	/** `process.exit()` once the run ends (`forceExit`). */
	forceExit?: boolean;
	/** Directories discovery skipped (`exclude`). */
	exclude?: string[];
	/**
	 * The filter object (`refiner`). Writes through to
	 * {@link ConfigureOptions.filters}, so `refiner.add("tags", [...])` from a
	 * plugin steers the run exactly as setting the filter would.
	 */
	refiner?: Refiner;
	/**
	 * Filters to apply to this file's tests (`config.filters`). The CLI
	 * flags win: a filter typed at the prompt overrides the configured one.
	 */
	filters?: ConfigureFilters;
	/**
	 * How a test file is imported (`config.importer`). Defaults to
	 * `import(file.href)`. Receives the URL helix would have imported —
	 * cache-busting query included, so repeated runs still re-evaluate.
	 */
	importer?: (file: URL) => void | Promise<void>;
	/** Run once before the tests (runner `setup`). */
	setup?: RunnerHook[];
	/** Run once after the tests, reverse order (runner `teardown`). */
	teardown?: RunnerHook[];
	/**
	 * Default per-test timeout in ms for this file's tests (`configure({
	 * timeout })`). `0` disables. Overridden by `--timeout` and by a per-test
	 * `test.timeout(ms)` / `{ timeout }`.
	 */
	timeout?: number;
	/**
	 * Default extra attempts on failure for this file's tests (`configure({
	 * retries })`). Overridden by `--retries` and by a per-test `test.retry(n)`.
	 */
	retries?: number;
	/**
	 * The name of the suite these tests belong to — surfaced as
	 * `ctx.test.options.meta.suite.name` and on the `suite:*` events. Defaults to
	 * `"default"`, the name helix gives its implicit suite. Overridden by
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

/** The options the last {@link configure} call resolved to (`config`). */
let resolvedConfig: ConfigureOptions = {};

const api: PluginApi = {
	// A getter so a plugin reads the config of the `configure()` call it is
	// running under, not an empty object captured at module load. helix lets a
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
 * (helix/AdonisJS `bin/test.ts` / `tests/bootstrap.ts`).
 *
 * Order follows helix: PLUGINS first, then the run's `setup` hooks, then the
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
	const handle = makeSuiteHandle(options.suite ?? "default", setup, teardown);
	setCurrentSuite(handle);

	// The rest of helix's `BaseConfig`, filled with what this run actually is, so
	// a plugin reading `api.config` is told the truth rather than `undefined`.
	const flags = cliArgs();
	resolvedConfig.cwd ??= process.cwd();
	resolvedConfig.reporters ??= { activated: flags.reporters ?? [] };
	resolvedConfig.forceExit ??= flags.forceExit === true;
	resolvedConfig.filters ??= {};
	resolvedConfig.filters.files ??= flags.files;
	resolvedConfig.filters.suites ??=
		flags.suite === undefined ? undefined : [flags.suite];
	resolvedConfig.refiner ??= makeRefiner(resolvedConfig.filters);

	for (const plugin of resolvedConfig.plugins ?? []) {
		await plugin(api);
	}

	// helix order: plugins, THEN `runner.onSuite(config.configureSuite)`, then the
	// setup hooks. Applying it here rather than earlier is what lets a plugin
	// read it — or put its own in place — and still have it take effect.
	await resolvedConfig.configureSuite?.(handle);

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

	// helix skips the global setup hooks under `--list-pinned`: nothing runs, so
	// nothing should be opened.
	const listing = cliArgs().listPinned === true;
	for (const fn of listing ? [] : setup) {
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
	// A reversed copy read by value: the index form gave every callback the
	// type "a function, or nothing", which is not what a list you just walked
	// the length of contains.
	for (const cleanup of [...runnerCleanups].reverse()) {
		try {
			await cleanup(null, runner);
		} catch (err) {
			console.error("[helix] runner cleanup failed:", err);
		}
	}
	runnerCleanups.length = 0;
	for (const teardown of [...runnerTeardowns].reverse()) {
		try {
			await teardown(runner);
		} catch (err) {
			console.error("[helix] runner teardown failed:", err);
		}
	}
	runnerTeardowns.length = 0;
}
