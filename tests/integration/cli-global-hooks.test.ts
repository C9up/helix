/**
 * Once `runnerHooks.setup` has run — a database migrated, a container started —
 * the teardown has to run on every way out. A suite whose `files` callback
 * throws used to fail after the setup and skip the teardown, leaving all of it
 * behind; the suites are now resolved before anything is set up.
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helix, project, runtimeUrl } from "../__helpers__/cli.js";

let root: string;

beforeAll(async () => {
	const record = (what: string) =>
		`appendFileSync("hooks.log", ${JSON.stringify(`${what}\n`)});`;
	root = await project({
		"helix.config.ts": [
			"export default {",
			"	suites: [",
			'		{ name: "broken", files: () => { throw new Error("files callback failed"); } },',
			"	],",
			"};",
			"",
		].join("\n"),
		"tests/bootstrap.ts": [
			'import { appendFileSync } from "node:fs";',
			"export const runnerHooks = {",
			`	setup: [() => { ${record("setup")} }],`,
			`	teardown: [() => { ${record("teardown")} }],`,
			"};",
			"",
		].join("\n"),
		"tests/a.test.ts": `import { test } from "${runtimeUrl}";\ntest("a", () => {});\n`,
	});
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

async function hooks(): Promise<string[]> {
	try {
		const log = await readFile(path.join(root, "hooks.log"), "utf8");
		return log.trim().split("\n");
	} catch {
		return [];
	}
}

describe("helix test — a suite that cannot resolve its files", () => {
	it("fails before the global setup, so nothing is left to tear down", async () => {
		const run = helix(root, ["broken"]);
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("files callback failed");
		const log = await hooks();
		// Either nothing was set up, or what was set up was torn down.
		if (log.includes("setup")) expect(log).toContain("teardown");
		expect(log).not.toContain("setup");
	});
});
