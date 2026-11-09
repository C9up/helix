/**
 * What `helix test` runs, and what it says when that is nothing.
 *
 * A run that executes no test is not a pass: an empty project, a glob with a
 * typo, a selection that matches nothing, a file that declares no test — each
 * used to exit 0, which in CI reads as green with nothing checked.
 * `--pass-with-no-tests` (or `passWithNoTests` in the config) opts back in.
 */

import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helix, project, runtimeUrl } from "../__helpers__/cli.js";

const roots: string[] = [];

async function make(files: Readonly<Record<string, string>>): Promise<string> {
	const root = await project(files);
	roots.push(root);
	return root;
}

afterAll(async () => {
	await Promise.all(
		roots.map((root) => rm(root, { recursive: true, force: true })),
	);
});

const passing = [
	`import { expect, test } from "${runtimeUrl}";`,
	`test("a passes", () => { expect(1).toBe(1); });`,
	"",
].join("\n");

const failing = [
	`import { expect, test } from "${runtimeUrl}";`,
	`test("b fails", () => { expect(1).toBe(2); });`,
	"",
].join("\n");

describe("helix test — nothing to run", () => {
	let empty: string;
	let emptyFile: string;

	beforeAll(async () => {
		empty = await make({ "README.md": "no tests here\n" });
		emptyFile = await make({
			"tests/empty.test.ts": `import "${runtimeUrl}";\nexport {};\n`,
		});
	});

	it("fails a run that finds no test file", () => {
		const run = helix(empty, []);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain("No test files found, exiting with code 1");
	});

	it("passes it with --pass-with-no-tests", () => {
		const run = helix(empty, ["--pass-with-no-tests"]);
		expect(run.status).toBe(0);
		expect(run.stdout + run.stderr).toContain(
			"No test files found, exiting with code 0",
		);
	});

	it("fails a file that declares no test", () => {
		const run = helix(emptyFile, ["tests/empty.test.ts"]);
		expect(run.status).toBe(1);
		expect(run.stdout).toContain("No test suite found in file");
	});

	it("fails it on the TypeScript pool too", () => {
		const run = helix(emptyFile, [
			"tests/empty.test.ts",
			"--coverage",
			`--coverage-dir=${emptyFile}/cov`,
		]);
		expect(run.status).toBe(1);
	});

	it("passes an empty file with --pass-with-no-tests", () => {
		const run = helix(emptyFile, [
			"tests/empty.test.ts",
			"--pass-with-no-tests",
		]);
		expect(run.status).toBe(0);
	});

	it("fails a named suite whose files match nothing", async () => {
		const root = await make({
			"helix.config.ts": `export default { suites: [{ name: "functional", files: ["tests/functional/**/*.test.ts"] }] };\n`,
		});
		const run = helix(root, ["functional"]);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain('suite "functional": no test files');
	});
});

describe("helix test — a selection narrows, never widens", () => {
	let root: string;

	beforeAll(async () => {
		root = await make({
			"tests/a.test.ts": passing,
			"tests/b.test.ts": failing,
		});
	});

	it("applies --files to discovery when no path is given", () => {
		const run = helix(root, ["--files=a"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("a.test.ts");
		expect(run.stdout).not.toContain("b.test.ts");
	});

	it("fails a --files filter that matches nothing instead of running everything", () => {
		const run = helix(root, ["tests", "--files=nomatch"]);
		expect(run.status).toBe(1);
		expect(run.stdout).not.toContain("a.test.ts");
		expect(run.stderr).toContain("No test files found");
		expect(run.stderr).toContain("nomatch");
	});

	it("fails a path that does not exist instead of running everything", () => {
		const run = helix(root, ["tests/typo.test.ts"]);
		expect(run.status).toBe(1);
		expect(run.stdout).not.toContain("a.test.ts");
		expect(run.stderr).toContain("path not found: tests/typo.test.ts");
	});

	it("still discovers everything when nothing is selected", () => {
		const run = helix(root, []);
		expect(run.status).toBe(1);
		expect(run.stdout).toContain("a.test.ts");
		expect(run.stdout).toContain("b.test.ts");
	});
});
