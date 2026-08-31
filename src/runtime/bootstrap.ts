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
 * `importer`, the two helix `Config` fields Adonis sets in `bin/test.ts`, which
 * helix has no equivalent of — so an Adonis `tests/bootstrap.ts` ports over
 * unchanged. The CLI resolves it once and
 * forwards the absolute path as `HELIX_BOOTSTRAP`, so it reaches the worker
 * through BOTH orchestrators (the Rust engine and the TS pool spawn children
 * that inherit the CLI's env).
 *
 * `runnerHooks` run ONCE for the whole run, in the process that spawns the
 * workers. See `global-hooks.ts`. Everything else here is
 * per worker because it has to be: a context macro, a filter, an importer only
 * mean anything in the process that loads the test file.
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
import { globalHooksHandledByParent } from "./global-hooks.js";
import { applySuiteConfigure } from "./suite-config.js";
import { resetTaps, type SuiteHandle } from "./suite-taps.js";

/** File names probed under the project root when none is configured. */
export const BOOTSTRAP_FILENAMES = [
	"tests/bootstrap.ts",
	"tests/bootstrap.js",
	"tests/bootstrap.mjs",
];

/**
 * The exports helix reads off the bootstrap module. `plugins`, `runnerHooks`
 * and `configureSuite` are Adonis's; `filters` and `importer` are helix `Config`
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
		if (existsSync(candidate)) {
			announceConventionalBootstrap(root, candidate);
			return candidate;
		}
	}
	return undefined;
}

/**
 * Say out loud that a bootstrap was picked up by convention.
 *
 * Nothing here is wrong — a project with no config gets the conventional file,
 * which is the point. What was wrong is that it happened without a word, and
 * helix is not always the only thing that decides: a framework may keep its own
 * answer in its own rc file, which helix neither reads nor should. Run through
 * that framework's command, the declared bootstrap wins; run `helix` directly
 * in the same project, this one does — and the two disagree silently.
 *
 * The reported shape: a `tests/bootstrap.ts` that starts the application, so a
 * unit suite that needed no server opened one, with a connection pool behind
 * it, and nothing said why.
 *
 * Once per project, and only when there is a framework rc file to disagree
 * with — otherwise this is noise on every run of every project. Keyed by root
 * rather than a single process-wide flag, so a run covering two projects warns
 * about both instead of only the first.
 */
const announcedRoots = new Set<string>();

function announceConventionalBootstrap(root: string, picked: string): void {
	if (announcedRoots.has(root)) return;
	const rc = RC_FILENAMES.find((name) => existsSync(path.resolve(root, name)));

	if (rc === undefined) return;
	announcedRoots.add(root);
	// Forward slashes whatever the platform: this line is read by a person and
	// pasted into a command, and `tests\\bootstrap.ts` is neither what they
	// wrote nor what they would type back.
	const shown = path.relative(root, picked).split(path.sep).join("/");
	process.stderr.write(
		`helix: using ${shown} (found by convention — no helix.config.* here).\n` +
			`  ${rc} may declare its own test bootstrap; helix does not read it. If the two differ, run the tests through your framework's own command so its answer wins.\n`,
	);
}

/**
 * Framework rc files that can carry a competing bootstrap. Named, not guessed:
 * helix stays agnostic and only checks whether one exists, never reads it.
 */
const RC_FILENAMES = ["reamrc.ts", "reamrc.js", "adonisrc.ts", "adonisrc.js"];

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
	// `runnerHooks` belong to the run, not to this file. When the parent ran
	// them — which it does whenever a bootstrap exists — the worker must not run
	// them again: that is the difference between migrating once and migrating
	// once per test file.
	const parentRanThem = globalHooksHandledByParent();
	const setup = parentRanThem ? [] : [...(module.runnerHooks?.setup ?? [])];
	const teardown = parentRanThem
		? []
		: [...(module.runnerHooks?.teardown ?? [])];
	// `configureSuite` is handed to `configure()` rather than called here, so it
	// runs where helix runs it: after the plugins, which is what lets a plugin
	// read it or replace it. The per-suite callback chains onto it — both get
	// the same handle, so hooks either registers reach the arrays below.
	await configure({
		plugins: module.plugins,
		filters: module.filters,
		importer: module.importer,
		configureSuite: async (handle) => {
			module.configureSuite?.(handle);
			await applySuiteConfigure(suite, handle);
		},
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
