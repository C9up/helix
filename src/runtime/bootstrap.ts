/**
 * `tests/bootstrap.ts` — the AdonisJS bootstrap module.
 *
 * Adonis puts the run's plugins, runner hooks and suite hooks in one file that
 * `bin/test.ts` imports before anything else:
 *
 *     // tests/bootstrap.ts
 *     export const plugins = [assert(), apiClient()]
 *     export const runnerHooks = { setup: [() => …], teardown: [() => …] }
 *     export const configureSuite = (suite) => {
 *       if (["functional", "e2e"].includes(suite.name)) {
 *         return suite.setup(() => testUtils.httpServer().start())
 *       }
 *     }
 *
 * helix loads the same file with the same three exports — plus `filters` and
 * `importer`, the two Japa `Config` fields Adonis sets in `bin/test.ts`, which
 * helix has no equivalent of — so an Adonis `tests/bootstrap.ts` ports over
 * unchanged. The CLI resolves it once and
 * forwards the absolute path as `HELIX_BOOTSTRAP`, so it reaches the worker
 * through BOTH orchestrators (the Rust engine and the TS pool spawn children
 * that inherit the CLI's env).
 *
 * Named deviation, forced by helix running one process per FILE: the module is
 * imported — and `runnerHooks.setup` therefore runs — once per worker process,
 * not once per run. For what these hooks actually do (boot an HTTP server, open
 * a DB pool) that is the only correct reading: a resource opened in the CLI
 * process would not exist in the process where the tests run.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	type ConfigureFilters,
	configure,
	type Plugin,
	type RunnerHook,
} from "./configure.js";
import { applySuiteConfigure } from "./suite-config.js";
import { makeSuiteHandle, resetTaps, type SuiteHandle } from "./suite-taps.js";

/** File names probed under the project root when none is configured. */
export const BOOTSTRAP_FILENAMES = [
	"tests/bootstrap.ts",
	"tests/bootstrap.js",
	"tests/bootstrap.mjs",
];

/**
 * The exports helix reads off the bootstrap module. `plugins`, `runnerHooks`
 * and `configureSuite` are Adonis's; `filters` and `importer` are Japa `Config`
 * fields that Adonis sets in `bin/test.ts` — with no `bin/test.ts` in helix,
 * the bootstrap module is where they belong.
 */
interface BootstrapModule {
	plugins?: Plugin[];
	runnerHooks?: { setup?: RunnerHook[]; teardown?: RunnerHook[] };
	configureSuite?: (suite: SuiteHandle) => unknown;
	filters?: ConfigureFilters;
	importer?: (file: URL) => void | Promise<void>;
}

/** `filters` as exported — every field optional, so read each defensively. */
function readFilters(imported: unknown): ConfigureFilters | undefined {
	const source = Reflect.get(Object(imported), "filters");
	if (source === null || typeof source !== "object") return undefined;
	const matchAll = Reflect.get(source, "matchAll");
	return {
		tags: stringList(source, "tags"),
		groups: stringList(source, "groups"),
		tests: stringList(source, "tests"),
		matchAll: typeof matchAll === "boolean" ? matchAll : undefined,
	};
}

function stringList(source: object, key: string): string[] | undefined {
	const value = Reflect.get(source, key);
	if (!Array.isArray(value)) return undefined;
	return value.filter((v): v is string => typeof v === "string");
}

/** Everything about the module is optional — read defensively, never cast. */
function readModule(imported: unknown): BootstrapModule {
	if (imported === null || typeof imported !== "object") return {};
	const plugins = Reflect.get(imported, "plugins");
	const hooks = Reflect.get(imported, "runnerHooks");
	const configureSuite = Reflect.get(imported, "configureSuite");
	const importer = Reflect.get(imported, "importer");
	return {
		filters: readFilters(imported),
		importer:
			typeof importer === "function"
				? (file: URL): void | Promise<void> => importer(file)
				: undefined,
		plugins: Array.isArray(plugins)
			? plugins.filter((p): p is Plugin => typeof p === "function")
			: undefined,
		runnerHooks:
			hooks !== null && typeof hooks === "object"
				? {
						setup: hookList(hooks, "setup"),
						teardown: hookList(hooks, "teardown"),
					}
				: undefined,
		configureSuite:
			typeof configureSuite === "function"
				? (suite: SuiteHandle): unknown => configureSuite(suite)
				: undefined,
	};
}

function hookList(source: object, key: string): RunnerHook[] | undefined {
	const value = Reflect.get(source, key);
	if (!Array.isArray(value)) return undefined;
	return value.filter((fn): fn is RunnerHook => typeof fn === "function");
}

/**
 * Resolve the bootstrap file for `root`: an explicit path (from
 * `helix.config`), else the conventional `tests/bootstrap.*`. Returns
 * `undefined` when the project has none — having no bootstrap is the norm, not
 * an error.
 */
export function resolveBootstrap(
	root: string,
	configured?: string,
): string | undefined {
	if (configured !== undefined && configured !== "") {
		const absolute = path.isAbsolute(configured)
			? configured
			: path.resolve(root, configured);
		return existsSync(absolute) ? absolute : undefined;
	}
	for (const name of BOOTSTRAP_FILENAMES) {
		const candidate = path.resolve(root, name);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Memoised so a worker that runs several files bootstraps exactly once. */
let loaded: Promise<void> | undefined;

/**
 * Import the bootstrap module named by `HELIX_BOOTSTRAP` and hand its exports
 * to {@link configure}. A no-op when the variable is unset — which is what
 * every project without a bootstrap file, and every direct `runTestFile`
 * caller, sees.
 */
export async function loadBootstrap(suite: string): Promise<void> {
	const file = process.env.HELIX_BOOTSTRAP;
	const hasSuiteConfig = (process.env.HELIX_SUITE_CONFIG ?? "") !== "";
	// The suite's own `configure` is applied here too, so it reaches the same
	// hook arrays before `configure()` drains them. That means this runs even
	// with no bootstrap file — a project may declare one without the other.
	if ((file === undefined || file === "") && !hasSuiteConfig) return;
	loaded ??= applyBootstrap(file ?? "", suite);
	return loaded;
}

async function applyBootstrap(file: string, suite: string): Promise<void> {
	const module: BootstrapModule =
		file === "" ? {} : readModule(await import(pathToFileURL(file).href));
	const setup = [...(module.runnerHooks?.setup ?? [])];
	const teardown = [...(module.runnerHooks?.teardown ?? [])];
	// Both callbacks get the SAME handle, so hooks either of them registers land
	// in the arrays `configure()` is about to consume. The bootstrap's runs
	// first: it is the run-wide one, and a per-suite tweak reads as an override.
	const handle = makeSuiteHandle(suite, setup, teardown);
	if (module.configureSuite) {
		module.configureSuite(handle);
	}
	await applySuiteConfigure(suite, handle);
	await configure({
		plugins: module.plugins,
		filters: module.filters,
		importer: module.importer,
		setup,
		teardown,
		suite,
	});
}

/** Test seam: forget that a bootstrap was loaded in this process. */
export function resetBootstrap(): void {
	loaded = undefined;
	resetTaps();
}
