/**
 * `coverage-summary.json` — Istanbul-compatible shape consumed by CI
 * tooling (lcov-reporter-action, Codecov uploaders that prefer JSON).
 *
 * File keys are emitted as paths RELATIVE to `root` so the artifact is
 * portable across machines. The reserved `total` key holds the
 * aggregate; if a real file path collides with it (extraordinarily
 * unlikely after relativisation), we keep the totals row and skip the
 * collision rather than overwrite — protecting the consumer's invariant.
 */

import path from "node:path";
import type { CoverageSummary } from "../types.js";

function rel(file: string, root: string): string {
	const r = path.relative(root, file).split(path.sep).join("/");
	return r.length > 0 && !r.startsWith("..") ? r : file;
}

export function jsonSummary(summary: CoverageSummary, root: string): string {
	// Use a fresh prototype-less object so a pathological file path of
	// "__proto__" can't pollute the global Object prototype.
	const out: Record<string, unknown> = Object.create(null);
	out.total = summary.total;
	for (const f of summary.files) {
		const key = rel(f.file, root);
		if (key === "total") {
			// Astronomical edge: a file literally named "total" at the root.
			// Prefer correctness of the totals row over reporting that file.
			continue;
		}
		out[key] = {
			lines: f.lines,
			statements: f.statements,
			functions: f.functions,
			branches: f.branches,
		};
	}
	return `${JSON.stringify(out, null, 2)}\n`;
}
