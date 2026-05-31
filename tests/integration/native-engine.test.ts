import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../../src/cli/run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../fixtures/orchestrator");
const workerEntry = path.resolve(here, "../../src/runtime/cli-worker.ts");

// Mirror orchestrator.test.ts's tsx loader resolution (workspace virtual store).
function resolveTsxLoader(): string | undefined {
	const workspaceRoot = path.resolve(here, "../../../..");
	const store = path.join(workspaceRoot, "node_modules/.pnpm");
	if (!existsSync(store)) return undefined;
	const entry = readdirSync(store).find((name) => name.startsWith("tsx@"));
	if (entry === undefined) return undefined;
	const candidate = path.join(store, entry, "node_modules/tsx/dist/loader.mjs");
	return existsSync(candidate) ? `file://${candidate}` : undefined;
}

const tsxLoader = resolveTsxLoader();
const nodeArgs = tsxLoader ? ["--import", tsxLoader] : undefined;

describe("native engine (ream-test-napi) — plain-path cutover", () => {
	it("delegates to the Rust engine when no TS-only layer is active", async () => {
		// No reporterInstance / coverage / diff-cov / watch → run() routes through
		// the native NAPI `run`. Requires `pnpm --filter @c9up/helix build:napi`.
		const outcome = await run({
			root: fixturesDir,
			files: [path.join(fixturesDir, "pass.test.ts")],
			threads: 1,
			timeoutMs: 15_000,
			reporter: "dot",
			nodeArgs,
			workerEntry,
		});
		expect(outcome.summary.totals.pass).toBe(2);
		expect(outcome.summary.totals.fail).toBe(0);
		expect(outcome.summary.totals.fileErrors).toBe(0);
		expect(outcome.exitCode).toBe(0);
	}, 30_000);

	it("reports a non-zero exit when a fixture fails (Rust engine)", async () => {
		const outcome = await run({
			root: fixturesDir,
			files: [path.join(fixturesDir, "fail.test.ts")],
			threads: 1,
			timeoutMs: 15_000,
			reporter: "dot",
			nodeArgs,
			workerEntry,
		});
		expect(outcome.summary.totals.fail).toBeGreaterThan(0);
		expect(outcome.exitCode).toBe(1);
	}, 30_000);
});
