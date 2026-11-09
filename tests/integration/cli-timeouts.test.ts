/**
 * Where a test's timeout comes from under `helix test`, highest first:
 * `--timeout`, a suite's own `timeout`, what `configure({ timeout })` or a
 * plugin set, the config file's `timeout`, then the runtime default.
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

const sleeper = (ms: number) =>
	[
		`import { expect, test } from "${runtimeUrl}";`,
		`test("sleeps ${ms}ms", async () => {`,
		`	await new Promise((resolve) => setTimeout(resolve, ${ms}));`,
		"	expect(1).toBe(1);",
		"});",
		"",
	].join("\n");

describe("helix test — a plugin's timeout", () => {
	let root: string;

	beforeAll(async () => {
		root = await project({
			"tests/bootstrap.ts": [
				`import { configure } from "${runtimeUrl}";`,
				"await configure({ plugins: [(api) => { api.config.timeout = 100; }] });",
				"",
			].join("\n"),
			"tests/slow.test.ts": sleeper(600),
		});
		roots.push(root);
	});

	it("applies on the native pool", () => {
		const run = helix(root, ["tests/slow.test.ts"]);
		expect(run.status).toBe(1);
		expect(run.stdout).toContain("exceeded 100ms timeout");
	});

	it("applies on the TypeScript pool", () => {
		const run = helix(root, [
			"tests/slow.test.ts",
			"--coverage",
			`--coverage-dir=${root}/cov`,
		]);
		expect(run.status).toBe(1);
	});

	it("loses to --timeout", () => {
		const run = helix(root, ["tests/slow.test.ts", "--timeout=5000"]);
		expect(run.status).toBe(0);
	});
});

describe("helix test — a suite's timeout", () => {
	let root: string;

	beforeAll(async () => {
		root = await project({
			"helix.config.ts": [
				"export default {",
				"	timeout: 300,",
				'	suites: [{ name: "functional", files: ["tests/functional"], timeout: 30000 }],',
				"};",
				"",
			].join("\n"),
			"tests/functional/slow.test.ts": sleeper(1000),
		});
		roots.push(root);
	});

	it("beats the config's run-wide timeout", () => {
		const run = helix(root, ["functional"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("1 passed");
	});

	it("loses to --timeout", () => {
		const run = helix(root, ["functional", "--timeout=300"]);
		expect(run.status).toBe(1);
		expect(run.stdout).toContain("exceeded 300ms timeout");
	});
});
