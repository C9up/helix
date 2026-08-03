/**
 * `tests/bootstrap.ts` — the AdonisJS bootstrap module, as helix reads it.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadBootstrap,
	resetBootstrap,
	resolveBootstrap,
} from "../../../src/runtime/bootstrap.js";
import { drainRunnerTeardowns } from "../../../src/runtime/configure.js";
import { TestContextRegistry } from "../../../src/runtime/context.js";

let root: string;
const savedBootstrap = process.env.HELIX_BOOTSTRAP;

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "helix-bootstrap-"));
	await mkdir(path.join(root, "tests"), { recursive: true });
	resetBootstrap();
});

afterEach(async () => {
	resetBootstrap();
	TestContextRegistry.clear();
	await drainRunnerTeardowns();
	if (savedBootstrap === undefined) delete process.env.HELIX_BOOTSTRAP;
	else process.env.HELIX_BOOTSTRAP = savedBootstrap;
	await rm(root, { recursive: true, force: true });
});

/** Write a bootstrap module and point the worker env at it. */
async function bootstrapWith(body: string): Promise<string> {
	const file = path.join(root, "tests/bootstrap.ts");
	await writeFile(file, body, "utf8");
	process.env.HELIX_BOOTSTRAP = file;
	return file;
}

describe("resolveBootstrap", () => {
	it("finds the conventional tests/bootstrap.ts", async () => {
		const file = path.join(root, "tests/bootstrap.ts");
		await writeFile(file, "export const plugins = []\n", "utf8");

		expect(resolveBootstrap(root)).toBe(file);
	});

	it("honours a configured path, relative to the root", async () => {
		await mkdir(path.join(root, "custom"), { recursive: true });
		const file = path.join(root, "custom/boot.ts");
		await writeFile(file, "export const plugins = []\n", "utf8");

		expect(resolveBootstrap(root, "custom/boot.ts")).toBe(file);
	});

	it("is undefined when the project has none", () => {
		expect(resolveBootstrap(root)).toBeUndefined();
		expect(resolveBootstrap(root, "custom/absent.ts")).toBeUndefined();
	});
});

describe("loadBootstrap", () => {
	it("does nothing when no bootstrap was resolved", async () => {
		process.env.HELIX_BOOTSTRAP = "";
		await expect(loadBootstrap("default")).resolves.toBeUndefined();
	});

	it("installs the module's plugins", async () => {
		await bootstrapWith(
			[
				"export const plugins = [",
				'  ({ context }) => { context.macro("greeting", "hello") },',
				"]",
				"",
			].join("\n"),
		);

		await loadBootstrap("default");

		expect(TestContextRegistry.has("greeting")).toBe(true);
	});

	it("runs runnerHooks.setup and defers runnerHooks.teardown", async () => {
		const log = path.join(root, "hooks.json");
		await bootstrapWith(
			[
				'import { appendFileSync } from "node:fs"',
				"export const runnerHooks = {",
				`  setup: [() => appendFileSync(${JSON.stringify(log)}, "setup\\n")],`,
				`  teardown: [() => appendFileSync(${JSON.stringify(log)}, "teardown\\n")],`,
				"}",
				"",
			].join("\n"),
		);

		await loadBootstrap("default");
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(log, "utf8")).toBe("setup\n");

		await drainRunnerTeardowns();
		expect(readFileSync(log, "utf8")).toBe("setup\nteardown\n");
	});

	it("hands configureSuite the running suite, and its hooks are honoured", async () => {
		const log = path.join(root, "suite.json");
		await bootstrapWith(
			[
				'import { appendFileSync } from "node:fs"',
				"export const configureSuite = (suite) => {",
				`  appendFileSync(${JSON.stringify(log)}, "name=" + suite.name + "\\n")`,
				'  if (suite.name === "functional") {',
				`    suite.setup(() => appendFileSync(${JSON.stringify(log)}, "functional-setup\\n"))`,
				"  }",
				"}",
				"",
			].join("\n"),
		);

		await loadBootstrap("functional");

		const { readFileSync } = await import("node:fs");
		expect(readFileSync(log, "utf8")).toBe(
			"name=functional\nfunctional-setup\n",
		);
	});

	it("loads once per process even when several files run", async () => {
		const log = path.join(root, "count.json");
		await bootstrapWith(
			[
				'import { appendFileSync } from "node:fs"',
				`appendFileSync(${JSON.stringify(log)}, "imported\\n")`,
				"export const plugins = []",
				"",
			].join("\n"),
		);

		await loadBootstrap("default");
		await loadBootstrap("default");

		const { readFileSync } = await import("node:fs");
		expect(readFileSync(log, "utf8")).toBe("imported\n");
	});

	it("tolerates a module exporting nothing helix knows about", async () => {
		await bootstrapWith("export const unrelated = 42\n");

		await expect(loadBootstrap("default")).resolves.toBeUndefined();
	});
});
