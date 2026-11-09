/**
 * Which deadline is which. The per-test timeout bounds one test; the per-file
 * deadline is a separate, much larger safety net for a worker stuck where no
 * test timeout reaches. The same number used to serve as both, so a file of
 * fast tests was killed for taking longer in total than one test may.
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

function runFixture(name: string, config: Partial<RunConfig>) {
	return run({
		root: fixturesDir,
		files: [path.join(fixturesDir, name)],
		threads: 1,
		nodeArgs,
		workerEntry,
		...config,
	});
}

describe.each(pools)("timeouts — %s", (_label, pool) => {
	it("keeps a file of fast tests whose total exceeds one test's timeout", async () => {
		const outcome = await runFixture("many-fast.test.ts", {
			...pool,
			timeoutMs: 400,
		});
		expect(outcome.summary.totals.fileErrors).toBe(0);
		expect(outcome.summary.totals.pass).toBe(25);
		expect(outcome.exitCode).toBe(0);
	}, 60_000);

	it("fails a slow test as a test, not the file", async () => {
		const outcome = await runFixture("slow.test.ts", {
			...pool,
			timeoutMs: 200,
		});
		expect(outcome.summary.totals.fileErrors).toBe(0);
		expect(outcome.summary.totals.fail).toBe(1);
		expect(outcome.summary.totals.pass).toBe(1);
		const failed = outcome.summary.files[0]?.tests.find(
			(t) => t.status === "fail",
		);
		expect(failed?.error?.message).toMatch(/exceeded 200ms timeout/);
	}, 30_000);

	it("still kills a worker stuck past the per-file deadline", async () => {
		const outcome = await runFixture("busy-loop.test.ts", {
			...pool,
			fileTimeoutMs: 1_500,
		});
		expect(outcome.exitCode).toBe(1);
		expect(outcome.summary.totals.fileErrors).toBe(1);
		expect(outcome.summary.fileErrors[0]?.message).toMatch(/1500ms/);
	}, 30_000);
});
