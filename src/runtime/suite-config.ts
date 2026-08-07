/**
 * `suites[].configure` — the per-suite callback Japa's `TestSuite` carries.
 *
 * A function cannot cross the CLI→worker boundary, so the worker re-imports the
 * module that declared it. The CLI names that module in `HELIX_SUITE_CONFIG`
 * and says where the suites live inside it with `HELIX_SUITE_CONFIG_KEY` (a
 * dotted path, default `suites`) — helix declares them at the top level of
 * `helix.config`, ream under `tests.suites` in its rc file, and one mechanism
 * serves both.
 *
 * Consequence worth knowing before using it: the config module is imported in
 * EVERY worker. Keep it declarative. The alternative — `configureSuite` in
 * `tests/bootstrap.ts`, which AdonisJS itself uses — costs nothing extra,
 * because the bootstrap is already imported there.
 */

import { pathToFileURL } from "node:url";
import type { SuiteHandle } from "./suite-taps.js";

/** Walk a dotted path, stopping at the first thing that is not an object. */
function dig(source: unknown, path: string): unknown {
	let cursor = source;
	for (const segment of path.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = Reflect.get(cursor, segment);
	}
	return cursor;
}

/**
 * Hand `handle` to the running suite's `configure`, if the config declared one.
 * A no-op when no config module was named — which is every project that
 * declares its suites without one.
 */
export async function applySuiteConfigure(
	suite: string,
	handle: SuiteHandle,
): Promise<void> {
	const file = process.env.HELIX_SUITE_CONFIG;
	if (file === undefined || file === "") return;

	const imported: unknown = await import(pathToFileURL(file).href);
	const root =
		imported !== null && typeof imported === "object"
			? (Reflect.get(imported, "default") ?? imported)
			: undefined;

	const suites = dig(root, process.env.HELIX_SUITE_CONFIG_KEY || "suites");
	if (!Array.isArray(suites)) return;

	const entry = suites.find(
		(candidate) =>
			candidate !== null &&
			typeof candidate === "object" &&
			Reflect.get(candidate, "name") === suite,
	);
	if (entry === undefined) return;

	const configure = Reflect.get(entry, "configure");
	if (typeof configure === "function") configure(handle);
}
