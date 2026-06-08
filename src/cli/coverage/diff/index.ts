/**
 * Diff-coverage facade — wires base resolution → git diff → parser →
 * overlay → reporters → thresholds. Called by `run.ts` after the
 * full-tree finalise.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { enforce } from "../thresholds.js";
import type {
	CoverageSummary,
	Thresholds,
	ThresholdViolation,
} from "../types.js";
import { GitMissingError, resolveBaseRef } from "./base.js";
import { overlay } from "./overlay.js";
import { parseDiff } from "./parse.js";
import { diffJson, diffTextSummary } from "./reporters.js";
import type { DiffOptions, DiffSummary } from "./types.js";

export type { DiffOptions, DiffSummary } from "./types.js";

export interface DiffFinaliseInput extends DiffOptions {
	root: string;
	coverage: CoverageSummary;
}

export interface DiffFinaliseResult {
	summary: DiffSummary;
	violations: ThresholdViolation[];
	textReport: string;
	reportFiles: string[];
	/** When `undefined`, the diff stage was skipped (not in a repo, no
	 *  base ref, etc.) — callers should print `warning` and move on. */
	warning?: string;
}

/**
 * Wrap the diff totals into a `CoverageSummary`-shaped object so we can
 * reuse the full-tree `enforce()` helper. Only `lines`/`statements` are
 * populated; `functions`/`branches` are unsupported in diff mode and are
 * rejected upfront in `validateDiffThresholds`.
 */
function toCoverageSummary(diff: DiffSummary): CoverageSummary {
	return {
		files: [],
		total: {
			lines: {
				covered: diff.total.covered,
				total: diff.total.added,
				pct: diff.total.pct,
			},
			statements: {
				covered: diff.total.covered,
				total: diff.total.added,
				pct: diff.total.pct,
			},
			functions: { covered: 0, total: 0, pct: 100 },
			branches: { covered: 0, total: 0, pct: 100 },
		},
	};
}

function violationLine(
	metric: keyof Thresholds,
	actual: number,
	threshold: number,
): string {
	return `coverage-diff: ${metric} ${actual.toFixed(1)} < threshold ${threshold}`;
}

/**
 * Reject `functions`/`branches` thresholds in diff mode — we only track
 * line-level diff coverage today, so silently passing those metrics
 * would let users gate on metrics that always read 100%.
 */
function validateDiffThresholds(t: Thresholds | undefined): void {
	if (!t) return;
	const unsupported: string[] = [];
	if (typeof t.functions === "number" && t.functions > 0)
		unsupported.push("functions");
	if (typeof t.branches === "number" && t.branches > 0)
		unsupported.push("branches");
	if (unsupported.length > 0) {
		throw new Error(
			`diff-cov thresholds: ${unsupported.join(", ")} are not supported (line-only). Drop those keys.`,
		);
	}
}

export async function finaliseDiff(
	input: DiffFinaliseInput,
): Promise<DiffFinaliseResult> {
	validateDiffThresholds(input.thresholds);

	const cwd = input.cwd ?? input.root;
	let base: string | undefined;
	try {
		base = input.base ?? resolveBaseRef(cwd);
	} catch (err) {
		if (err instanceof GitMissingError) {
			return {
				summary: { files: [], total: { added: 0, covered: 0, pct: 100 } },
				violations: [],
				textReport: "",
				reportFiles: [],
				warning: "diff-cov: git binary not found on PATH. Skipping.",
			};
		}
		throw err;
	}
	if (!base) {
		return {
			summary: { files: [], total: { added: 0, covered: 0, pct: 100 } },
			violations: [],
			textReport: "",
			reportFiles: [],
			warning:
				"diff-cov: no git base ref resolved (origin/main, main, master). Skipping.",
		};
	}

	let diffMap: ReturnType<typeof parseDiff>;
	try {
		diffMap = parseDiff({ cwd, base });
	} catch (err) {
		return {
			summary: { files: [], total: { added: 0, covered: 0, pct: 100 } },
			violations: [],
			textReport: "",
			reportFiles: [],
			warning: `diff-cov: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const summary = overlay(input.coverage, diffMap);

	const reportFiles: string[] = [];
	const outputDir = input.outputDir ?? path.join(input.root, "coverage");
	await mkdir(outputDir, { recursive: true });
	const file = path.join(outputDir, "coverage-diff.json");
	await writeFile(file, diffJson(summary, input.root), "utf8");
	reportFiles.push(file);

	const textReport = diffTextSummary(summary, input.root);

	let violations: ThresholdViolation[] = [];
	if (input.thresholds) {
		violations = enforce(toCoverageSummary(summary), input.thresholds);
	}

	return { summary, violations, textReport, reportFiles };
}

/** Reformat threshold violations with the `coverage-diff:` prefix. */
export function diffViolationSummary(violations: ThresholdViolation[]): string {
	return violations
		.map((v) => violationLine(v.metric, v.actual, v.threshold))
		.join("\n");
}
