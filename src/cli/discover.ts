/**
 * File-system discovery of test files.
 *
 * Design goals:
 *   - Walks a root directory
 *   - Honours `.gitignore` (basic pattern subset: basename match, leading-`/`
 *     root anchor, directory-trailing `/`, simple `*` glob, path-scoped
 *     `a/*.ts` patterns)
 *   - Uses `lstat` so symlinks are NOT followed (cycle-safe, matches Rust's
 *     `ignore::WalkBuilder::follow_links(false)`)
 *   - Tracks visited absolute paths so any escape via junctions is capped
 *   - Emits a warning on permission-denied subtrees (so silent tests-gone-missing
 *     is visible) while still returning the discoverable set
 */

import { existsSync, readFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export interface DiscoveryOptions {
	/** Filename suffixes that mark a test file (e.g. `.test.ts`). */
	suffixes?: string[];
	/** Directory basenames pruned from the walk. */
	hardExcludes?: string[];
	/** Read `.gitignore` at `root` + every descendant and apply rules. */
	honourGitignore?: boolean;
	/** Called with a human-readable message when a directory is skipped
	 *  because of an IO error (ENOENT, EACCES). Default: `console.warn`. */
	onWarn?: (message: string) => void;
}

const DEFAULT_SUFFIXES = [
	".test.ts",
	".test.tsx",
	".test.js",
	".test.mjs",
	".test.cjs",
	".spec.ts",
	".spec.tsx",
	".spec.js",
	".spec.mjs",
	".spec.cjs",
];

const DEFAULT_HARD_EXCLUDES = [
	"node_modules",
	"dist",
	"build",
	"coverage",
	".git",
	".wolf",
	"target",
	".next",
];

interface GitignorePattern {
	raw: string;
	/** If true, pattern is anchored to the directory that defined it. */
	anchored: boolean;
	/** If true, pattern only matches directories (trailing `/`). */
	dirOnly: boolean;
	/** Regex compiled from the literal pattern, matched against a relative path. */
	regex: RegExp;
}

function compilePattern(line: string): GitignorePattern | undefined {
	let p = line.trim();
	if (!p || p.startsWith("#")) return undefined;
	const anchored = p.startsWith("/");
	if (anchored) p = p.slice(1);
	const dirOnly = p.endsWith("/");
	if (dirOnly) p = p.slice(0, -1);
	if (!p) return undefined;
	// Translate a tiny glob subset to regex:
	//   `*` → `[^/]*`
	//   `**` → `.*`
	const escaped = p
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "__DOUBLESTAR__")
		.replace(/\*/g, "[^/]*")
		.replace(/__DOUBLESTAR__/g, ".*");
	const regex = anchored
		? new RegExp(`^${escaped}(?:/.*)?$`)
		: new RegExp(`(?:^|/)${escaped}(?:/.*)?$`);
	return { raw: line, anchored, dirOnly, regex };
}

function readGitignore(dir: string): GitignorePattern[] {
	const file = path.join(dir, ".gitignore");
	if (!existsSync(file)) return [];
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.map(compilePattern)
			.filter((p): p is GitignorePattern => p !== undefined);
	} catch {
		return [];
	}
}

function matches(
	pattern: GitignorePattern,
	relPath: string,
	isDir: boolean,
): boolean {
	if (pattern.dirOnly && !isDir) return false;
	return pattern.regex.test(relPath);
}

export async function discover(
	root: string,
	options: DiscoveryOptions = {},
): Promise<string[]> {
	const suffixes = options.suffixes ?? DEFAULT_SUFFIXES;
	const hardExcludes = new Set(options.hardExcludes ?? DEFAULT_HARD_EXCLUDES);
	const honourGitignore = options.honourGitignore ?? true;
	const warn = options.onWarn ?? ((m) => process.stderr.write(`helix: ${m}\n`));

	const results: string[] = [];
	const absRoot = path.isAbsolute(root) ? root : path.resolve(root);
	const visited = new Set<string>();

	async function walk(
		dir: string,
		relativeToRoot: string,
		inherited: GitignorePattern[],
	): Promise<void> {
		const realDir = path.resolve(dir);
		if (visited.has(realDir)) return;
		visited.add(realDir);

		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch (err) {
			warn(`skipping ${dir}: ${(err as NodeJS.ErrnoException).code ?? err}`);
			return;
		}
		const local = honourGitignore
			? [...inherited, ...readGitignore(dir)]
			: inherited;

		for (const name of entries) {
			if (hardExcludes.has(name)) continue;
			const relPath = relativeToRoot ? `${relativeToRoot}/${name}` : name;
			const fullPath = path.join(dir, name);
			let st: Awaited<ReturnType<typeof lstat>>;
			try {
				st = await lstat(fullPath);
			} catch (err) {
				warn(
					`skipping ${fullPath}: ${(err as NodeJS.ErrnoException).code ?? err}`,
				);
				continue;
			}
			// Symlinks are NOT followed. Users who need symlink-following can
			// walk the target manually; matches Rust's `follow_links(false)`.
			if (st.isSymbolicLink()) continue;
			if (local.some((p) => matches(p, relPath, st.isDirectory()))) continue;
			if (st.isDirectory()) {
				await walk(fullPath, relPath, local);
				continue;
			}
			if (!st.isFile()) continue;
			if (suffixes.some((s) => name.endsWith(s))) {
				results.push(fullPath);
			}
		}
	}

	await walk(absRoot, "", []);
	results.sort();
	return results;
}
