import type { FileResult } from "../runtime/run.js";
import type { WorkerErrorMessage } from "./pool.js";

export interface Totals {
	pass: number;
	fail: number;
	skip: number;
	todo: number;
	fileErrors: number;
}

export interface Summary {
	totals: Totals;
	files: FileResult[];
	fileErrors: WorkerErrorMessage[];
	durationMs: number;
}

export function buildSummary(
	files: FileResult[],
	fileErrors: WorkerErrorMessage[],
	durationMs: number,
): Summary {
	const totals: Totals = {
		pass: 0,
		fail: 0,
		skip: 0,
		todo: 0,
		fileErrors: fileErrors.length,
	};
	for (const f of files) {
		totals.pass += f.totals.pass;
		totals.fail += f.totals.fail;
		totals.skip += f.totals.skip;
		totals.todo += f.totals.todo;
	}
	return { totals, files, fileErrors, durationMs };
}

export function exitCode(summary: Summary): number {
	return summary.totals.fail > 0 || summary.totals.fileErrors > 0 ? 1 : 0;
}
