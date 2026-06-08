/**
 * Shared types for the coverage pipeline.
 *
 * Stages: raw V8 JSON → `RawFileCoverage` (per-file after filter) →
 * `AggregateCoverage` (merged across workers) → reporters / thresholds.
 */

/** V8 function-range entry as emitted in `coverage-*.json` files. */
export interface V8Range {
	startOffset: number;
	endOffset: number;
	count: number;
}

export interface V8Function {
	functionName: string;
	ranges: V8Range[];
	isBlockCoverage: boolean;
}

export interface V8Script {
	scriptId: string;
	url: string;
	functions: V8Function[];
}

export interface V8CoverageFile {
	result: V8Script[];
}

/**
 * Normalised per-file coverage — the unit passed between the collector,
 * filter, aggregator, reporter and threshold stages.
 */
export interface RawFileCoverage {
	/** Absolute file path (decoded from file:// URL). */
	file: string;
	/** Source text at the time V8 recorded coverage — needed to compute line
	 *  offsets. We fall back to reading from disk if absent. */
	source: string;
	functions: V8Function[];
}

export interface FileSummary {
	file: string;
	lines: { covered: number; total: number };
	functions: { covered: number; total: number };
	statements: { covered: number; total: number };
	branches: { covered: number; total: number };
	/** Line numbers (1-based) with hit counts — for lcov DA entries. */
	lineHits: Array<{ line: number; count: number }>;
	/** Functions, with `(name, line, count)` — for lcov FN/FNDA entries. */
	functionHits: Array<{ name: string; line: number; count: number }>;
}

export interface Totals {
	lines: { covered: number; total: number; pct: number };
	functions: { covered: number; total: number; pct: number };
	statements: { covered: number; total: number; pct: number };
	branches: { covered: number; total: number; pct: number };
}

export interface CoverageSummary {
	files: FileSummary[];
	total: Totals;
}

export interface Thresholds {
	lines?: number;
	functions?: number;
	statements?: number;
	branches?: number;
}

export interface ThresholdViolation {
	metric: keyof Thresholds;
	actual: number;
	threshold: number;
}

export interface CoverageOptions {
	enabled: boolean;
	include?: string[];
	exclude?: string[];
	reporters?: string[];
	outputDir?: string;
	thresholds?: Thresholds;
	/**
	 * Project root coverage paths are relative to (typically the package
	 * directory containing `package.json`). Defaults to `RunConfig.root`.
	 */
	root?: string;
}
