/**
 * Aggregation: merge N raw coverage entries (possibly for the same file
 * from different workers) into a single `CoverageSummary` with per-file
 * and total line / function counts.
 *
 * Range merging strategy mirrors `v8-to-istanbul`:
 *   - Walk ranges OUTERMOST-first so inner ranges OVERWRITE the outer
 *     count for the lines they cover. A `count: 0` inner range carved
 *     out of a `count: 5` outer correctly marks those inner lines as
 *     uncovered, matching V8's block-coverage semantics. The previous
 *     `Math.max` strategy hid uncovered branches behind their outer
 *     function's hit count.
 *   - V8 emits BYTE offsets (UTF-8); we convert via Buffer.byteLength
 *     so non-ASCII source code maps lines correctly.
 *   - When two workers cover the same file:
 *       - if their `source` differs (cache-busting query loaded different
 *         content), we keep the longer source (best-effort) but emit a
 *         warning — offsets are only consistent within one source.
 *       - functions are deduplicated by `(name, startOffset)` so the
 *         lcov FNF count doesn't double.
 */

import type {
	CoverageSummary,
	FileSummary,
	RawFileCoverage,
	Totals,
	V8Function,
} from "./types.js";

/**
 * Build a function `byteOffset → 1-based line number` over `source`.
 * V8 offsets are UTF-8 byte offsets, so we walk the string code-unit by
 * code-unit and accumulate byte length to keep both indices in sync.
 *
 * Returns `[mapper, totalBytes]`. `totalBytes` is needed so callers can
 * detect offsets pointing past EOF (corrupt input) and clamp.
 */
function buildOffsetToLine(
	source: string,
): [(offset: number) => number, number] {
	const lineStarts: number[] = [0];
	let byteIndex = 0;
	for (let i = 0; i < source.length; i += 1) {
		const code = source.charCodeAt(i);
		// UTF-16 surrogate pair → encodes a single 4-byte UTF-8 char.
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
			const next = source.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				byteIndex += 4;
				i += 1;
				continue;
			}
		}
		// Lone surrogate or BMP char — Buffer.byteLength of one code unit:
		//   < 0x80   → 1 byte
		//   < 0x800  → 2 bytes
		//   else     → 3 bytes (BMP non-surrogate)
		if (code < 0x80) {
			byteIndex += 1;
			if (code === 10 /* \n */) lineStarts.push(byteIndex);
		} else if (code < 0x800) {
			byteIndex += 2;
		} else {
			byteIndex += 3;
		}
	}
	const totalBytes = byteIndex;
	const mapper = (offset: number): number => {
		const clamped = Math.max(0, Math.min(offset, totalBytes));
		// Binary search for the largest lineStart <= clamped.
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >>> 1;
			if (lineStarts[mid] <= clamped) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};
	return [mapper, totalBytes];
}

function computeFileSummary(entry: RawFileCoverage): FileSummary {
	const [offsetToLine] = buildOffsetToLine(entry.source);
	const lineHitsMap = new Map<number, number>();
	const functionHits: FileSummary["functionHits"] = [];
	let fnCovered = 0;
	// Apply ranges across ALL functions in one global pass, sorted by
	// span DESC. The whole-file pseudo-function (largest span) lands
	// first; inner functions and their inner ranges overwrite — so a
	// never-called inner function correctly drops its lines back to
	// count=0 even though the script itself executed at count=1.
	const allRanges: Array<{
		startOffset: number;
		endOffset: number;
		count: number;
	}> = [];
	for (const fn of entry.functions) {
		for (const r of fn.ranges) {
			if (r.endOffset > r.startOffset) allRanges.push(r);
		}
	}
	allRanges.sort((a, b) => {
		const spanA = a.endOffset - a.startOffset;
		const spanB = b.endOffset - b.startOffset;
		if (spanA !== spanB) return spanB - spanA;
		return a.startOffset - b.startOffset;
	});
	for (const r of allRanges) {
		const startLine = offsetToLine(r.startOffset);
		const endLine = offsetToLine(r.endOffset - 1);
		for (let line = startLine; line <= endLine; line += 1) {
			lineHitsMap.set(line, r.count);
		}
	}
	for (const fn of entry.functions) {
		const firstRange = fn.ranges[0];
		// Skip pseudo-functions / synthetic entries with no usable range so
		// reports don't carry `FN:0,name` (lcov rejects line < 1).
		if (!firstRange) continue;
		const fnCount = firstRange.count;
		const fnLine = offsetToLine(firstRange.startOffset);
		if (fnCount > 0) fnCovered += 1;
		functionHits.push({
			name: fn.functionName || "(anonymous)",
			line: Math.max(1, fnLine),
			count: fnCount,
		});
	}
	const lineHits = Array.from(lineHitsMap.entries())
		.map(([line, count]) => ({ line, count }))
		.sort((a, b) => a.line - b.line);
	const linesCovered = lineHits.filter((h) => h.count > 0).length;
	const linesTotal = lineHits.length;
	const fnTotal = functionHits.length;
	return {
		file: entry.file,
		lines: { covered: linesCovered, total: linesTotal },
		// Statements ≈ lines (V8 doesn't expose AST statement boundaries —
		// matches Vitest's v8 provider).
		statements: { covered: linesCovered, total: linesTotal },
		functions: { covered: fnCovered, total: fnTotal },
		// Branches deferred; report 0/0 so reporters / thresholds can still
		// format the field consistently.
		branches: { covered: 0, total: 0 },
		lineHits,
		functionHits,
	};
}

/**
 * Merge two raw entries for the same file. Functions are deduplicated by
 * `(name, startOffset)` so concatenation doesn't double FNF in lcov.
 * If `source` differs, we keep the longer one (best effort) and emit a
 * stderr advisory — offsets only line up within one source.
 */
function mergeRaw(a: RawFileCoverage, b: RawFileCoverage): RawFileCoverage {
	if (a.source && b.source && a.source !== b.source) {
		process.stderr.write(
			`helix-coverage: ${a.file} has divergent source content across workers — line attribution may be off\n`,
		);
	}
	const seen = new Set<string>();
	const merged: V8Function[] = [];
	for (const fn of [...a.functions, ...b.functions]) {
		const startOffset = fn.ranges[0]?.startOffset ?? -1;
		const key = `${fn.functionName}@${startOffset}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(fn);
	}
	return {
		file: a.file,
		source: a.source.length >= b.source.length ? a.source : b.source,
		functions: merged,
	};
}

function pct(covered: number, total: number): number {
	if (total === 0) return 100;
	return Math.round((covered / total) * 10000) / 100;
}

export function aggregate(raw: RawFileCoverage[]): CoverageSummary {
	const byFile = new Map<string, RawFileCoverage>();
	for (const entry of raw) {
		// Skip files we couldn't read source for — emitting a 1-line ghost
		// summary based on collapsed line=1 mapping is worse than omission.
		if (!entry.source) {
			process.stderr.write(
				`helix-coverage: skipping ${entry.file} — source unreadable\n`,
			);
			continue;
		}
		const prev = byFile.get(entry.file);
		byFile.set(entry.file, prev ? mergeRaw(prev, entry) : entry);
	}
	const files = Array.from(byFile.values())
		.map(computeFileSummary)
		// Files that ended up with 0 lines / 0 functions (no V8 data) are
		// dropped — they distort per-file averages and clutter the table.
		.filter((f) => f.lines.total > 0 || f.functions.total > 0)
		.sort((a, b) => a.file.localeCompare(b.file));

	const totals: Totals = {
		lines: { covered: 0, total: 0, pct: 0 },
		statements: { covered: 0, total: 0, pct: 0 },
		functions: { covered: 0, total: 0, pct: 0 },
		branches: { covered: 0, total: 0, pct: 0 },
	};
	for (const f of files) {
		totals.lines.covered += f.lines.covered;
		totals.lines.total += f.lines.total;
		totals.statements.covered += f.statements.covered;
		totals.statements.total += f.statements.total;
		totals.functions.covered += f.functions.covered;
		totals.functions.total += f.functions.total;
		totals.branches.covered += f.branches.covered;
		totals.branches.total += f.branches.total;
	}
	totals.lines.pct = pct(totals.lines.covered, totals.lines.total);
	totals.statements.pct = pct(
		totals.statements.covered,
		totals.statements.total,
	);
	totals.functions.pct = pct(totals.functions.covered, totals.functions.total);
	totals.branches.pct = pct(totals.branches.covered, totals.branches.total);

	return { files, total: totals };
}
