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
 * helix loads the same file with the same three exports, so an Adonis
 * `tests/bootstrap.ts` ports over unchanged. The CLI resolves it once and
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
import { configure, type Plugin, type RunnerHook } from "./configure.js";

/** File names probed under the project root when none is configured. */
export const BOOTSTRAP_FILENAMES = [
	"tests/bootstrap.ts",
	"tests/bootstrap.js",
	"tests/bootstrap.mjs",
];

/**
 * What `configureSuite` receives. Japa hands its callback a `Suite` and reads
 * back the hooks registered on it; helix hands the same two registrars plus the
 * name, which is all Adonis's own `configureSuite` uses.
 */
export interface SuiteHandle {
	/** The suite these files belong to (`--suite`, or a `helix.config` suite). */
	readonly name: string;
	/** Run before this suite's tests. */
	setup(fn: RunnerHook): SuiteHandle;
	/** Run after this suite's tests, in reverse registration order. */
	teardown(fn: RunnerHook): SuiteHandle;
}

/** The exports helix reads off the bootstrap module. */
interface BootstrapModule {
	plugins?: Plugin[];
	runnerHooks?: { setup?: RunnerHook[]; teardown?: RunnerHook[] };
	configureSuite?: (suite: SuiteHandle) => unknown;
}

/** Everything about the module is optional — read defensively, never cast. */
function readModule(imported: unknown): BootstrapModule {
	if (imported === null || typeof imported !== "object") return {};
	const plugins = Reflect.get(imported, "plugins");
	const hooks = Reflect.get(imported, "runnerHooks");
	const configureSuite = Reflect.get(imported, "configureSuite");
	return {
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
	if (file === undefined || file === "") return;
	loaded ??= applyBootstrap(file, suite);
	return loaded;
}

async function applyBootstrap(file: string, suite: string): Promise<void> {
	const module = readModule(await import(pathToFileURL(file).href));
	const setup = [...(module.runnerHooks?.setup ?? [])];
	const teardown = [...(module.runnerHooks?.teardown ?? [])];
	if (module.configureSuite) {
		const handle: SuiteHandle = {
			name: suite,
			setup(fn) {
				setup.push(fn);
				return handle;
			},
			teardown(fn) {
				teardown.push(fn);
				return handle;
			},
		};
		module.configureSuite(handle);
	}
	await configure({
		plugins: module.plugins,
		setup,
		teardown,
		suite,
	});
}

/** Test seam: forget that a bootstrap was loaded in this process. */
export function resetBootstrap(): void {
	loaded = undefined;
}
