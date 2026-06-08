/**
 * Parse `git diff --unified=0 --no-color <base>...HEAD` output into a
 * `DiffMap`. Why three-dot: it computes the diff at the merge-base, so
 * commits made on `base` AFTER our branch diverged are excluded. That's
 * the "what this PR contributes" semantic users expect.
 *
 * We force `--src-prefix=a/ --dst-prefix=b/` and `core.quotepath=false`
 * so the parser doesn't have to guess at user-side `diff.noprefix` or
 * non-ASCII path quoting.
 *
 * Renames produce `+++ b/<new path>` so they're picked up at the new
 * location. Deletes produce `+++ /dev/null` and are skipped. Binary
 * files produce no `+` lines so they contribute nothing.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { DiffMap } from "./types.js";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const FILE_HEADER_PLUS = /^\+\+\+ (?:b\/(.*)|\/dev\/null)$/;

export interface ParseOptions {
	cwd: string;
	base: string;
}

function tryRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

export function parseDiff(opts: ParseOptions): DiffMap {
	const result = spawnSync(
		"git",
		[
			"-c",
			"core.quotepath=false",
			"diff",
			"--unified=0",
			"--no-color",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			`${opts.base}...HEAD`,
		],
		{
			cwd: opts.cwd,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	if (result.error) {
		const err = result.error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			throw new Error("git binary not found on PATH");
		}
		if (err.code === "ENOBUFS") {
			throw new Error(
				"diff output exceeded 64 MB — branch is too divergent to overlay",
			);
		}
		throw new Error(`git diff failed: ${err.message}`);
	}
	if (result.status !== 0) {
		throw new Error(
			`git diff exited ${result.status}: ${result.stderr?.trim() || "(no stderr — likely shallow clone or pruned ref)"}`,
		);
	}
	return parseDiffString(result.stdout, opts.cwd);
}

/**
 * Pure parser — exposed separately so tests can feed canned diff
 * strings without spawning git. Keys are canonicalised via realpath so
 * they line up with V8 coverage paths (which `filter.ts` realpaths).
 */
export function parseDiffString(diff: string, cwd: string): DiffMap {
	const map: DiffMap = new Map();
	let currentFile: string | undefined;
	let nextAddedLine = 0;
	const lines = diff.split(/\r?\n/);
	for (const line of lines) {
		const fileMatch = line.match(FILE_HEADER_PLUS);
		if (fileMatch) {
			const newPath = fileMatch[1];
			if (!newPath) {
				currentFile = undefined;
				nextAddedLine = 0;
				continue;
			}
			currentFile = tryRealpath(path.resolve(cwd, newPath));
			nextAddedLine = 0;
			continue;
		}
		if (!currentFile) continue;
		const hunkMatch = line.match(HUNK_HEADER);
		if (hunkMatch) {
			nextAddedLine = Number.parseInt(hunkMatch[1], 10);
			continue;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			if (nextAddedLine < 1) {
				// `+0,0` deletion-only hunks set nextAddedLine = 0; ignore stray
				// `+` lines rather than emit invalid line numbers.
				continue;
			}
			let set = map.get(currentFile);
			if (!set) {
				set = new Set();
				map.set(currentFile, set);
			}
			set.add(nextAddedLine);
			nextAddedLine += 1;
		}
	}
	return map;
}
