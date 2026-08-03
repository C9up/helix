/**
 * Named test suites — the AdonisJS `adonisrc.ts` / Japa `configure({ suites })`
 * layer, so `helix test unit` runs a suite rather than a path.
 *
 *     // helix.config.ts
 *     export default {
 *       suites: [
 *         { name: "unit", files: ["tests/unit"], timeout: 2_000 },
 *         { name: "functional", files: ["tests/functional/**"], timeout: 30_000 },
 *       ],
 *     }
 *
 * Named deviation from Adonis: a suite's `files` are directories or file paths
 * resolved through helix's own discovery (suffix-based), not a glob engine. A
 * trailing wildcard segment is accepted — `tests/unit/**` walks the directory,
 * and `tests/unit/**​/*.spec.ts` also constrains the suffix — because that is the
 * shape Adonis users write; anything richer is not silently half-honoured.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type DiscoveryOptions, discover } from "./discover.js";

/** One suite, as declared in the config file. */
export interface SuiteDefinition {
	/** Suite name — what `helix test <name>` selects. */
	name: string;
	/** Directories, file paths, or `dir/**​/*.suffix` entries. */
	files: string[];
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
	const suites = Reflect.get(source, "suites");
	if (!Array.isArray(suites)) return { bootstrap };
	const parsed: SuiteDefinition[] = [];
	for (const entry of suites) {
		if (entry === null || typeof entry !== "object") continue;
		const name = Reflect.get(entry, "name");
		const files = Reflect.get(entry, "files");
		if (typeof name !== "string" || !Array.isArray(files)) continue;
		const timeout = Reflect.get(entry, "timeout");
		const retries = Reflect.get(entry, "retries");
		parsed.push({
			name,
			files: files.filter((f): f is string => typeof f === "string"),
			timeout: typeof timeout === "number" ? timeout : undefined,
			retries: typeof retries === "number" ? retries : undefined,
		});
	}
	return { suites: parsed, bootstrap };
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
 * Split a suite entry into the directory to walk and the suffix to require.
 * `tests/unit` → walk `tests/unit`; `tests/unit/**` → same; `tests/**​/*.spec.ts`
 * → walk `tests` keeping `.spec.ts`.
 */
function splitEntry(entry: string): { dir: string; suffix?: string } {
	const segments = entry.split("/");
	const wildcardAt = segments.findIndex((s) => s.includes("*"));
	if (wildcardAt === -1) return { dir: entry };
	const dir = segments.slice(0, wildcardAt).join("/") || ".";
	const last = segments[segments.length - 1];
	// `*.spec.ts` constrains the suffix; a bare `**` just means "walk it".
	const suffix =
		last.startsWith("*") && last.length > 1 ? last.slice(1) : undefined;
	return { dir, suffix };
}

/**
 * Resolve a suite's `files` into absolute test file paths, using helix's
 * discovery for directories.
 */
export async function resolveSuiteFiles(
	suite: SuiteDefinition,
	root: string,
	discovery: DiscoveryOptions | undefined,
): Promise<string[]> {
	const out: string[] = [];
	for (const entry of suite.files) {
		const { dir, suffix } = splitEntry(entry);
		const abs = path.isAbsolute(dir) ? dir : path.resolve(root, dir);
		if (!existsSync(abs)) {
			process.stderr.write(
				`helix: suite "${suite.name}": path not found: ${entry}\n`,
			);
			continue;
		}
		if (statSync(abs).isDirectory()) {
			const options: DiscoveryOptions = {
				...discovery,
				...(suffix === undefined ? {} : { suffixes: [suffix] }),
			};
			out.push(...(await discover(abs, options)));
			continue;
		}
		out.push(abs);
	}
	// A file listed by two entries runs once.
	return [...new Set(out)];
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
