/**
 * The resolve hook itself, loaded into Node's module-customization thread by
 * `japa-alias.mjs`.
 *
 * It consults a shared flag on every resolution rather than being installed
 * once and for all: `node:module.register()` has no counterpart, so a hook that
 * decided at registration time would leave a programmatic host resolving
 * `@japa/runner/core` to the shim for every later run — including the ones that
 * asked for the real thing. A `SharedArrayBuffer` crosses to the hook thread,
 * which is why the flag is one rather than a variable.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** `@japa/runner/core` → helix's shim; every other specifier resolves normally. */
const ALIASES = new Map([["@japa/runner/core", path.resolve(here, "core.ts")]]);

/** Set by {@link initialize}; `undefined` means "always on" (a worker). */
let enabled;

export function initialize(data) {
	if (data?.flag instanceof SharedArrayBuffer) {
		enabled = new Int32Array(data.flag);
	}
}

export function resolve(specifier, context, nextResolve) {
	const target = ALIASES.get(specifier);
	if (target === undefined) return nextResolve(specifier, context);
	if (enabled !== undefined && Atomics.load(enabled, 0) !== 1) {
		return nextResolve(specifier, context);
	}
	return {
		shortCircuit: true,
		url: pathToFileURL(compiledOrSource(target)).href,
	};
}

/**
 * Prefer the built `.js` when helix runs from its published tarball; fall back
 * to the `.ts` source in the workspace, where a TS loader is active anyway
 * because the test files need one.
 */
function compiledOrSource(tsPath) {
	const jsPath = `${tsPath.slice(0, -3)}.js`;
	return existsSync(jsPath) ? jsPath : tsPath;
}
