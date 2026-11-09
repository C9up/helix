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
import type {
	RawFileCoverage,
	V8Function,
	V8Range,
	V8Script,
} from "./types.js";

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
		let scripts: V8Script[];
		try {
			const raw = await readFile(p, "utf8");
			scripts = scriptsOf(JSON.parse(raw));
		} catch {
			continue;
		}
		for (const script of scripts) {
			if (!script.url?.startsWith("file://")) continue;
			// V8 sometimes appends `?query` params (our worker uses them as
			// cache-busters) — strip them so the same file from two workers
			// merges correctly.
			const [cleanUrl = script.url] = script.url.split("?");
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

/** The scripts of a V8 coverage dump, keeping only entries of the right shape. */
function scriptsOf(parsed: unknown): V8Script[] {
	if (parsed === null || typeof parsed !== "object") return [];
	const result: unknown = Reflect.get(parsed, "result");
	return Array.isArray(result) ? result.filter(isScript) : [];
}

function isScript(value: unknown): value is V8Script {
	if (value === null || typeof value !== "object") return false;
	const functions: unknown = Reflect.get(value, "functions");
	return (
		typeof Reflect.get(value, "scriptId") === "string" &&
		typeof Reflect.get(value, "url") === "string" &&
		Array.isArray(functions) &&
		functions.every(isFunction)
	);
}

function isFunction(value: unknown): value is V8Function {
	if (value === null || typeof value !== "object") return false;
	const ranges: unknown = Reflect.get(value, "ranges");
	return (
		typeof Reflect.get(value, "functionName") === "string" &&
		typeof Reflect.get(value, "isBlockCoverage") === "boolean" &&
		Array.isArray(ranges) &&
		ranges.every(isRange)
	);
}

function isRange(value: unknown): value is V8Range {
	if (value === null || typeof value !== "object") return false;
	return (
		typeof Reflect.get(value, "startOffset") === "number" &&
		typeof Reflect.get(value, "endOffset") === "number" &&
		typeof Reflect.get(value, "count") === "number"
	);
}
