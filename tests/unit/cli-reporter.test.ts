import { describe, expect, it } from "vitest";
import {
	DotReporter,
	JsonReporter,
	makeReporter,
	type Reporter,
	SpecReporter,
} from "../../src/cli/reporter.js";
import type { Summary } from "../../src/cli/summary.js";
import type { FileResult } from "../../src/runtime/run.js";

interface CapturedSink {
	write(chunk: string): void;
	writeLine(chunk: string): void;
	output: string;
}

function makeSink(): CapturedSink {
	const sink: CapturedSink = {
		output: "",
		write(chunk) {
			sink.output += chunk;
		},
		writeLine(chunk) {
			sink.output += `${chunk}\n`;
		},
	};
	return sink;
}

const passResult = (file = "a.test.ts"): FileResult => ({
	file,
	tests: [
		{ fullName: "passes", status: "pass", durationMs: 1 },
		{ fullName: "skipped", status: "skip", durationMs: 0 },
	],
	durationMs: 1,
});

const failResult = (): FileResult => ({
	file: "b.test.ts",
	tests: [
		{
			fullName: "boom",
			status: "fail",
			durationMs: 2,
			error: {
				message: "expected 1 to be 2",
				actual: 1,
				expected: 2,
			},
		},
	],
	durationMs: 2,
});

const summary: Summary = {
	totals: { pass: 1, fail: 1, skip: 0, todo: 0, fileErrors: 0 },
	durationMs: 42,
} as Summary;

describe("helix > cli > reporter > DotReporter", () => {
	it("writes one char per test status", () => {
		const sink = makeSink();
		const r = new DotReporter(sink);
		r.onFileResult(passResult());
		expect(sink.output).toBe(".-");
	});

	it("writes 'F' for failures and 'E' for file errors", () => {
		const sink = makeSink();
		const r = new DotReporter(sink);
		r.onFileResult(failResult());
		r.onFileError({ type: "error", file: "x", message: "crashed" });
		expect(sink.output).toBe("FE");
	});

	it("emits a summary line on onSummary()", () => {
		const sink = makeSink();
		const r = new DotReporter(sink);
		r.onSummary(summary);
		expect(sink.output).toContain("1 passed");
		expect(sink.output).toContain("1 failed");
		expect(sink.output).toContain("42 ms");
	});

	it("onFileStart is a silent no-op (no spurious output)", () => {
		const sink = makeSink();
		new DotReporter(sink).onFileStart("a.test.ts");
		expect(sink.output).toBe("");
	});
});

describe("helix > cli > reporter > SpecReporter", () => {
	it("prints the file path on start and a tree on result", () => {
		const sink = makeSink();
		const r = new SpecReporter(sink, false); // useColors=false → plain text
		r.onFileStart("a.test.ts");
		r.onFileResult(passResult());
		expect(sink.output).toContain("▶ a.test.ts");
		expect(sink.output).toContain("✔ passes");
		expect(sink.output).toContain("○ skipped");
	});

	it("prints the error message AND actual/expected diff on failures", () => {
		const sink = makeSink();
		const r = new SpecReporter(sink, false);
		r.onFileResult(failResult());
		expect(sink.output).toContain("✘ boom");
		expect(sink.output).toContain("expected 1 to be 2");
		expect(sink.output).toContain("actual:");
		expect(sink.output).toContain("expected:");
	});

	it("emits ANSI escape codes when useColors=true", () => {
		const sink = makeSink();
		const r = new SpecReporter(sink, true);
		r.onFileResult(passResult());
		expect(sink.output).toContain("\x1b[32m"); // green
	});

	it("falls back to '<unknown>' for file errors with no file field", () => {
		const sink = makeSink();
		const r = new SpecReporter(sink, false);
		r.onFileError({ type: "error", message: "no file" });
		expect(sink.output).toContain("<unknown>");
		expect(sink.output).toContain("no file");
	});
});

describe("helix > cli > reporter > JsonReporter", () => {
	it("emits one NDJSON line per lifecycle event", () => {
		const sink = makeSink();
		const r = new JsonReporter(sink);
		r.onFileStart("a.test.ts");
		r.onFileResult(passResult());
		r.onFileError({ type: "error", file: "b", message: "boom" });
		r.onSummary(summary);

		const lines = sink.output.trim().split("\n");
		expect(lines).toHaveLength(4);
		expect(JSON.parse(lines[0])).toMatchObject({ event: "file:start" });
		expect(JSON.parse(lines[1])).toMatchObject({ event: "file:end" });
		expect(JSON.parse(lines[2])).toMatchObject({ event: "file:error" });
		expect(JSON.parse(lines[3])).toMatchObject({ event: "summary" });
	});
});

describe("helix > cli > reporter > makeReporter factory", () => {
	function classNameOf(r: Reporter): string {
		return (r as { constructor: { name: string } }).constructor.name;
	}

	it("name='dot' returns a DotReporter", () => {
		expect(classNameOf(makeReporter("dot", true))).toBe("DotReporter");
	});

	it("name='json' returns a JsonReporter", () => {
		expect(classNameOf(makeReporter("json", true))).toBe("JsonReporter");
	});

	it("name='spec' / undefined / unknown all return SpecReporter", () => {
		expect(classNameOf(makeReporter("spec", true))).toBe("SpecReporter");
		expect(classNameOf(makeReporter(undefined, true))).toBe("SpecReporter");
		expect(classNameOf(makeReporter("doesnotexist", true))).toBe(
			"SpecReporter",
		);
	});

	it("name lookup is case-insensitive", () => {
		expect(classNameOf(makeReporter("DOT", true))).toBe("DotReporter");
		expect(classNameOf(makeReporter("Json", true))).toBe("JsonReporter");
	});
});
