/**
 * Text summary reporter — one line per file + totals, written to stdout.
 * Deliberately terse (mirrors c8's default output) so it fits alongside
 * the test reporter's summary without overwhelming.
 */

import type { CoverageSummary } from "../types.js";

function fmtPct(n: number): string {
	return `${n.toFixed(2).padStart(6)}%`;
}

function padRight(s: string, w: number): string {
	if (s.length === w) return s;
	if (s.length > w) {
		// Ellipsize from the LEFT — preserves the filename tail which is
		// usually more informative than the leading directory.
		return `…${s.slice(s.length - w + 1)}`;
	}
	return s + " ".repeat(w - s.length);
}

export function textSummary(summary: CoverageSummary, root: string): string {
	const lines: string[] = [];
	lines.push("");
	lines.push("── Coverage ─────────────────────────────────────────────────");
	lines.push(
		`${padRight("File", 50)}  ${"Lines".padStart(8)}  ${"Funcs".padStart(8)}`,
	);
	lines.push("─".repeat(70));
	for (const f of summary.files) {
		const rel = f.file.startsWith(root)
			? f.file.slice(root.length + 1)
			: f.file;
		const linesPct =
			f.lines.total > 0 ? (f.lines.covered / f.lines.total) * 100 : 100;
		const fnPct =
			f.functions.total > 0
				? (f.functions.covered / f.functions.total) * 100
				: 100;
		lines.push(`${padRight(rel, 50)}  ${fmtPct(linesPct)}  ${fmtPct(fnPct)}`);
	}
	lines.push("─".repeat(70));
	lines.push(
		`${padRight("All files", 50)}  ${fmtPct(summary.total.lines.pct)}  ${fmtPct(summary.total.functions.pct)}`,
	);
	return `${lines.join("\n")}\n`;
}
