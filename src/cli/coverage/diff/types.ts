/**
 * Types for the diff-coverage pipeline.
 *
 * `DiffMap` is the output of `parse.ts` — for every file changed in
 * `<base>...HEAD`, the set of 1-based line numbers added or modified
 * (i.e. lines starting with `+` in unified diff, excluding the `+++`
 * header). Deleted lines aren't relevant: we only care whether NEW
 * code is covered.
 *
 * `DiffFileSummary` and `DiffSummary` mirror the shape of the full-tree
 * `FileSummary` / `CoverageSummary` so the existing threshold
 * enforcement machinery applies unchanged.
 */

export type DiffMap = Map<string, Set<number>>;

export interface DiffFileSummary {
	file: string;
	/** Lines added by the PR (1-based). */
	added: number;
	/** Subset of `added` that have a hit count > 0 in the coverage summary. */
	covered: number;
	/** Per-line breakdown for reporters. */
	lineHits: Array<{ line: number; covered: boolean }>;
}

export interface DiffSummary {
	files: DiffFileSummary[];
	total: {
		added: number;
		covered: number;
		pct: number;
	};
}

export interface DiffOptions {
	enabled: boolean;
	/** Git revision to diff against. Default: resolved by `base.ts`. */
	base?: string;
	/** Inline thresholds. Reuses the full-tree shape. */
	thresholds?: import("../types.js").Thresholds;
	/** Output dir for `coverage-diff.json`. Defaults to coverage outputDir. */
	outputDir?: string;
	/** Where to spawn `git diff`. Defaults to `process.cwd()`. */
	cwd?: string;
}
