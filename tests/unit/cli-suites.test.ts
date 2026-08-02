/**
 * Named suites — the AdonisJS `adonisrc.ts` layer that lets `helix test unit`
 * run a suite instead of a path.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type HelixConfig,
	loadHelixConfig,
	resolveSuiteFiles,
	selectSuites,
} from "../../src/cli/suites.js";

const CONFIG: HelixConfig = {
	suites: [
		{ name: "unit", files: ["tests/unit"], timeout: 5000 },
		{ name: "functional", files: ["tests/functional"] },
	],
};

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "helix-suites-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Write `<root>/<relative>`, creating parent directories. */
async function write(relative: string, body = ""): Promise<string> {
	const abs = path.join(root, relative);
	await rm(path.dirname(abs), { recursive: true, force: true }).catch(() => {});
	await import("node:fs/promises").then((fs) =>
		fs.mkdir(path.dirname(abs), { recursive: true }),
	);
	await writeFile(abs, body, "utf8");
	return abs;
}

describe("selectSuites", () => {
	it("returns every suite when no positional is given", () => {
		expect(selectSuites(CONFIG, [])?.map((s) => s.name)).toEqual([
			"unit",
			"functional",
		]);
	});

	it("selects the named suites, in the order asked for", () => {
		expect(selectSuites(CONFIG, ["functional", "unit"])?.map((s) => s.name)) //
			.toEqual(["functional", "unit"]);
	});

	it("falls back to path mode when a positional is not a suite", () => {
		// `tests/unit` is a PATH here, not a suite name — the caller must keep
		// treating positionals as paths rather than silently running nothing.
		expect(selectSuites(CONFIG, ["tests/unit"])).toBeUndefined();
	});

	it("falls back to path mode when suite names and paths are mixed", () => {
		expect(selectSuites(CONFIG, ["unit", "some/path"])).toBeUndefined();
	});

	it("falls back to path mode when no suite is configured", () => {
		expect(selectSuites({}, ["unit"])).toBeUndefined();
	});
});

describe("loadHelixConfig", () => {
	it("returns an empty config when there is no config file", async () => {
		expect(await loadHelixConfig(root)).toEqual({});
	});

	it("reads the suites out of helix.config.mjs", async () => {
		await write(
			"helix.config.mjs",
			'export default { suites: [{ name: "unit", files: ["tests/unit"], timeout: 42 }] }\n',
		);

		const config = await loadHelixConfig(root);

		expect(config.suites).toEqual([
			{ name: "unit", files: ["tests/unit"], timeout: 42, retries: undefined },
		]);
	});

	it("drops malformed suite entries instead of trusting them", async () => {
		await write(
			"helix.config.mjs",
			'export default { suites: [{ name: "ok", files: ["a"] }, { files: ["b"] }, "nope"] }\n',
		);

		const config = await loadHelixConfig(root);

		expect(config.suites?.map((s) => s.name)).toEqual(["ok"]);
	});
});

describe("resolveSuiteFiles", () => {
	it("walks a directory entry", async () => {
		const file = await write("tests/unit/a.test.ts");

		const files = await resolveSuiteFiles(
			{ name: "unit", files: ["tests/unit"] },
			root,
			undefined,
		);

		expect(files).toEqual([file]);
	});

	it("honours the suffix of a `dir/**/*.suffix` entry", async () => {
		await write("tests/unit/a.test.ts");
		const spec = await write("tests/unit/b.spec.ts");

		const files = await resolveSuiteFiles(
			{ name: "unit", files: ["tests/unit/**/*.spec.ts"] },
			root,
			undefined,
		);

		expect(files).toEqual([spec]);
	});

	it("accepts a direct file path", async () => {
		const file = await write("tests/unit/a.test.ts");

		const files = await resolveSuiteFiles(
			{ name: "unit", files: ["tests/unit/a.test.ts"] },
			root,
			undefined,
		);

		expect(files).toEqual([file]);
	});

	it("runs a file listed twice only once", async () => {
		const file = await write("tests/unit/a.test.ts");

		const files = await resolveSuiteFiles(
			{ name: "unit", files: ["tests/unit", "tests/unit/a.test.ts"] },
			root,
			undefined,
		);

		expect(files).toEqual([file]);
	});
});
