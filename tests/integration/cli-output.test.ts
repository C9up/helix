/**
 * What a worker prints reaches the user — a test's `console.log`, and a runner
 * teardown that failed (a pool that would not close, a rollback that broke),
 * which also fails the run. Buffered per file, so parallel files do not
 * interleave; `--silent` drops the test output.
 */

import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helix, project, runtimeUrl } from "../__helpers__/cli.js";

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(
		roots.map((root) => rm(root, { recursive: true, force: true })),
	);
});

const printing = [
	`import { expect, test } from "${runtimeUrl}";`,
	'test("prints", () => {',
	'	console.log("STDOUT-FROM-TEST");',
	'	console.error("STDERR-FROM-TEST");',
	"	expect(1).toBe(1);",
	"});",
	"",
].join("\n");

describe("helix test — test output", () => {
	let root: string;

	beforeAll(async () => {
		root = await project({ "tests/out.test.ts": printing });
		roots.push(root);
	});

	it("forwards both streams on the native pool", () => {
		const run = helix(root, ["tests/out.test.ts"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("STDOUT-FROM-TEST");
		expect(run.stderr).toContain("STDERR-FROM-TEST");
	});

	it("forwards both streams on the TypeScript pool", () => {
		const run = helix(root, [
			"tests/out.test.ts",
			"--coverage",
			`--coverage-dir=${root}/cov`,
		]);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("STDOUT-FROM-TEST");
		expect(run.stderr).toContain("STDERR-FROM-TEST");
	});

	it("drops it with --silent", () => {
		const run = helix(root, ["tests/out.test.ts", "--silent"]);
		expect(run.status).toBe(0);
		expect(run.stdout + run.stderr).not.toContain("FROM-TEST");
	});

	it("keeps the json reporter's stdout parseable", () => {
		const run = helix(root, ["tests/out.test.ts", "--reporter=json"]);
		expect(run.status).toBe(0);
		const lines = run.stdout.split("\n").filter((line) => line.length > 0);
		for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
		expect(run.stderr).toContain("STDOUT-FROM-TEST");
	});
});

describe("helix test — a runner teardown that fails", () => {
	let root: string;

	beforeAll(async () => {
		root = await project({
			"tests/bootstrap.ts": [
				`import { configure } from "${runtimeUrl}";`,
				"await configure({",
				"	plugins: [",
				"		(api) => {",
				"			api.cleanup(() => {",
				'				throw new Error("DB pool failed to close");',
				"			});",
				"		},",
				"	],",
				"});",
				"",
			].join("\n"),
			"tests/out.test.ts": printing,
		});
		roots.push(root);
	});

	it("is shown and fails the run on the native pool", () => {
		const run = helix(root, ["tests/out.test.ts"]);
		expect(run.status).toBe(1);
		expect(run.stdout).toContain("DB pool failed to close");
		expect(run.stdout).toContain("1 passed");
	});

	it("is shown and fails the run on the TypeScript pool", () => {
		const run = helix(root, [
			"tests/out.test.ts",
			"--coverage",
			`--coverage-dir=${root}/cov`,
		]);
		expect(run.status).toBe(1);
		expect(run.stdout).toContain("DB pool failed to close");
	});
});
