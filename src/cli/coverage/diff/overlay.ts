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
		let lineHits: DiffFileSummary["lineHits"];
		if (hitsByLine) {
			// Only EXECUTABLE added lines count toward diff coverage. The coverage
			// map lists every instrumented line (count >= 0, incl. count-0 unrun
			// lines), so an added line absent from it is non-executable (comment /
			// blank / type-only). Scoring those uncovered inflated the denominator
			// and understated diff-% (audit 2026-06-13).
			lineHits = sortedAdded
				.filter((line) => hitsByLine.has(line))
				.map((line) => ({ line, covered: (hitsByLine.get(line) ?? 0) > 0 }));
		} else {
			// No coverage entry for this file — a freshly-added, untested module.
			// Keep every added line as uncovered so it shows red.
			lineHits = sortedAdded.map((line) => ({ line, covered: false }));
		}
		const covered = lineHits.filter((h) => h.covered).length;
		const added = lineHits.length;
		files.push({
			file,
			added,
			covered,
			lineHits,
		});
		totalAdded += added;
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
