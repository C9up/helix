import { execSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { overlay } from "../../src/cli/coverage/diff/overlay.js";
import { parseDiffString } from "../../src/cli/coverage/diff/parse.js";
import type { CoverageSummary } from "../../src/cli/coverage/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

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

describe("diff coverage — parser", () => {
	it("extracts added line numbers per file", () => {
		const diff = `diff --git a/src/a.ts b/src/a.ts
index 0000000..1111111 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,0 +11,3 @@
+line eleven
+line twelve
+line thirteen
diff --git a/src/b.ts b/src/b.ts
index 2222222..3333333 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1,2 @@
-old
+new1
+new2
`;
		const map = parseDiffString(diff, "/repo");
		expect(map.size).toBe(2);
		expect(Array.from(map.get("/repo/src/a.ts") ?? []).sort()).toEqual([
			11, 12, 13,
		]);
		expect(Array.from(map.get("/repo/src/b.ts") ?? []).sort()).toEqual([1, 2]);
	});

	it("skips deleted files and binary entries", () => {
		const diff = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index aaa..bbb
--- a/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-l1
-l2
-l3
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;
		const map = parseDiffString(diff, "/repo");
		expect(map.size).toBe(0);
	});

	it("renamed file picked up at the new path", () => {
		const diff = `diff --git a/old.ts b/new.ts
similarity index 80%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -5,0 +6 @@
+added line at six
`;
		const map = parseDiffString(diff, "/repo");
		expect(map.size).toBe(1);
		expect(Array.from(map.get("/repo/new.ts") ?? [])).toEqual([6]);
	});

	it("handles CRLF line endings without corrupting line numbers", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"index 0000000..1111111 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -10,0 +11,2 @@",
			"+line eleven",
			"+line twelve",
			"",
		].join("\r\n");
		const map = parseDiffString(diff, "/repo");
		expect(map.size).toBe(1);
		expect(Array.from(map.get("/repo/src/a.ts") ?? []).sort()).toEqual([
			11, 12,
		]);
	});

	it("ignores stray + lines in deletion-only hunks (nextAddedLine guard)", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,3 +0,0 @@",
			"-removed",
			"-removed",
			"-removed",
			"",
		].join("\n");
		const map = parseDiffString(diff, "/repo");
		expect(map.size).toBe(0);
	});
});

describe("diff coverage — overlay", () => {
	it("intersects diff lines with coverage hits", () => {
		const summary: CoverageSummary = {
			files: [
				{
					file: "/repo/src/a.ts",
					lines: { covered: 2, total: 3 },
					statements: { covered: 2, total: 3 },
					functions: { covered: 0, total: 0 },
					branches: { covered: 0, total: 0 },
					lineHits: [
						{ line: 11, count: 5 },
						{ line: 12, count: 0 },
						{ line: 13, count: 1 },
					],
					functionHits: [],
				},
			],
			total: {
				lines: { covered: 2, total: 3, pct: 66.67 },
				statements: { covered: 2, total: 3, pct: 66.67 },
				functions: { covered: 0, total: 0, pct: 100 },
				branches: { covered: 0, total: 0, pct: 100 },
			},
		};
		const diffMap = new Map([["/repo/src/a.ts", new Set([11, 12, 13])]]);
		const result = overlay(summary, diffMap);
		expect(result.files).toHaveLength(1);
		expect(result.files[0].added).toBe(3);
		expect(result.files[0].covered).toBe(2);
		expect(result.total.pct).toBeCloseTo(66.67, 1);
	});

	it("excludes non-executable added lines (absent from coverage) from the denominator", () => {
		const summary: CoverageSummary = {
			files: [
				{
					file: "/repo/src/a.ts",
					lines: { covered: 1, total: 2 },
					statements: { covered: 1, total: 2 },
					functions: { covered: 0, total: 0 },
					branches: { covered: 0, total: 0 },
					lineHits: [
						{ line: 10, count: 3 }, // executable, covered
						{ line: 12, count: 0 }, // executable, uncovered
					],
					functionHits: [],
				},
			],
			total: {
				lines: { covered: 1, total: 2, pct: 50 },
				statements: { covered: 1, total: 2, pct: 50 },
				functions: { covered: 0, total: 0, pct: 100 },
				branches: { covered: 0, total: 0, pct: 100 },
			},
		};
		// Added 11 & 13 are comment/blank — absent from coverage. They must NOT
		// count: added=2 (10,12), covered=1 → 50%, not 25% (audit 2026-06-13).
		const diffMap = new Map([["/repo/src/a.ts", new Set([10, 11, 12, 13])]]);
		const result = overlay(summary, diffMap);
		expect(result.files[0].added).toBe(2);
		expect(result.files[0].covered).toBe(1);
		expect(result.total.pct).toBeCloseTo(50, 1);
	});

	it("file in diff but absent from coverage shows 0 covered", () => {
		const summary: CoverageSummary = {
			files: [],
			total: {
				lines: { covered: 0, total: 0, pct: 100 },
				statements: { covered: 0, total: 0, pct: 100 },
				functions: { covered: 0, total: 0, pct: 100 },
				branches: { covered: 0, total: 0, pct: 100 },
			},
		};
		const diffMap = new Map([["/repo/new.ts", new Set([1, 2, 3])]]);
		const result = overlay(summary, diffMap);
		expect(result.total.added).toBe(3);
		expect(result.total.covered).toBe(0);
	});
});

describe("diff coverage — config validation", () => {
	it("rejects unsupported functions/branches diff thresholds", async () => {
		const { finaliseDiff } = await import(
			"../../src/cli/coverage/diff/index.js"
		);
		const empty: CoverageSummary = {
			files: [],
			total: {
				lines: { covered: 0, total: 0, pct: 100 },
				statements: { covered: 0, total: 0, pct: 100 },
				functions: { covered: 0, total: 0, pct: 100 },
				branches: { covered: 0, total: 0, pct: 100 },
			},
		};
		await expect(
			finaliseDiff({
				enabled: true,
				root: "/tmp",
				coverage: empty,
				thresholds: { functions: 80 },
			}),
		).rejects.toThrow(/functions.*not supported/);
	});

	it("rejects diffCoverage.cwd when it's fully disjoint from coverage.root", async () => {
		const { run } = await import("../../src/cli/run.js");
		const tmp = mkdtempSync(path.join(os.tmpdir(), "helix-cwd-bad-"));
		const otherRoot = mkdtempSync(path.join(os.tmpdir(), "helix-other-"));
		try {
			await expect(
				run({
					root: tmp,
					files: [],
					threads: 1,
					reporterInstance: {
						onFileStart() {},
						onFileResult() {},
						onFileError() {},
						onSummary() {},
					},
					coverage: {
						enabled: true,
						reporters: [],
						outputDir: path.join(tmp, "coverage"),
						root: tmp,
					},
					diffCoverage: { enabled: true, cwd: otherRoot },
				}),
			).rejects.toThrow(/disjoint paths/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
			rmSync(otherRoot, { recursive: true, force: true });
		}
	});

	it("accepts diffCoverage.cwd as an ancestor of coverage.root (monorepo case)", async () => {
		const { run } = await import("../../src/cli/run.js");
		// Mirror a monorepo layout: cwd = git root, coverage.root =
		// nested sub-package. The previous "must be inside coverage.root"
		// rule rejected this legitimate shape and made diff-cov unusable
		// from any package other than the repo root.
		const gitRoot = mkdtempSync(path.join(os.tmpdir(), "helix-git-root-"));
		const subPkg = path.join(gitRoot, "packages", "sub");
		mkdirSync(subPkg, { recursive: true });
		try {
			// `run` gets past the diff/cov pair-check and proceeds normally.
			// `files: []` keeps the pool empty and run() resolves cleanly
			// without throwing the disjoint-paths error — the contract
			// under test is that this shape is no longer rejected upfront.
			await expect(
				run({
					root: subPkg,
					files: [],
					threads: 1,
					reporterInstance: {
						onFileStart() {},
						onFileResult() {},
						onFileError() {},
						onSummary() {},
					},
					coverage: {
						enabled: true,
						reporters: [],
						outputDir: path.join(subPkg, "coverage"),
						root: subPkg,
					},
					diffCoverage: { enabled: true, cwd: gitRoot },
				}),
			).resolves.toBeDefined();
		} finally {
			rmSync(gitRoot, { recursive: true, force: true });
		}
	});
});

describe("diff coverage — end-to-end with synthetic git repo", () => {
	const cleanups: string[] = [];
	afterEach(() => {
		for (const dir of cleanups) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		cleanups.length = 0;
	});

	function gitInit(repoDir: string): void {
		execSync("git init -q -b main", { cwd: repoDir });
		execSync('git config user.email "t@t.com"', { cwd: repoDir });
		execSync('git config user.name "t"', { cwd: repoDir });
		execSync("git config commit.gpgsign false", { cwd: repoDir });
	}

	it("not in a git repo → warning, no failure", async () => {
		const { run } = await import("../../src/cli/run.js");
		const tmp = mkdtempSync(path.join(os.tmpdir(), "helix-no-git-"));
		cleanups.push(tmp);
		// Fixture imports from the helix runtime via absolute path so the
		// test file lives outside the helix tree (forcing a non-git cwd
		// for diff-cov resolution).
		const runtimeIndex = path.resolve(here, "../../src/runtime/index.ts");
		mkdirSync(path.join(tmp, "tests"));
		writeFileSync(
			path.join(tmp, "tests/empty.test.ts"),
			`import { test } from "${runtimeIndex}";\ntest("noop", () => {});\n`,
		);
		const outcome = await run({
			root: tmp,
			files: [path.join(tmp, "tests/empty.test.ts")],
			threads: 1,
			nodeArgs: tsxLoader ? ["--import", tsxLoader] : undefined,
			workerEntry: path.resolve(here, "../../src/runtime/cli-worker.ts"),
			reporterInstance: {
				onFileStart() {},
				onFileResult() {},
				onFileError() {},
				onSummary() {},
			},
			coverage: {
				enabled: true,
				reporters: ["json-summary"],
				outputDir: path.join(tmp, "coverage"),
				root: tmp,
			},
			// `cwd: tmp` forces the diff resolver to look in the synthetic
			// dir (which has no .git), exercising the "no git" fallback.
			diffCoverage: { enabled: true, cwd: tmp },
		});
		expect(outcome.diffCoverage).toBeUndefined();
		// Test passed (no fail) AND no full-tree threshold so exit must be 0.
		expect(outcome.exitCode).toBe(0);
	}, 30_000);

	it("synthetic repo: diff-cov computes added-line coverage", async () => {
		const { run } = await import("../../src/cli/run.js");
		const tmp = mkdtempSync(path.join(os.tmpdir(), "helix-diff-cov-"));
		cleanups.push(tmp);

		// Init repo with a baseline file on `main`.
		gitInit(tmp);
		mkdirSync(path.join(tmp, "src"));
		writeFileSync(
			path.join(tmp, "src/lib.ts"),
			"export function add(a: number, b: number): number {\n  return a + b;\n}\n",
		);
		execSync("git add -A && git commit -q -m baseline", { cwd: tmp });

		// Branch + add a new function so the diff has 3 added lines.
		execSync("git checkout -q -b feature", { cwd: tmp });
		writeFileSync(
			path.join(tmp, "src/lib.ts"),
			[
				"export function add(a: number, b: number): number {",
				"  return a + b;",
				"}",
				"export function sub(a: number, b: number): number {",
				"  return a - b;",
				"}",
				"",
			].join("\n"),
		);
		execSync('git add -A && git commit -q -m "add sub"', { cwd: tmp });

		// Test file that imports lib.ts and exercises only `add`.
		const runtimeIndex = path.resolve(here, "../../src/runtime/index.ts");
		mkdirSync(path.join(tmp, "tests"));
		writeFileSync(
			path.join(tmp, "tests/lib.test.ts"),
			[
				`import { test, expect } from "${runtimeIndex}";`,
				`import { add } from "${path.join(tmp, "src/lib.ts")}";`,
				`test("add covers only add", () => { expect(add(1, 2)).toBe(3); });`,
				"",
			].join("\n"),
		);

		const outcome = await run({
			root: tmp,
			files: [path.join(tmp, "tests/lib.test.ts")],
			threads: 1,
			nodeArgs: tsxLoader ? ["--import", tsxLoader] : undefined,
			workerEntry: path.resolve(here, "../../src/runtime/cli-worker.ts"),
			reporterInstance: {
				onFileStart() {},
				onFileResult() {},
				onFileError() {},
				onSummary() {},
			},
			coverage: {
				enabled: true,
				reporters: ["json-summary"],
				outputDir: path.join(tmp, "coverage"),
				root: tmp,
				include: ["src/**/*.ts"],
			},
			diffCoverage: {
				enabled: true,
				base: "main",
				cwd: tmp,
			},
		});

		expect(outcome.diffCoverage).toBeDefined();
		// The diff registered some added lines (the new `sub` function).
		expect(outcome.diffCoverage?.total.added).toBeGreaterThanOrEqual(1);
		// `coverage-diff.json` was written.
		const diffJsonPath = path.join(tmp, "coverage/coverage-diff.json");
		expect(existsSync(diffJsonPath)).toBe(true);
		const json = JSON.parse(readFileSync(diffJsonPath, "utf8"));
		expect(json.total).toBeDefined();
	}, 60_000);

	it("diff threshold violation flips exitCode to 1", async () => {
		const { run } = await import("../../src/cli/run.js");
		const tmp = mkdtempSync(path.join(os.tmpdir(), "helix-diff-thr-"));
		cleanups.push(tmp);
		gitInit(tmp);
		mkdirSync(path.join(tmp, "src"));
		writeFileSync(path.join(tmp, "src/lib.ts"), "export const v = 1;\n");
		execSync("git add -A && git commit -q -m baseline", { cwd: tmp });
		execSync("git checkout -q -b feature", { cwd: tmp });
		writeFileSync(
			path.join(tmp, "src/lib.ts"),
			"export const v = 1;\nexport const w = 2;\n",
		);
		execSync('git add -A && git commit -q -m "add w"', { cwd: tmp });
		const runtimeIndex = path.resolve(here, "../../src/runtime/index.ts");
		mkdirSync(path.join(tmp, "tests"));
		writeFileSync(
			path.join(tmp, "tests/empty.test.ts"),
			`import { test } from "${runtimeIndex}";\ntest("noop", () => {});\n`,
		);
		const outcome = await run({
			root: tmp,
			files: [path.join(tmp, "tests/empty.test.ts")],
			threads: 1,
			nodeArgs: tsxLoader ? ["--import", tsxLoader] : undefined,
			workerEntry: path.resolve(here, "../../src/runtime/cli-worker.ts"),
			reporterInstance: {
				onFileStart() {},
				onFileResult() {},
				onFileError() {},
				onSummary() {},
			},
			coverage: {
				enabled: true,
				reporters: ["json-summary"],
				outputDir: path.join(tmp, "coverage"),
				root: tmp,
				include: ["src/**/*.ts"],
			},
			diffCoverage: {
				enabled: true,
				base: "main",
				cwd: tmp,
				thresholds: { lines: 100 },
			},
		});
		expect(outcome.diffCoverageViolations?.length).toBeGreaterThan(0);
		expect(outcome.exitCode).toBe(1);
	}, 60_000);
});

// Reference suppress so tsc/biome don't complain about unused.
void spawnSync;
