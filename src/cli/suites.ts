/**
 * Named test suites — helix's equivalent of the `tests` block AdonisJS puts in
 * `adonisrc.ts`, so `helix test unit` runs a suite rather than a path. The
 * SHAPE is Adonis's (`timeout`, `forceExit`, `suites[{ name, files, timeout }]`)
 * and the glob syntax is portable verbatim, but the file read is
 * `helix.config.*`: helix is framework-agnostic, and `adonisrc.ts` belongs to
 * the framework that owns it — in Adonis it is `@adonisjs/core`, not Japa, that
 * reads the file and hands the suites to the runner.
 *
 *     // helix.config.ts
 *     export default {
 *       timeout: 2_000,
 *       suites: [
 *         { name: "unit", files: ["tests/unit/**​/*.spec.(js|ts)"] },
 *         { name: "functional", files: ["tests/functional"], timeout: 30_000 },
 *       ],
 *     }
 *
 * A suite's `files` are plain paths (a directory is walked with helix's suffix
 * discovery) or globs — including AdonisJS's own defaults, verbatim:
 * `tests/unit/**​/*.spec.(js|ts)`. See `glob.ts` for the compiled subset and the
 * two forms it refuses rather than half-honours.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type DiscoveryOptions, discover } from "./discover.js";
import {
	globBaseDir,
	globRejection,
	globToRegExp,
	isGlob,
	isNegated,
	withoutNegation,
} from "./glob.js";

/**
 * A suite's file list — Japa's `TestFiles`, the three forms it accepts: one
 * pattern, several, or a callback returning the URLs. The callback runs in the
 * CLI process, where the config module was imported, so it can look wherever it
 * likes for its files.
 */
export type SuiteFiles = string | string[] | (() => URL[] | Promise<URL[]>);

/** One suite, as declared in the config file. */
export interface SuiteDefinition {
	/** Suite name — what `helix test <name>` selects. */
	name: string;
	/** Paths, globs, or a callback returning the files (Japa `TestFiles`). */
	files: SuiteFiles;
	/** Per-test timeout for this suite (ms). */
	timeout?: number;
	/** Extra attempts on failure for this suite. */
	retries?: number;
}

/** The shape of `helix.config.{ts,js,mjs}`. */
export interface HelixConfig {
	suites?: SuiteDefinition[];
	/**
	 * Path to the bootstrap module (AdonisJS `tests/bootstrap.ts`), relative to
	 * the project root. Defaults to the conventional `tests/bootstrap.*`.
	 */
	bootstrap?: string;
	/** Default per-test timeout in ms — AdonisJS `tests.timeout`. */
	timeout?: number;
	/** `process.exit()` once the run ends — AdonisJS `tests.forceExit`. */
	forceExit?: boolean;
}

/** Config file names probed at the project root, in order. */
const CONFIG_FILENAMES = [
	"helix.config.ts",
	"helix.config.js",
	"helix.config.mjs",
];

/** Narrow an imported module's default export to a {@link HelixConfig}. */
function toConfig(imported: unknown): HelixConfig {
	const source =
		imported !== null && typeof imported === "object"
			? (Reflect.get(imported, "default") ?? imported)
			: imported;
	if (source === null || typeof source !== "object") return {};
	const rawBootstrap = Reflect.get(source, "bootstrap");
	const bootstrap = typeof rawBootstrap === "string" ? rawBootstrap : undefined;
	const rawTimeout = Reflect.get(source, "timeout");
	const timeout = typeof rawTimeout === "number" ? rawTimeout : undefined;
	const forceExit =
		Reflect.get(source, "forceExit") === true ? true : undefined;
	const runner = { bootstrap, timeout, forceExit };
	const suites = Reflect.get(source, "suites");
	if (!Array.isArray(suites)) return runner;
	const parsed: SuiteDefinition[] = [];
	for (const entry of suites) {
		if (entry === null || typeof entry !== "object") continue;
		const name = Reflect.get(entry, "name");
		const files = toSuiteFiles(Reflect.get(entry, "files"));
		if (typeof name !== "string" || files === undefined) continue;
		const timeout = Reflect.get(entry, "timeout");
		const retries = Reflect.get(entry, "retries");
		parsed.push({
			name,
			files,
			timeout: typeof timeout === "number" ? timeout : undefined,
			retries: typeof retries === "number" ? retries : undefined,
		});
	}
	return { ...runner, suites: parsed };
}

/** Narrow a declared `files` value to one of Japa's three accepted forms. */
function toSuiteFiles(value: unknown): SuiteFiles | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "function") {
		return (): URL[] | Promise<URL[]> => {
			const produced: unknown = value();
			return normaliseUrls(produced);
		};
	}
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === "string");
	}
	return undefined;
}

/** A files-callback's return value, awaited and reduced to the URLs in it. */
async function normaliseUrls(produced: unknown): Promise<URL[]> {
	const resolved: unknown = await produced;
	if (!Array.isArray(resolved)) return [];
	return resolved.filter((entry): entry is URL => entry instanceof URL);
}

/**
 * Load `helix.config.*` from `root`, or `{}` when there is none. A config that
 * throws on import is a hard error — silently ignoring it would run the wrong
 * set of tests.
 */
export async function loadHelixConfig(root: string): Promise<HelixConfig> {
	for (const name of CONFIG_FILENAMES) {
		const candidate = path.join(root, name);
		if (!existsSync(candidate)) continue;
		const imported: unknown = await import(pathToFileURL(candidate).href);
		return toConfig(imported);
	}
	return {};
}

/**
 * Extensions a pattern entry is allowed to select. The GLOB decides which files
 * belong to the suite, so the walk only has to stop at things that could not be
 * a module — `--include`, which constrains path-mode discovery, does not apply.
 */
const GLOB_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

/** `path.relative` output, normalised to the `/` separators a glob speaks. */
function toPosix(relative: string): string {
	return relative.split(path.sep).join("/");
}

/** Every file a pattern entry selects, walked from its wildcard-free prefix. */
async function resolveGlobEntry(
	entry: string,
	suiteName: string,
	root: string,
	discovery: DiscoveryOptions | undefined,
): Promise<string[]> {
	const rejection = globRejection(entry);
	if (rejection !== undefined) {
		process.stderr.write(
			`helix: suite "${suiteName}": ${entry}: ${rejection}\n`,
		);
		return [];
	}
	const base = globBaseDir(entry);
	const absBase = path.isAbsolute(base) ? base : path.resolve(root, base);
	if (!existsSync(absBase)) {
		process.stderr.write(
			`helix: suite "${suiteName}": path not found: ${entry}\n`,
		);
		return [];
	}
	const pattern = globToRegExp(entry);
	const candidates = await discover(absBase, {
		...discovery,
		suffixes: GLOB_EXTENSIONS,
	});
	return candidates.filter((file) =>
		pattern.test(toPosix(path.relative(root, file))),
	);
}

/**
 * Resolve a suite's `files` into absolute test file paths. A plain path is a
 * directory to walk (helix's suffix discovery) or a file; anything with a
 * pattern character goes through the glob matcher, so AdonisJS's own
 * `tests/unit/**​/*.spec.(js|ts)` ports over verbatim. A `!pattern` entry
 * subtracts from what the others selected.
 */
export async function resolveSuiteFiles(
	suite: SuiteDefinition,
	root: string,
	discovery: DiscoveryOptions | undefined,
): Promise<string[]> {
	// A callback picks the files itself (Japa `TestFiles`); there is no pattern
	// to compile and nothing to exclude, so it short-circuits the whole loop.
	if (typeof suite.files === "function") {
		return [...new Set((await suite.files()).map((url) => fileURLToPath(url)))];
	}
	const entries = typeof suite.files === "string" ? [suite.files] : suite.files;

	const out: string[] = [];
	// `!pattern` entries subtract from whatever the selecting entries gathered,
	// so they are applied once at the end regardless of where they were written.
	const excluded: RegExp[] = [];
	for (const entry of entries) {
		if (isNegated(entry)) {
			const pattern = withoutNegation(entry);
			const rejection = globRejection(pattern);
			if (rejection !== undefined) {
				process.stderr.write(
					`helix: suite "${suite.name}": ${entry}: ${rejection}\n`,
				);
				continue;
			}
			excluded.push(globToRegExp(pattern));
			continue;
		}
		if (isGlob(entry)) {
			out.push(...(await resolveGlobEntry(entry, suite.name, root, discovery)));
			continue;
		}
		const abs = path.isAbsolute(entry) ? entry : path.resolve(root, entry);
		if (!existsSync(abs)) {
			process.stderr.write(
				`helix: suite "${suite.name}": path not found: ${entry}\n`,
			);
			continue;
		}
		if (statSync(abs).isDirectory()) {
			out.push(...(await discover(abs, discovery)));
			continue;
		}
		out.push(abs);
	}
	// A file listed by two entries runs once.
	const selected = [...new Set(out)];
	if (excluded.length === 0) return selected;
	return selected.filter((file) => {
		const relative = toPosix(path.relative(root, file));
		return !excluded.some((pattern) => pattern.test(relative));
	});
}

/**
 * Pick the suites named on the command line. Returns `undefined` when the
 * positionals are NOT suite names — the caller then treats them as paths, which
 * is what every helix project without a config file does.
 */
export function selectSuites(
	config: HelixConfig,
	positionals: string[],
): SuiteDefinition[] | undefined {
	const suites = config.suites ?? [];
	if (suites.length === 0) return undefined;
	// No positionals: Adonis runs every configured suite.
	if (positionals.length === 0) return suites;
	const byName = new Map(suites.map((s) => [s.name, s]));
	const selected = positionals.map((p) => byName.get(p));
	// All-or-nothing: a mix of suite names and paths is a typo, not a feature.
	if (selected.some((s) => s === undefined)) return undefined;
	return selected.filter((s): s is SuiteDefinition => s !== undefined);
}
