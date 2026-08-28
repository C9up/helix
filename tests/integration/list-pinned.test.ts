/**
 * `--list-pinned` — helix collects the files, prints what `.pin()` marked, and
 * runs NOTHING: not the tests, and not the global setup hooks either, since
 * nothing they would open gets used.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBootstrap } from "../../src/runtime/bootstrap.js";
import { resetCLIArgs } from "../../src/runtime/cli-args.js";
import { drainRunnerTeardowns } from "../../src/runtime/configure.js";
import { runTestFile } from "../../src/runtime/worker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = pathToFileURL(
	path.resolve(here, "../../src/runtime/index.ts"),
).href;

let root: string;
const saved = {
	listPinned: process.env.HELIX_LIST_PINNED,
	bootstrap: process.env.HELIX_BOOTSTRAP,
};

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "helix-pinned-"));
	resetBootstrap();
	resetCLIArgs();
});

afterEach(async () => {
	resetBootstrap();
	resetCLIArgs();
	await drainRunnerTeardowns();
	for (const [key, value] of Object.entries(saved)) {
		const name = key === "listPinned" ? "HELIX_LIST_PINNED" : "HELIX_BOOTSTRAP";
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await rm(root, { recursive: true, force: true });
});

/** A spec with one pinned test at the top level and one inside a group. */
async function writeSpec(): Promise<string> {
	const file = path.join(root, "a.test.ts");
	await writeFile(
		file,
		[
			`import { test, describe } from "${runtime}"`,
			`import { appendFileSync } from "node:fs"`,
			`const ran = () => appendFileSync(${JSON.stringify(path.join(root, "ran.log"))}, "x")`,
			`test("plain", () => ran())`,
			`test("pinned top", () => ran()).pin()`,
			`describe("grp", () => {`,
			`  test("pinned nested", () => ran()).pin()`,
			`  test("other", () => ran())`,
			`})`,
			"",
		].join("\n"),
		"utf8",
	);
	return file;
}

describe("--list-pinned", () => {
	it("reports the pinned tests, fully qualified, and runs none of them", async () => {
		const file = await writeSpec();
		process.env.HELIX_LIST_PINNED = "1";
		resetCLIArgs();

		const result = await runTestFile(file);

		expect(result.pinned).toEqual(["pinned top", "grp > pinned nested"]);
		expect(result.tests).toEqual([]);
		expect(result.totals).toEqual({ pass: 0, fail: 0, skip: 0, todo: 0 });
		// Nothing executed — not even the tests that were NOT pinned.
		const { existsSync } = await import("node:fs");
		expect(existsSync(path.join(root, "ran.log"))).toBe(false);
	}, 30_000);

	it("skips the bootstrap's global setup hooks, as helix does", async () => {
		const file = await writeSpec();
		const bootstrap = path.join(root, "bootstrap.ts");
		await writeFile(
			bootstrap,
			[
				`import { appendFileSync } from "node:fs"`,
				"export const runnerHooks = {",
				`  setup: [() => appendFileSync(${JSON.stringify(path.join(root, "setup.log"))}, "x")],`,
				"}",
				"",
			].join("\n"),
			"utf8",
		);
		process.env.HELIX_BOOTSTRAP = bootstrap;
		process.env.HELIX_LIST_PINNED = "1";
		resetCLIArgs();

		await runTestFile(file);

		const { existsSync } = await import("node:fs");
		expect(existsSync(path.join(root, "setup.log"))).toBe(false);
	}, 30_000);

	it("runs everything normally when the flag is absent", async () => {
		const file = await writeSpec();

		const result = await runTestFile(file);

		expect(result.pinned).toBeUndefined();
		// `.pin()` behaves like `.only` during a real run: the pinned two run,
		// the other two are skipped.
		expect(result.totals.pass).toBe(2);
		expect(result.totals.skip).toBe(2);
	}, 30_000);
});
