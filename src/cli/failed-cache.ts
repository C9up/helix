/**
 * The `--failed` cache — helix's "run what failed last time".
 *
 * helix writes the failed test TITLES to a cache file after every run, and
 * `--failed` turns them into a `--tests` filter on the next one. Same contract
 * here, same file shape (`{ tests: string[] }`), under
 * `node_modules/.cache/helix/summary.json`.
 *
 * Named deviation: the cache is written only when the run produced per-test
 * detail — i.e. the TypeScript pool. The native (Rust) engine reports totals
 * only, so a run it owns leaves the previous cache untouched rather than
 * blanking it. `--failed` therefore forces the TypeScript pool.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Summary } from "./summary.js";

/** Where the cache lives, relative to the project root. */
function cacheFile(root: string): string {
	return path.join(root, "node_modules", ".cache", "helix", "summary.json");
}

/** Titles of the tests that failed, in run order, without duplicates. */
export function failedTestTitles(summary: Summary): string[] {
	const titles = new Set<string>();
	for (const file of summary.files) {
		for (const test of file.tests) {
			if (test.status === "fail") titles.add(test.name);
		}
	}
	return [...titles];
}

/**
 * Persist the failed titles for a later `--failed`. Never throws: a run must
 * not fail because its cache could not be written.
 */
export async function writeFailedCache(
	root: string,
	summary: Summary,
): Promise<void> {
	const file = cacheFile(root);
	try {
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({ tests: failedTestTitles(summary) }),
			"utf8",
		);
	} catch {
		// Best-effort — a read-only or missing node_modules is not a run failure.
	}
}

/**
 * The titles cached by the previous run, or an empty list when there is no
 * usable cache (never run, unreadable, or malformed).
 */
export async function readFailedCache(root: string): Promise<string[]> {
	try {
		const raw = await readFile(cacheFile(root), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return [];
		const tests = Reflect.get(parsed, "tests");
		if (!Array.isArray(tests)) return [];
		return tests.filter((t): t is string => typeof t === "string");
	} catch {
		return [];
	}
}
