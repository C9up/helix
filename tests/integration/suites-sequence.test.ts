/**
 * `runSuites` — the sequencer behind `helix test unit functional`.
 *
 * Three things only this level can get right, and each was broken before it
 * existed: every suite runs (watch mode used to settle on the first suite's
 * watcher and never reach the second), the suite name reaches the workers,
 * and the `--failed` cache ends up holding EVERY suite's failures instead of
 * just the last one's.
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailedCache } from "../../src/cli/failed-cache.js";
import { type RunConfig, runSuites, type SuiteRun } from "../../src/cli/run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerEntry = path.resolve(here, "../../src/runtime/cli-worker.ts");

/** Same virtual-store scan as the other integration tests. */
function resolveTsxLoader(): string | undefined {
	const workspaceRoot = path.resolve(here, "../../../..");
	const store = path.join(workspaceRoot, "node_modules/.pnpm");
	if (!existsSync(store)) return undefined;
	const entry = readdirSync(store).find((name) => name.startsWith("tsx@"));
	if (!entry) return undefined;
	const candidate = path.join(store, entry, "node_modules/tsx/dist/loader.mjs");
	return existsSync(candidate) ? `file://${candidate}` : undefined;
}

const tsxLoader = resolveTsxLoader();
const nodeArgs = tsxLoader ? ["--import", tsxLoader] : undefined;

const silent = {
	onFileStart() {},
	onFileResult() {},
	onFileError() {},
	onSummary() {},
};

let root: string;
const savedSuite = process.env.HELIX_SUITE;

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "helix-suites-"));
	await mkdir(path.join(root, "unit"), { recursive: true });
	await mkdir(path.join(root, "func"), { recursive: true });
	// Each file asserts the suite name IT should have been run under, so a
	// leaked or missing `HELIX_SUITE` shows up as a failing test, not silence.
	await writeFile(
		path.join(root, "unit/a.test.ts"),
		[
			`import { test } from "${runtimeSpecifier()}"`,
			`test("unit green", () => { if (process.env.HELIX_SUITE !== "unit") throw new Error("suite=" + process.env.HELIX_SUITE) })`,
			`test("unit red", () => { throw new Error("boom-unit") })`,
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		path.join(root, "func/b.test.ts"),
		[
			`import { test } from "${runtimeSpecifier()}"`,
			`test("func green", () => { if (process.env.HELIX_SUITE !== "func") throw new Error("suite=" + process.env.HELIX_SUITE) })`,
			`test("func red", () => { throw new Error("boom-func") })`,
			"",
		].join("\n"),
		"utf8",
	);
});

afterEach(async () => {
	if (savedSuite === undefined) delete process.env.HELIX_SUITE;
	else process.env.HELIX_SUITE = savedSuite;
	await rm(root, { recursive: true, force: true });
});

/** The fixtures live in a temp dir, so they import the runtime by URL. */
function runtimeSpecifier(): string {
	return pathToFileURL(path.resolve(here, "../../src/runtime/index.ts")).href;
}

function baseConfig(): RunConfig {
	return {
		root,
		threads: 2,
		timeoutMs: 20_000,
		nodeArgs,
		workerEntry,
		reporterInstance: silent,
	};
}

function steps(): SuiteRun[] {
	return [
		{
			env: { HELIX_SUITE: "unit", HELIX_RETRIES: "" },
			config: { ...baseConfig(), files: [path.join(root, "unit/a.test.ts")] },
		},
		{
			env: { HELIX_SUITE: "func", HELIX_RETRIES: "" },
			config: { ...baseConfig(), files: [path.join(root, "func/b.test.ts")] },
		},
	];
}

describe("runSuites", () => {
	it("runs every suite and merges their summaries", async () => {
		const outcome = await runSuites(steps(), baseConfig());

		expect(outcome.summary.totals.pass).toBe(2);
		expect(outcome.summary.totals.fail).toBe(2);
		expect(outcome.summary.files).toHaveLength(2);
		expect(outcome.exitCode).toBe(1);
	}, 60_000);

	it("caches the failures of every suite, not just the last", async () => {
		await runSuites(steps(), baseConfig());

		expect((await readFailedCache(root)).sort()).toEqual([
			"func red",
			"unit red",
		]);
	}, 60_000);

	it("stops after the failing suite under bail", async () => {
		const outcome = await runSuites(steps(), { ...baseConfig(), bail: true });

		expect(outcome.summary.files).toHaveLength(1);
		expect(outcome.exitCode).toBe(1);
	}, 60_000);

	it("watch mode runs the whole sequence, not only the first suite", async () => {
		// A watcher per suite would settle only on Ctrl-C, so the second suite
		// would never start. Abort once the initial pass has had time to run:
		// the loop awaits the in-flight pass before resolving, so the outcome
		// we get back is that complete pass.
		const controller = new AbortController();
		const pending = runSuites(steps(), {
			...baseConfig(),
			watch: { enabled: true, debounceMs: 50, signal: controller.signal },
		});
		setTimeout(() => controller.abort(), 500);
		const outcome = await pending;

		expect(outcome.summary.files).toHaveLength(2);
	}, 60_000);
});
