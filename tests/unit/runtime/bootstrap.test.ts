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
import {
	drainRunnerTeardowns,
	getConfiguredDefaults,
} from "../../../src/runtime/configure.js";
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

	it("tolerates exports of the wrong shape", async () => {
		await bootstrapWith(
			[
				"export const unrelated = 42",
				'export const filters = "nope"',
				"export const importer = 7",
				"export const runnerHooks = { setup: 3 }",
				"",
			].join("\n"),
		);

		await expect(loadBootstrap("default")).resolves.toBeUndefined();
	});

	it("forwards `filters` and `importer` to configure()", async () => {
		await bootstrapWith(
			[
				'export const filters = { tests: ["kept"], matchAll: true, tags: ["@slow"] }',
				"export const importer = (file) => import(file.href)",
				"",
			].join("\n"),
		);

		await loadBootstrap("default");

		const defaults = getConfiguredDefaults();
		expect(defaults.filters).toEqual({
			tests: ["kept"],
			tags: ["@slow"],
			groups: undefined,
			matchAll: true,
		});
		expect(typeof defaults.importer).toBe("function");
	});
});

describe("helix > a conventional bootstrap says so", () => {
	let root: string;
	let stderr: string;
	let restore: () => void;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "helix-convention-"));
		await mkdir(path.join(root, "tests"), { recursive: true });
		await writeFile(path.join(root, "tests/bootstrap.ts"), "export {}\n");
		stderr = "";
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk: string | Uint8Array): boolean => {
			stderr += String(chunk);
			return true;
		};
		restore = () => {
			process.stderr.write = original;
		};
	});

	afterEach(async () => {
		restore();
		await rm(root, { recursive: true, force: true });
	});

	it("warns when a framework rc file could disagree", async () => {
		await writeFile(path.join(root, "reamrc.ts"), "export default {}\n");

		const picked = resolveBootstrap(root);

		expect(picked).toBe(path.resolve(root, "tests/bootstrap.ts"));
		// The trap this exists for: run through the framework's command the
		// declared bootstrap wins, run helix directly this one does, and the
		// two disagreed without a word.
		// Forward slashes on every platform — the path is shown to a human, not
		// handed to the filesystem. Asserting the native separator here is how
		// the same mistake reached CI on Windows once already.
		expect(stderr).toContain("tests/bootstrap.ts");
		expect(stderr).not.toContain("\\");
		expect(stderr).toContain("reamrc.ts");
	});

	it("stays quiet in a project with no rc file to disagree with", async () => {
		const picked = resolveBootstrap(root);

		expect(picked).toBe(path.resolve(root, "tests/bootstrap.ts"));
		// A plain helix project gets the convention and no lecture about it.
		expect(stderr).toBe("");
	});

	it("says nothing when the bootstrap was declared explicitly", async () => {
		await writeFile(path.join(root, "reamrc.ts"), "export default {}\n");
		await writeFile(path.join(root, "tests/other.ts"), "export {}\n");

		expect(resolveBootstrap(root, "tests/other.ts")).toBe(
			path.resolve(root, "tests/other.ts"),
		);
		expect(stderr).toBe("");
	});
});
