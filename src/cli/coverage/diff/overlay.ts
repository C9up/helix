/**
 * Overlay the diff map onto a `CoverageSummary` to compute per-file
 * "added vs covered" totals.
 *
 * For each file in the diff:
 *   - find the matching coverage entry by absolute path
 *   - intersect the added line numbers with `lineHits` (count > 0 means
 *     covered)
 *   - emit a `DiffFileSummary`
 *
 * Files in the diff with no coverage entry are still reported (added
 * lines, 0 covered) so a freshly-added module without any tests shows
 * up red. Files in coverage but not in the diff are skipped (the PR
 * didn't touch them, so they don't move the diff-coverage needle).
 */

import type { CoverageSummary } from "../types.js";
import type { DiffFileSummary, DiffMap, DiffSummary } from "./types.js";

function pct(covered: number, added: number): number {
	if (added === 0) return 100;
	return Math.round((covered / added) * 10000) / 100;
}

export function overlay(coverage: CoverageSummary, diff: DiffMap): DiffSummary {
	const coverageByFile = new Map(coverage.files.map((f) => [f.file, f]));
	const files: DiffFileSummary[] = [];
	let totalAdded = 0;
	let totalCovered = 0;

	for (const [file, addedLines] of diff) {
		if (addedLines.size === 0) continue;
		const cov = coverageByFile.get(file);
		const hitsByLine = cov
			? new Map(cov.lineHits.map((h) => [h.line, h.count]))
			: undefined;
		const sortedAdded = [...addedLines].sort((a, b) => a - b);
		const lineHits: DiffFileSummary["lineHits"] = sortedAdded.map((line) => {
			const count = hitsByLine?.get(line);
			return { line, covered: typeof count === "number" && count > 0 };
		});
		const covered = lineHits.filter((h) => h.covered).length;
		files.push({
			file,
			added: addedLines.size,
			covered,
			lineHits,
		});
		totalAdded += addedLines.size;
		totalCovered += covered;
	}

	files.sort((a, b) => a.file.localeCompare(b.file));
	return {
		files,
		total: {
			added: totalAdded,
			covered: totalCovered,
			pct: pct(totalCovered, totalAdded),
		},
	};
}
