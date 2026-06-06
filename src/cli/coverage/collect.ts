/**
 * Reads every `coverage-*.json` produced by the V8 profiler in a given
 * directory, decodes `file://` URLs, and returns a normalised list of
 * `RawFileCoverage` entries (one per unique script URL).
 *
 * Workers write coverage via `NODE_V8_COVERAGE=<dir>` — the orchestrator
 * sets this env var on every spawn and reads the directory after all
 * workers exit. Multiple workers may record the same file; we return ALL
 * entries here and let `aggregate.ts` merge.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RawFileCoverage, V8CoverageFile } from "./types.js";

export async function collect(dir: string): Promise<RawFileCoverage[]> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const jsonFiles = entries.filter((e) => e.endsWith(".json"));
	const all: RawFileCoverage[] = [];
	for (const name of jsonFiles) {
		const p = path.join(dir, name);
		let parsed: V8CoverageFile;
		try {
			const raw = await readFile(p, "utf8");
			parsed = JSON.parse(raw) as V8CoverageFile;
		} catch {
			continue;
		}
		for (const script of parsed.result ?? []) {
			if (!script.url?.startsWith("file://")) continue;
			// V8 sometimes appends `?query` params (our worker uses them as
			// cache-busters) — strip them so the same file from two workers
			// merges correctly.
			const cleanUrl = script.url.split("?")[0];
			let file: string;
			try {
				file = fileURLToPath(cleanUrl);
			} catch {
				continue;
			}
			let source = "";
			try {
				source = await readFile(file, "utf8");
			} catch {
				// Source read may fail for transient temp files or modules that
				// have been GC'd — leave empty; downstream stages fall back to
				// offset-only computation.
			}
			all.push({
				file,
				source,
				functions: script.functions ?? [],
			});
		}
	}
	return all;
}
