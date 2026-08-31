/**
 * Named suites — the AdonisJS `adonisrc.ts` layer that lets `helix test unit`
 * run a suite instead of a path.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

/**
 * Write `<root>/<relative>`, creating parent directories.
 *
 * It does NOT clear the parent first: `root` is a fresh temp dir per test, and
 * wiping the directory would delete the sibling a test just wrote — which
 * silently turns "this pattern excludes that file" into "that file was not
 * there", i.e. a test that cannot fail.
 */
async function write(relative: string, body = ""): Promise<string> {
	const abs = path.join(root, relative);
	await mkdir(path.dirname(abs), { recursive: true });
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

	it("reads a config whose settings sit under a `tests` block", async () => {
		// The shape of \`reamrc.ts\` (and \`adonisrc.ts\`). It used to be read as one
		// unknown key and dropped: the declared bootstrap was ignored and the
		// conventional \`tests/bootstrap.ts\` ran in its place, silently.
		await write(
			"helix.config.mjs",
			`export default { tests: { bootstrap: "tests/boot.ts", forceExit: true, suites: [{ name: "app", files: ["tests/app"] }] } }\n`,
		);

		const config = await loadHelixConfig(root);

		expect(config.bootstrap).toBe("tests/boot.ts");
		expect(config.forceExit).toBe(true);
		expect(config.suites?.map((s) => s.name)).toEqual(["app"]);
	});

	it("lets the flat form win over the nested one, so a working config keeps working", async () => {
		await write(
			"helix.config.mjs",
			`export default { bootstrap: "flat.ts", tests: { bootstrap: "nested.ts" } }\n`,
		);

		expect((await loadHelixConfig(root)).bootstrap).toBe("flat.ts");
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

describe("resolveSuiteFiles — helix's three `files` forms", () => {
	it("accepts a bare string, not just an array", async () => {
		const spec = await write("tests/unit/a.spec.ts");
		await write("tests/unit/helper.ts");

		const files = await resolveSuiteFiles(
			{ name: "unit", files: "tests/unit/**/*.spec.ts" },
			root,
			undefined,
		);

		expect(files).toEqual([spec]);
	});

	it("accepts a callback returning URLs", async () => {
		// A callback picks the files itself, so it reaches what suffix-based
		// discovery never would.
		const picked = await write("custom/picked.ts");

		const files = await resolveSuiteFiles(
			{ name: "custom", files: () => [pathToFileURL(picked)] },
			root,
			undefined,
		);

		expect(files).toEqual([picked]);
	});

	it("awaits an async callback and ignores what is not a URL", async () => {
		const picked = await write("custom/picked.ts");

		const files = await resolveSuiteFiles(
			{
				name: "custom",
				files: async () => [pathToFileURL(picked), pathToFileURL(picked)],
			},
			root,
			undefined,
		);

		// Deduplicated, like every other entry form.
		expect(files).toEqual([picked]);
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

describe("helix > a framework rc file answers when helix has no config", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "helix-rc-"));
		await mkdir(path.join(root, "tests/http"), { recursive: true });
		await writeFile(path.join(root, "tests/bootstrap.ts"), "export {}\n");
		await writeFile(path.join(root, "tests/http/bootstrap.ts"), "export {}\n");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("reads the bootstrap declared under the rc file's tests block", async () => {
		await writeFile(
			path.join(root, "reamrc.ts"),
			"export default { tests: { bootstrap: 'tests/http/bootstrap.ts' } }\n",
		);

		// The reported failure: the declared bootstrap was ignored and the
		// conventional tests/bootstrap.ts ran instead — one that starts the
		// application, inside a unit suite that touches no database.
		expect((await loadHelixConfig(root)).bootstrap).toBe(
			"tests/http/bootstrap.ts",
		);
	});

	it("lets helix.config.* win when both are present", async () => {
		await writeFile(
			path.join(root, "reamrc.ts"),
			"export default { tests: { bootstrap: 'tests/http/bootstrap.ts' } }\n",
		);
		await writeFile(
			path.join(root, "helix.config.ts"),
			"export default { bootstrap: 'tests/bootstrap.ts' }\n",
		);

		expect((await loadHelixConfig(root)).bootstrap).toBe("tests/bootstrap.ts");
	});

	it("answers nothing when neither file exists", async () => {
		expect(await loadHelixConfig(root)).toEqual({});
	});
});
