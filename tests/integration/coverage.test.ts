import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../fixtures/orchestrator");
const workerEntry = path.resolve(here, "../../src/runtime/cli-worker.ts");

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

// Package root (where `package.json` lives) — used as the coverage root
// so include patterns like `src/runtime/**/*.ts` resolve relative to it.
const pkgRoot = path.resolve(here, "../..");

const silent = {
	onFileStart() {},
	onFileResult() {},
	onFileError() {},
	onSummary() {},
};

describe("coverage — V8 collection + reporters + thresholds", () => {
	const outputs: string[] = [];
	afterEach(() => {
		for (const dir of outputs) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		outputs.length = 0;
	});

	it("produces a non-empty lcov.info when --coverage is on", async () => {
		const outDir = path.join(fixturesDir, ".coverage-test-1");
		outputs.push(outDir);
		const outcome = await run({
			root: fixturesDir,
			files: [path.join(fixturesDir, "pass.test.ts")],
			threads: 1,
			nodeArgs,
			workerEntry,
			reporterInstance: silent,
			coverage: {
				enabled: true,
				reporters: ["lcov", "json-summary"],
				outputDir: outDir,
				// Cover the runtime sources reached by the fixture's `import`.
				include: ["src/runtime/**/*.ts"],
				root: pkgRoot,
			},
		});
		expect(outcome.coverage).toBeDefined();
		const lcovPath = path.join(outDir, "lcov.info");
		expect(existsSync(lcovPath)).toBe(true);
		const lcov = readFileSync(lcovPath, "utf8");
		// At least one SF: + DA: line for files we actually exercised.
		expect(lcov).toMatch(/^SF:.+\.(ts|js)$/m);
		expect(lcov).toMatch(/^DA:\d+,\d+$/m);
	}, 30_000);

	it("aggregates coverage across multiple workers running multiple files", async () => {
		const outDir = path.join(fixturesDir, ".coverage-test-2");
		outputs.push(outDir);
		const outcome = await run({
			root: fixturesDir,
			files: [
				path.join(fixturesDir, "pass.test.ts"),
				path.join(fixturesDir, "fail.test.ts"),
			],
			threads: 2,
			nodeArgs,
			workerEntry,
			reporterInstance: silent,
			coverage: {
				enabled: true,
				reporters: ["json-summary"],
				outputDir: outDir,
				include: ["src/runtime/**/*.ts"],
				root: pkgRoot,
			},
		});
		expect(outcome.coverage).toBeDefined();
		const summaryPath = path.join(outDir, "coverage-summary.json");
		expect(existsSync(summaryPath)).toBe(true);
		const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
		expect(summary.total).toBeDefined();
		expect(summary.total.lines.total).toBeGreaterThan(0);
	}, 30_000);

	it("threshold violation flips exitCode to 1", async () => {
		const outDir = path.join(fixturesDir, ".coverage-test-3");
		outputs.push(outDir);
		const outcome = await run({
			root: fixturesDir,
			files: [path.join(fixturesDir, "pass.test.ts")],
			threads: 1,
			nodeArgs,
			workerEntry,
			reporterInstance: silent,
			coverage: {
				enabled: true,
				reporters: ["json-summary"],
				outputDir: outDir,
				include: ["src/runtime/**/*.ts"],
				root: pkgRoot,
				// Threshold of 100% on functions/lines — pass.test.ts won't
				// exercise every function in the runtime, guaranteeing a violation.
				thresholds: { lines: 100, functions: 100 },
			},
		});
		expect(outcome.coverageViolations?.length).toBeGreaterThan(0);
		expect(outcome.exitCode).toBe(1);
	}, 30_000);

	it("excludes default exclusions (node_modules, tests/**)", async () => {
		const outDir = path.join(fixturesDir, ".coverage-test-4");
		outputs.push(outDir);
		await run({
			root: fixturesDir,
			files: [path.join(fixturesDir, "pass.test.ts")],
			threads: 1,
			nodeArgs,
			workerEntry,
			reporterInstance: silent,
			coverage: {
				enabled: true,
				reporters: ["json-summary"],
				outputDir: outDir,
				root: pkgRoot,
				// No `include` override — defaults apply (src/**).
			},
		});
		const summary = JSON.parse(
			readFileSync(path.join(outDir, "coverage-summary.json"), "utf8"),
		);
		// No file from node_modules or test fixtures should appear.
		const fileKeys = Object.keys(summary).filter((k) => k !== "total");
		for (const f of fileKeys) {
			expect(f).not.toMatch(/node_modules/);
			expect(f).not.toMatch(/\.test\.ts$/);
		}
	}, 30_000);
});
