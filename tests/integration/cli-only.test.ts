/**
 * A `.only` left in a commit. Locally it narrows the run, which is what it is
 * for; under CI it would skip the rest of the file and turn the build green, so
 * there it fails instead — unless `--allow-only` (or `allowOnly` in the config)
 * says otherwise.
 */

import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helix, project, runtimeUrl } from "../__helpers__/cli.js";

let root: string;

beforeAll(async () => {
	root = await project({
		"tests/only.test.ts": [
			`import { expect, test } from "${runtimeUrl}";`,
			`test.only("only one", () => { expect(1).toBe(1); });`,
			`test("would fail", () => { expect(1).toBe(2); });`,
			"",
		].join("\n"),
	});
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("helix test — .only under CI", () => {
	it("fails the run under CI", () => {
		const run = helix(root, ["tests/only.test.ts"], { CI: "true" });
		expect(run.status).toBe(1);
		expect(run.stdout).toContain("Unexpected .only modifier");
	});

	it("fails it on the TypeScript pool too", () => {
		const run = helix(
			root,
			["tests/only.test.ts", "--coverage", `--coverage-dir=${root}/cov`],
			{ CI: "true" },
		);
		expect(run.status).toBe(1);
	});

	it("narrows the run outside CI", () => {
		const run = helix(root, ["tests/only.test.ts"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("1 passed");
		expect(run.stdout).toContain("1 skipped");
	});

	it("narrows the run under CI when --allow-only says so", () => {
		const run = helix(root, ["tests/only.test.ts", "--allow-only"], {
			CI: "true",
		});
		expect(run.status).toBe(0);
	});

	it("fails outside CI when --allow-only=false says so", () => {
		const run = helix(root, ["tests/only.test.ts", "--allow-only=false"]);
		expect(run.status).toBe(1);
	});
});
