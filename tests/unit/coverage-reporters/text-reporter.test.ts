/**
 * Unit suite for the text coverage reporter — covers fmtPct edge cases,
 * padRight's left-elide behaviour, and the rendered summary structure.
 */
import { describe, expect, it } from "vitest";
import { textSummary } from "../../../src/cli/coverage/reporters/text.js";
import type {
	CoverageSummary,
	FileSummary,
	Totals,
} from "../../../src/cli/coverage/types.js";

function fileSummary(
	file: string,
	linesCovered: number,
	linesTotal: number,
	fnCovered: number,
	fnTotal: number,
): FileSummary {
	return {
		file,
		lines: { covered: linesCovered, total: linesTotal },
		functions: { covered: fnCovered, total: fnTotal },
		statements: { covered: linesCovered, total: linesTotal },
		branches: { covered: 0, total: 0 },
		lineHits: [],
		functionHits: [],
	};
}

function totals(linesPct: number, fnPct: number): Totals {
	return {
		lines: { covered: 0, total: 0, pct: linesPct },
		functions: { covered: 0, total: 0, pct: fnPct },
		statements: { covered: 0, total: 0, pct: linesPct },
		branches: { covered: 0, total: 0, pct: 0 },
	};
}

describe("helix > coverage > textSummary > structure", () => {
	it("renders a header, separator, and footer total row", () => {
		const summary: CoverageSummary = {
			files: [fileSummary("/root/a.ts", 5, 10, 1, 2)],
			total: totals(50, 50),
		};
		const out = textSummary(summary, "/root");
		expect(out).toContain("── Coverage ──");
		expect(out).toContain("File");
		expect(out).toContain("Lines");
		expect(out).toContain("Funcs");
		expect(out).toContain("All files");
		expect(out.endsWith("\n")).toBe(true);
	});

	it("renders a row per file with paths made relative to root", () => {
		const summary: CoverageSummary = {
			files: [
				fileSummary("/root/src/a.ts", 4, 4, 1, 1),
				fileSummary("/root/src/b.ts", 0, 2, 0, 1),
			],
			total: totals(66.66, 50),
		};
		const out = textSummary(summary, "/root");
		expect(out).toContain("src/a.ts");
		expect(out).toContain("src/b.ts");
		// Should NOT include the root prefix in per-file rows.
		expect(out).not.toContain("/root/src/a.ts");
	});

	it("keeps absolute path when the file is outside root", () => {
		const summary: CoverageSummary = {
			files: [fileSummary("/elsewhere/x.ts", 1, 1, 1, 1)],
			total: totals(100, 100),
		};
		const out = textSummary(summary, "/root");
		expect(out).toContain("/elsewhere/x.ts");
	});

	it("renders no per-file rows when files is empty (totals only)", () => {
		const summary: CoverageSummary = {
			files: [],
			total: totals(0, 0),
		};
		const out = textSummary(summary, "/root");
		// Header + separator + total separator + total — but no .ts entries.
		expect(out).not.toMatch(/\.ts/);
		expect(out).toContain("All files");
	});
});

describe("helix > coverage > textSummary > percentage formatting", () => {
	it("formats 100% coverage when total>0 and covered==total", () => {
		const summary: CoverageSummary = {
			files: [fileSummary("/root/a.ts", 5, 5, 2, 2)],
			total: totals(100, 100),
		};
		const out = textSummary(summary, "/root");
		expect(out).toContain("100.00%");
	});

	it("treats total==0 as 100% (no code = fully covered)", () => {
		const summary: CoverageSummary = {
			files: [fileSummary("/root/empty.ts", 0, 0, 0, 0)],
			total: totals(100, 100),
		};
		const out = textSummary(summary, "/root");
		// Both lines and functions should print as 100.00% even with no
		// statements/functions in the file.
		expect(out.match(/100\.00%/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
	});

	it("formats a fractional percentage with 2 decimals", () => {
		const summary: CoverageSummary = {
			files: [fileSummary("/root/a.ts", 1, 3, 1, 3)],
			total: totals(33.33, 33.33),
		};
		const out = textSummary(summary, "/root");
		expect(out).toContain("33.33%");
	});

	it("right-aligns percentages within a 6-char field", () => {
		const summary: CoverageSummary = {
			files: [fileSummary("/root/a.ts", 0, 100, 0, 100)],
			total: totals(0, 0),
		};
		const out = textSummary(summary, "/root");
		// 0.00 padded to width 6 → "  0.00%"
		expect(out).toContain("  0.00%");
	});
});

describe("helix > coverage > textSummary > padRight + left-elide", () => {
	it("pads short paths with spaces on the right", () => {
		const summary: CoverageSummary = {
			files: [fileSummary("/root/x.ts", 1, 1, 1, 1)],
			total: totals(100, 100),
		};
		const out = textSummary(summary, "/root");
		const fileRow = out.split("\n").find((l) => l.includes("x.ts"));
		expect(fileRow).toBeDefined();
		// 50-char file column + 2 spaces + 8-char lines + 2 spaces + 8-char funcs.
		// We just check the file column is at least 50 chars wide.
		expect(fileRow?.indexOf("%")).toBeGreaterThan(50);
	});

	it("elides from the LEFT with an ellipsis when the path overflows", () => {
		const longSegment = "a".repeat(20);
		const longPath = `/root/${longSegment}/${longSegment}/${longSegment}/tail.ts`;
		const summary: CoverageSummary = {
			files: [fileSummary(longPath, 1, 1, 1, 1)],
			total: totals(100, 100),
		};
		const out = textSummary(summary, "/root");
		const fileRow = out.split("\n").find((l) => l.includes("tail.ts"));
		expect(fileRow).toBeDefined();
		expect(fileRow).toContain("…");
		// Tail should survive the elide — left side is the part dropped.
		expect(fileRow).toContain("tail.ts");
	});
});
