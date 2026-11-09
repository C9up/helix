/**
 * `helix test` runs in the `test` environment from its first statement: the
 * config file, the bootstrap and its `runnerHooks.setup` (migrations, seeds)
 * all run in the CLI process, before any worker — and a setup resolving the
 * shell's `development` connection would migrate the wrong database.
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helix, project, runtimeUrl } from "../__helpers__/cli.js";

let root: string;

beforeAll(async () => {
	const record = (where: string) =>
		`appendFileSync(${JSON.stringify("env.log")}, ${JSON.stringify(where)} + "=" + process.env.NODE_ENV + "\\n");`;
	root = await project({
		"helix.config.ts": [
			'import { appendFileSync } from "node:fs";',
			record("config"),
			"export default {};",
			"",
		].join("\n"),
		"tests/bootstrap.ts": [
			'import { appendFileSync } from "node:fs";',
			record("bootstrap"),
			"export const runnerHooks = {",
			`	setup: [() => { ${record("setup")} }],`,
			`	teardown: [() => { ${record("teardown")} }],`,
			"};",
			"",
		].join("\n"),
		"tests/a.test.ts": [
			`import { expect, test } from "${runtimeUrl}";`,
			'test("runs", () => { expect(process.env.NODE_ENV).toBe("test"); });',
			"",
		].join("\n"),
	});
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("helix test — NODE_ENV", () => {
	it("is test for the config, the bootstrap and the global hooks", async () => {
		const run = helix(root, ["tests/a.test.ts"], { NODE_ENV: "development" });
		expect(run.status).toBe(0);
		const log = await readFile(path.join(root, "env.log"), "utf8");
		const lines = log.trim().split("\n");
		expect(lines).toContain("config=test");
		expect(lines).toContain("setup=test");
		expect(lines).toContain("teardown=test");
		expect(lines.filter((line) => !line.endsWith("=test"))).toEqual([]);
	});
});
