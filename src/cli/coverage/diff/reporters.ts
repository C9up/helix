/**
 * Diff-coverage reporters: text summary + JSON.
 *
 * The text reporter mirrors the full-tree text format so users can read
 * both side-by-side. JSON is namespaced under `files` to avoid
 * collisions with the literal `total` key (in case a file is named
 * `total`).
 */

import path from "node:path";
import type { DiffFileSummary, DiffSummary } from "./types.js";

function rel(file: string, root: string): string {
	const r = path.relative(root, file).split(path.sep).join("/");
	return r.length > 0 && !r.startsWith("..") ? r : file;
}

function padRight(s: string, w: number): string {
	if (s.length === w) return s;
	if (s.length > w) return `…${s.slice(s.length - w + 1)}`;
	return s + " ".repeat(w - s.length);
}

function fmtPct(n: number): string {
	return `${n.toFixed(2).padStart(6)}%`;
}

export function diffTextSummary(summary: DiffSummary, root: string): string {
	const lines: string[] = [];
	lines.push("");
	lines.push("── Diff coverage ───────────────────────────────────────────");
	if (summary.files.length === 0) {
		lines.push("  No instrumented files were touched by the diff.");
		lines.push(
			`  ${summary.total.covered}/${summary.total.added} lines covered`,
		);
		return `${lines.join("\n")}\n`;
	}
	lines.push(
		`${padRight("File", 50)}  ${"Covered".padStart(10)}  ${"%".padStart(8)}`,
	);
	lines.push("─".repeat(72));
	for (const f of summary.files) {
		const ratio = `${f.covered}/${f.added}`;
		const pct = f.added > 0 ? (f.covered / f.added) * 100 : 100;
		lines.push(
			`${padRight(rel(f.file, root), 50)}  ${ratio.padStart(10)}  ${fmtPct(pct)}`,
		);
	}
	lines.push("─".repeat(72));
	lines.push(
		`${padRight("Total", 50)}  ${`${summary.total.covered}/${summary.total.added}`.padStart(10)}  ${fmtPct(summary.total.pct)}`,
	);
	return `${lines.join("\n")}\n`;
}

interface DiffJsonFileEntry {
	added: number;
	covered: number;
	lineHits: DiffFileSummary["lineHits"];
}

interface DiffJsonOutput {
	total: DiffSummary["total"];
	files: Record<string, DiffJsonFileEntry>;
}

export function diffJson(summary: DiffSummary, root: string): string {
	const filesOut: Record<string, DiffJsonFileEntry> = Object.create(null);
	for (const f of summary.files) {
		filesOut[rel(f.file, root)] = {
			added: f.added,
			covered: f.covered,
			lineHits: f.lineHits,
		};
	}
	const out: DiffJsonOutput = {
		total: summary.total,
		files: filesOut,
	};
	return `${JSON.stringify(out, null, 2)}\n`;
}
