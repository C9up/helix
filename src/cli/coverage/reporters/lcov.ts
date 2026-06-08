/**
 * LCOV reporter — writes standard `lcov.info` that Codecov, Coveralls,
 * and IDE coverage gutters consume directly.
 *
 * Format reference: `man geninfo` /
 *   http://ltp.sourceforge.net/coverage/lcov/geninfo.1.php
 *
 * Paths in `SF:` are emitted RELATIVE TO `root` so the same artifact
 * lines up across machines (developer laptop, CI runner, Codecov server).
 */

import path from "node:path";
import type { CoverageSummary } from "../types.js";

function rel(file: string, root: string): string {
	const r = path.relative(root, file).split(path.sep).join("/");
	return r.length > 0 && !r.startsWith("..") ? r : file;
}

export function lcov(summary: CoverageSummary, root: string): string {
	const out: string[] = [];
	for (const f of summary.files) {
		out.push(`TN:`);
		out.push(`SF:${rel(f.file, root)}`);

		let fnf = 0;
		let fnh = 0;
		for (const fn of f.functionHits) {
			// Skip records lcov rejects (line < 1).
			if (fn.line < 1) continue;
			out.push(`FN:${fn.line},${fn.name}`);
			out.push(`FNDA:${fn.count},${fn.name}`);
			fnf += 1;
			if (fn.count > 0) fnh += 1;
		}
		out.push(`FNF:${fnf}`);
		out.push(`FNH:${fnh}`);

		let lf = 0;
		let lh = 0;
		for (const l of f.lineHits) {
			out.push(`DA:${l.line},${l.count}`);
			lf += 1;
			if (l.count > 0) lh += 1;
		}
		out.push(`LF:${lf}`);
		out.push(`LH:${lh}`);

		out.push(`BRF:0`);
		out.push(`BRH:0`);
		out.push(`end_of_record`);
	}
	return `${out.join("\n")}\n`;
}
