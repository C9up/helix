/**
 * Reporters — receive lifecycle callbacks as each file completes, write
 * incremental output to the given sink. Three built-ins matching the
 * Rust-side reporter trait:
 *   - Dot: one char per test
 *   - Spec: nested tree with colours + diff lines on failure
 *   - Json: NDJSON to stdout, machine-readable
 */

import type { FileResult } from "../runtime/run.js";
import type { WorkerErrorMessage } from "./pool.js";
import type { Summary } from "./summary.js";

export interface Reporter {
	onFileStart(file: string): void;
	onFileResult(result: FileResult): void;
	onFileError(error: WorkerErrorMessage): void;
	onSummary(summary: Summary): void;
}

type Sink = {
	write(chunk: string): void;
	writeLine(chunk: string): void;
};

export function stdoutSink(): Sink {
	return {
		write(chunk: string): void {
			process.stdout.write(chunk);
		},
		writeLine(chunk: string): void {
			process.stdout.write(`${chunk}\n`);
		},
	};
}

const ANSI = {
	dim: (s: string, on: boolean): string => (on ? `\x1b[90m${s}\x1b[0m` : s),
	red: (s: string, on: boolean): string => (on ? `\x1b[31m${s}\x1b[0m` : s),
	green: (s: string, on: boolean): string => (on ? `\x1b[32m${s}\x1b[0m` : s),
	yellow: (s: string, on: boolean): string => (on ? `\x1b[33m${s}\x1b[0m` : s),
};

export class DotReporter implements Reporter {
	constructor(private readonly sink: Sink = stdoutSink()) {}
	onFileStart(_file: string): void {}
	onFileResult(result: FileResult): void {
		for (const t of result.tests) {
			const c =
				t.status === "pass"
					? "."
					: t.status === "fail"
						? "F"
						: t.status === "skip"
							? "-"
							: "*";
			this.sink.write(c);
		}
	}
	onFileError(_error: WorkerErrorMessage): void {
		this.sink.write("E");
	}
	onSummary(summary: Summary): void {
		this.sink.writeLine("");
		printSummary(this.sink, summary);
	}
}

export class SpecReporter implements Reporter {
	constructor(
		private readonly sink: Sink = stdoutSink(),
		private readonly useColors = true,
	) {}
	onFileStart(file: string): void {
		this.sink.writeLine(
			`${ANSI.dim("▶", this.useColors)} ${ANSI.dim(file, this.useColors)}`,
		);
	}
	onFileResult(result: FileResult): void {
		for (const t of result.tests) {
			const marker =
				t.status === "pass"
					? ANSI.green("✔", this.useColors)
					: t.status === "fail"
						? ANSI.red("✘", this.useColors)
						: t.status === "skip"
							? ANSI.yellow("○", this.useColors)
							: ANSI.dim("☐", this.useColors);
			this.sink.writeLine(`  ${marker} ${t.fullName}`);
			if (t.error) {
				this.sink.writeLine(
					`      ${ANSI.red(t.error.message, this.useColors)}`,
				);
				if (t.error.actual !== undefined && t.error.expected !== undefined) {
					this.sink.writeLine(
						`      ${ANSI.dim("actual:  ", this.useColors)} ${JSON.stringify(t.error.actual)}`,
					);
					this.sink.writeLine(
						`      ${ANSI.dim("expected:", this.useColors)} ${JSON.stringify(t.error.expected)}`,
					);
				}
			}
		}
	}
	onFileError(error: WorkerErrorMessage): void {
		const file = error.file ?? "<unknown>";
		this.sink.writeLine(
			`${ANSI.red("✘", this.useColors)} ${file}: ${error.message}`,
		);
	}
	onSummary(summary: Summary): void {
		this.sink.writeLine("");
		printSummary(this.sink, summary);
	}
}

export class JsonReporter implements Reporter {
	constructor(private readonly sink: Sink = stdoutSink()) {}
	onFileStart(file: string): void {
		this.sink.writeLine(JSON.stringify({ event: "file:start", file }));
	}
	onFileResult(result: FileResult): void {
		this.sink.writeLine(JSON.stringify({ event: "file:end", result }));
	}
	onFileError(error: WorkerErrorMessage): void {
		this.sink.writeLine(JSON.stringify({ event: "file:error", error }));
	}
	onSummary(summary: Summary): void {
		this.sink.writeLine(JSON.stringify({ event: "summary", summary }));
	}
}

function printSummary(sink: Sink, summary: Summary): void {
	const t = summary.totals;
	sink.writeLine("──────────────────────────────────────");
	sink.writeLine(
		`  ${t.pass} passed | ${t.fail} failed | ${t.skip} skipped | ${t.todo} todo | ${t.fileErrors} file errors`,
	);
	sink.writeLine(`  ${summary.durationMs} ms`);
}

/** Factory from a CLI-style name. */
export function makeReporter(
	name: string | undefined,
	useColors: boolean,
): Reporter {
	switch ((name ?? "spec").toLowerCase()) {
		case "dot":
			return new DotReporter();
		case "json":
			return new JsonReporter();
		default:
			return new SpecReporter(stdoutSink(), useColors);
	}
}
