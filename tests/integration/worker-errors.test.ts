/**
 * Errors a worker raises outside a test's own assertions — an unhandled
 * rejection while a test runs, a throw or a rejection from a timer once the file
 * has reported, a worker that exits with a status it never announced.
 *
 * Each one must turn the run red, keep the results the file did report, and give
 * the same verdict on both pools: the TypeScript pool (forced here by a reporter
 * instance, as coverage forces it in real runs) and the native one (the default).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type RunConfig, run } from "../../src/cli/run.js";
import { resolveTsxLoader } from "../__helpers__/tsx-loader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../fixtures/orchestrator");
const workerEntry = path.resolve(here, "../../src/runtime/cli-worker.ts");

const tsxLoader = resolveTsxLoader();
const nodeArgs = tsxLoader ? ["--import", tsxLoader] : undefined;

const silent = {
	onFileStart() {},
	onFileResult() {},
	onFileError() {},
	onSummary() {},
};

const pools: ReadonlyArray<[string, Partial<RunConfig>]> = [
	["TypeScript pool", { reporterInstance: silent }],
	["native pool", { reporter: "dot" }],
];

function runFixture(name: string, pool: Partial<RunConfig>) {
	return run({
		root: fixturesDir,
		files: [path.join(fixturesDir, name)],
		threads: 1,
		nodeArgs,
		workerEntry,
		...pool,
	});
}

describe.each(pools)("worker errors — %s", (_label, pool) => {
	it("fails the run on a rejection left unhandled during a test, and keeps the results", async () => {
		const outcome = await runFixture("unhandled-rejection.test.ts", pool);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.summary.totals.fileErrors).toBe(1);
		expect(outcome.summary.fileErrors[0]?.message).toContain("BOOM-floating");
		// Both tests did run: the error is reported beside them, not instead.
		expect(outcome.summary.totals.pass).toBe(2);
	}, 30_000);

	it("fails the run on an exception thrown after the file reported", async () => {
		const outcome = await runFixture("late-throw.test.ts", pool);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.summary.totals.pass).toBe(1);
		expect(
			outcome.summary.fileErrors.map((e) => e.message).join("\n"),
		).toContain("BOOM-late");
	}, 30_000);

	it("fails the run on a rejection raised after the file reported", async () => {
		const outcome = await runFixture("late-reject.test.ts", pool);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.summary.totals.pass).toBe(1);
		expect(
			outcome.summary.fileErrors.map((e) => e.message).join("\n"),
		).toContain("BOOM-late-reject");
	}, 30_000);

	it("fails the run when the worker exits with a status it did not announce", async () => {
		const outcome = await runFixture("exit-after-result.test.ts", pool);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.summary.totals.pass).toBe(1);
		expect(outcome.summary.fileErrors[0]?.message).toMatch(/code 3/);
	}, 30_000);

	it("still passes a clean file with no file error", async () => {
		const outcome = await runFixture("pass.test.ts", pool);
		expect(outcome.exitCode).toBe(0);
		expect(outcome.summary.totals.fileErrors).toBe(0);
		expect(outcome.summary.totals.pass).toBe(2);
	}, 30_000);

	it("keeps the result of a worker it had to kill after the grace", async () => {
		const outcome = await runFixture("lingering.test.ts", {
			...pool,
			exitGraceMs: 200,
		});
		expect(outcome.exitCode).toBe(0);
		expect(outcome.summary.totals.fileErrors).toBe(0);
		expect(outcome.summary.totals.pass).toBe(1);
	}, 30_000);
});
