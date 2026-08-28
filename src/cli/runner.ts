/**
 * The programmatic runner — everything a HOST framework needs to drive helix
 * from its own config file.
 *
 * `bin/helix.js` reads `helix.config.*` and drives these; a framework that
 * declares its suites elsewhere (ream reads them from its rc file, the way
 * `@adonisjs/core` reads `adonisrc.ts` and hands the suites to Japa) composes
 * the same pieces instead of shelling out to the CLI.
 */

export {
	BOOTSTRAP_FILENAMES,
	resolveBootstrap,
} from "../runtime/bootstrap.js";
export { armDrainGuard, DRAIN_GRACE_MS } from "../runtime/drain-guard.js";
export { runGlobalHooks } from "../runtime/global-hooks.js";
export type { Reporter } from "./reporter.js";
export { makeReporters, makeReportersFrom } from "./reporter.js";
export type { RunConfig, RunOutcome, SuiteRun, WatchOptions } from "./run.js";
export { run, runSuites } from "./run.js";
export type { HelixConfig, SuiteDefinition, SuiteFiles } from "./suites.js";
export { loadHelixConfig, resolveSuiteFiles, selectSuites } from "./suites.js";
export type { Summary } from "./summary.js";
