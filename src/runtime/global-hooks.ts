/**
 * `runnerHooks` — run ONCE for the whole run, where Japa runs them.
 *
 * These were running per worker process, which meant a migration in
 * `runnerHooks.setup` ran once per FILE. The reason given was that a resource
 * opened in the CLI process would not exist in the workers — true of an
 * in-memory one, and false of everything these hooks actually do: migrate a
 * database, seed it, start a server on a port, create a directory. Those cross
 * processes, and running them N times is wrong, not merely wasteful.
 *
 * So they run here, in the process that spawns the workers, and the workers are
 * told to skip them. What genuinely has to exist INSIDE a worker — a context
 * macro, anything held in memory — is what `plugins` are for, and those still
 * run per worker because they have to.
 */

import { pathToFileURL } from "node:url";
import { emitter } from "./emitter.js";
import { Runner } from "./runner.js";
import type { SuiteHook, SuiteHookCleanup } from "./suite-taps.js";

/** Set for the workers, so they do not run what the parent already ran. */
export const GLOBAL_HOOKS_ENV = "HELIX_GLOBAL_HOOKS";

/** Whether this process should skip `runnerHooks` because a parent ran them. */
export function globalHooksHandledByParent(): boolean {
	return process.env[GLOBAL_HOOKS_ENV] === "1";
}

function hookList(source: unknown, key: string): SuiteHook[] {
	if (source === null || typeof source !== "object") return [];
	const value = Reflect.get(source, key);
	if (!Array.isArray(value)) return [];
	return value.filter((fn): fn is SuiteHook => typeof fn === "function");
}

/**
 * Run the bootstrap's `runnerHooks.setup` once and return the teardown for the
 * end of the run. Undos a setup hook resolved to unwind first, then the
 * declared teardowns — both in reverse order, as everywhere else.
 *
 * A no-op returning a no-op when the project has no bootstrap: there is then
 * nothing to run once, and the workers have nothing to skip.
 */
export async function runGlobalHooks(
	bootstrap: string | undefined,
): Promise<() => Promise<void>> {
	if (bootstrap === undefined || bootstrap === "") {
		return async () => {};
	}

	const module: unknown = await import(pathToFileURL(bootstrap).href);
	const hooks = Reflect.get(Object(module), "runnerHooks");
	const setup = hookList(hooks, "setup");
	const teardown = hookList(hooks, "teardown");
	if (setup.length === 0 && teardown.length === 0) {
		return async () => {};
	}

	// The hooks take a runner (Japa parity). This one tracks the parent's own
	// emitter, which sees no test events — the argument exists so a hook's
	// signature works, not to report from here.
	const runner = new Runner(emitter);
	const undos: SuiteHookCleanup[] = [];
	for (const fn of setup) {
		const undo = await fn(runner);
		if (typeof undo === "function") undos.push(undo);
	}
	process.env[GLOBAL_HOOKS_ENV] = "1";

	return async () => {
		for (let i = undos.length - 1; i >= 0; i -= 1) {
			try {
				await undos[i](null, runner);
			} catch (err) {
				console.error("[helix] global cleanup failed:", err);
			}
		}
		for (let i = teardown.length - 1; i >= 0; i -= 1) {
			try {
				await teardown[i](runner);
			} catch (err) {
				console.error("[helix] global teardown failed:", err);
			}
		}
	};
}
