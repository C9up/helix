/**
 * Where a test's retries come from under `helix test`, highest first:
 * `--retries`, then the suite's own `retries`. An explicit flag beats what the
 * suite declares, as `--timeout` beats a suite's timeout and as the ream
 * bridge's `ream test --retries` does, so one command line means the same
 * thing through either entry point.
 */

import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helix, project, runtimeUrl } from "../__helpers__/cli.js";

let root: string;

/** Fails its first attempt and passes the next, within one worker. */
const flaky = [
	`import { test } from "${runtimeUrl}";`,
	"let attempts = 0;",
	'test("fails once", () => {',
	"	attempts += 1;",
	'	if (attempts === 1) throw new Error("first attempt");',
	"});",
	"",
].join("\n");

beforeAll(async () => {
	root = await project({
		"helix.config.ts": [
			"export default {",
			"	suites: [",
			'		{ name: "strict", files: ["tests/strict"], retries: 0 },',
			'		{ name: "lenient", files: ["tests/lenient"], retries: 1 },',
			"	],",
			"};",
			"",
		].join("\n"),
		"tests/strict/flaky.test.ts": flaky,
		"tests/lenient/flaky.test.ts": flaky,
	});
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("helix test — retries", () => {
	it("applies the suite's own count when no flag is given", () => {
		expect(helix(root, ["strict"]).status).toBe(1);
		expect(helix(root, ["lenient"]).status).toBe(0);
	});

	it("lets --retries beat a suite that declares fewer", () => {
		expect(helix(root, ["strict", "--retries=1"]).status).toBe(0);
	});

	it("lets --retries=0 beat a suite that declares more", () => {
		expect(helix(root, ["lenient", "--retries=0"]).status).toBe(1);
	});

	it("refuses a negative count instead of reading it as none", () => {
		const run = helix(root, ["lenient", "--retries=-1"]);
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain(
			'flag --retries expects a non-negative finite number, got "-1"',
		);
	});
});
