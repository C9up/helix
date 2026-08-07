/**
 * The resolve hook itself. Loaded into Node's module-customization thread by
 * `japa-alias.mjs`, which is what `--import` points at.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** `@japa/runner/core` → helix's shim; every other specifier resolves normally. */
const ALIASES = new Map([["@japa/runner/core", path.resolve(here, "core.ts")]]);

export function resolve(specifier, context, nextResolve) {
	const target = ALIASES.get(specifier);
	if (target === undefined) return nextResolve(specifier, context);
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
