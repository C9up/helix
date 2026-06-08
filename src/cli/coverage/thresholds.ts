/**
 * Threshold enforcement — compare each configured metric (`lines` /
 * `functions` / `statements` / `branches`) against the aggregate totals.
 * Returns the list of violations; caller decides whether to set
 * `exitCode = 1` (today: yes, always).
 */

import type {
	CoverageSummary,
	Thresholds,
	ThresholdViolation,
} from "./types.js";

const METRICS: Array<keyof Thresholds> = [
	"lines",
	"functions",
	"statements",
	"branches",
];

/**
 * Validate user-supplied thresholds. Throws on NaN / negative / >100 so
 * config typos fail loudly. Empty / undefined values are accepted (no
 * gate on that metric).
 */
function validate(thresholds: Thresholds): void {
	for (const metric of METRICS) {
		const v = thresholds[metric];
		if (v === undefined) continue;
		if (typeof v !== "number" || !Number.isFinite(v)) {
			throw new Error(
				`coverage threshold ${metric}: expected a finite number, got ${v}`,
			);
		}
		if (v < 0 || v > 100) {
			throw new Error(`coverage threshold ${metric}: expected 0–100, got ${v}`);
		}
	}
}

export function enforce(
	summary: CoverageSummary,
	thresholds: Thresholds,
): ThresholdViolation[] {
	validate(thresholds);
	const violations: ThresholdViolation[] = [];
	for (const metric of METRICS) {
		const threshold = thresholds[metric];
		if (threshold === undefined) continue;
		// Compute the actual ratio fresh from totals (without the rounded
		// `pct`). A threshold of 100 then catches 99.999% correctly instead
		// of being defeated by `pct`'s 2-decimal rounding.
		const tot = summary.total[metric];
		const actual = tot.total === 0 ? 100 : (tot.covered / tot.total) * 100;
		if (actual < threshold) {
			violations.push({ metric, actual, threshold });
		}
	}
	return violations;
}

/**
 * Spec format (AC #5): `coverage: lines 84.2 < threshold 88` — one
 * decimal place, no percent signs.
 */
export function violationSummary(violations: ThresholdViolation[]): string {
	return violations
		.map(
			(v) =>
				`coverage: ${v.metric} ${v.actual.toFixed(1)} < threshold ${v.threshold}`,
		)
		.join("\n");
}
