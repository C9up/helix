import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discover } from "../../src/cli/discover.js";
import { run } from "../../src/cli/run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../fixtures/orchestrator");
const workerEntry = path.resolve(here, "../../src/runtime/cli-worker.ts");

/**
 * Resolve the `tsx` ESM loader from the workspace virtual store. pnpm's
 * isolated-modules layout means `node --import tsx` fails unless we pass
 * the full path, and the version suffix (`tsx@X.Y.Z`) changes on upgrades
 * — so we scan instead of hard-coding.
 */
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

// Silent reporter for tests (swallow stdout noise).
const silent = {
	onFileStart() {},
	onFileResult() {},
	onFileError() {},
	onSummary() {},
};

describe("orchestrator — discovery", () => {
	it("finds all fixture files", async () => {
		const files = await discover(fixturesDir);
		const names = files.map((f) => path.basename(f)).sort();
		expect(names).toContain("pass.test.ts");
		expect(names).toContain("fail.test.ts");
		expect(names).toContain("hang.test.ts");
	});

	it("skips non-test files", async () => {
		const files = await discover(fixturesDir);
		expect(files.every((f) => /\.(test|spec)\.ts$/.test(f))).toBe(true);
	});
});

describe("orchestrator — end-to-end", () => {
	it("aggregates results across pass + fail fixtures in parallel", async () => {
		const outcome = await run({
			root: fixturesDir,
			files: [
				path.join(fixturesDir, "pass.test.ts"),
				path.join(fixturesDir, "fail.test.ts"),
			],
			threads: 2,
			timeoutMs: 15_000,
			nodeArgs,
			workerEntry,
			reporterInstance: silent,
		});
		expect(outcome.summary.totals.pass).toBe(3); // 2 from pass.test.ts + 1 from fail.test.ts
		expect(outcome.summary.totals.fail).toBe(1);
		expect(outcome.exitCode).toBe(1);
	}, 30_000);

	it("hung test is marked as a file error (timeout)", async () => {
		const outcome = await run({
			root: fixturesDir,
			files: [path.join(fixturesDir, "hang.test.ts")],
			threads: 1,
			timeoutMs: 500, // force an early timeout
			nodeArgs,
			workerEntry,
			reporterInstance: silent,
		});
		// The worker's inner timeout fires first (surfacing as a test fail).
		// If the outer watchdog wins, it's a file error. Either outcome proves
		// the hang was contained — that's what we care about.
		const contained =
			outcome.summary.totals.fail > 0 || outcome.summary.totals.fileErrors > 0;
		expect(contained).toBe(true);
		expect(outcome.exitCode).toBe(1);
	}, 30_000);

	it("exit code is 0 when every test passes", async () => {
		const outcome = await run({
			root: fixturesDir,
			files: [path.join(fixturesDir, "pass.test.ts")],
			threads: 1,
			nodeArgs,
			workerEntry,
			reporterInstance: silent,
		});
		expect(outcome.summary.totals.fail).toBe(0);
		expect(outcome.summary.totals.fileErrors).toBe(0);
		expect(outcome.exitCode).toBe(0);
	}, 30_000);

	it("syntax-error fixture surfaces as a file error (AC 9)", async () => {
		const outcome = await run({
			root: fixturesDir,
			files: [path.join(fixturesDir, "syntax-error.test.ts")],
			threads: 1,
			nodeArgs,
			workerEntry,
			reporterInstance: silent,
		});
		expect(outcome.summary.totals.fileErrors).toBe(1);
		expect(outcome.exitCode).toBe(1);
	}, 30_000);

	it("nonce protects the frame parser from fixture spoofing", async () => {
		const outcome = await run({
			root: fixturesDir,
			files: [path.join(fixturesDir, "spoofer.test.ts")],
			threads: 1,
			nodeArgs,
			workerEntry,
			reporterInstance: silent,
		});
		// Fake frame claimed 999 passes — nonce check must reject it, real
		// test genuinely fails, so totals reflect reality.
		expect(outcome.summary.totals.pass).toBe(0);
		expect(outcome.summary.totals.fail).toBe(1);
	}, 30_000);

	it("pre-handshake errors surface as file errors (via magic nonce)", async () => {
		// Spawn the worker with malformed instruction JSON on stdin.
		// The worker can't know the nonce yet, so it emits with the
		// pre-handshake magic — the pool must still report this error
		// instead of dropping the frame.
		const { spawn } = await import("node:child_process");
		const child = spawn(process.execPath, [...(nodeArgs ?? []), workerEntry], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => {
			stderr += c;
		});
		child.stdin.write("not valid json\n");
		child.stdin.end();
		await new Promise<void>((resolve) => {
			child.on("exit", () => resolve());
		});
		expect(stderr).toContain("__HELIX_RESULT__");
		expect(stderr).toContain("__helix_pre_handshake__");
		expect(stderr).toMatch(/malformed instruction JSON/);
	}, 30_000);
});
