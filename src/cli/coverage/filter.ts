// Include / exclude filter for coverage files. Glob subset is
// implemented in `./glob.ts` (shared with the watch-mode filter).
//
// Symlinks are NOT followed: `path.realpath` is used to verify the file
// actually lives under `root`. Anything pointing outside (off-tree
// symlinks) is dropped — defence in depth against a malicious source
// tree dragging unrelated files into the coverage report.

import { realpathSync } from "node:fs";
import path from "node:path";
import { compileGlobs, globToRegex, matchesAnyGlob } from "./glob.js";
import type { RawFileCoverage } from "./types.js";

const DEFAULT_INCLUDE = ["src/**/*.{ts,tsx,js,mjs,cjs}"];
const DEFAULT_EXCLUDE = [
	"node_modules/**",
	"dist/**",
	"build/**",
	"coverage/**",
	".git/**",
	".wolf/**",
	"target/**",
	".next/**",
	"tests/**",
	"test/**",
	"**/*.test.*",
	"**/*.spec.*",
];

export interface FilterConfig {
	root: string;
	include?: string[];
	exclude?: string[];
}

/**
 * Resolve a path's real (canonical) absolute location. Falls back to
 * the lexical path if the file no longer exists (already deleted by the
 * worker exit). Symlinks point at the target's real path.
 */
function tryRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

export function filter(
	raw: RawFileCoverage[],
	config: FilterConfig,
): RawFileCoverage[] {
	const include = compileGlobs(config.include ?? DEFAULT_INCLUDE);
	const exclude = compileGlobs(config.exclude ?? DEFAULT_EXCLUDE);
	const root = tryRealpath(path.resolve(config.root));
	const out: RawFileCoverage[] = [];
	for (const entry of raw) {
		const real = tryRealpath(entry.file);
		const rel = path.relative(root, real).split(path.sep).join("/");
		if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
			continue;
		}
		if (!matchesAnyGlob(include, rel)) continue;
		if (matchesAnyGlob(exclude, rel)) continue;
		out.push({ ...entry, file: real });
	}
	return out;
}

/** Exposed for tests. */
export const __test__ = { globToRegex };
