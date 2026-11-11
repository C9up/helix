/**
 * `filter` keeps a coverage report inside the project. `collect` reads every
 * script a worker loaded — dependencies, the package store, anything a test
 * imported — and the report written under `coverage.dir` must not name or
 * measure a file that does not live under `root`, whatever path led to it: a
 * symlink inside `src/` pointing elsewhere, a `..` path, an absolute one.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filter } from "../../src/cli/coverage/filter.js";
import type { RawFileCoverage } from "../../src/cli/coverage/types.js";

let root: string;
let elsewhere: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "helix-filter-root-"));
	elsewhere = await mkdtemp(path.join(os.tmpdir(), "helix-filter-out-"));
	await mkdir(path.join(root, "src"));
	await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
	await writeFile(path.join(elsewhere, "b.ts"), "export const b = 2;\n");
	// `src/out` looks like project source and resolves outside the project.
	await symlink(elsewhere, path.join(root, "src", "out"), "dir");
	await symlink(
		path.join(elsewhere, "b.ts"),
		path.join(root, "src", "linked.ts"),
		"file",
	);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(elsewhere, { recursive: true, force: true });
});

const entry = (file: string): RawFileCoverage => ({
	file,
	source: "",
	functions: [],
});

describe("coverage filter > root confinement", () => {
	it("keeps only the file that really lives under root", () => {
		const kept = filter(
			[
				entry(path.join(root, "src", "a.ts")),
				entry(path.join(root, "src", "out", "b.ts")),
				entry(path.join(root, "src", "linked.ts")),
				entry(
					path.join(root, "src", "..", "..", path.basename(elsewhere), "b.ts"),
				),
				entry(path.join(elsewhere, "b.ts")),
				entry("/etc/hosts"),
			],
			{ root, include: ["**/*"], exclude: [] },
		);
		expect(kept.map((e) => path.relative(root, e.file))).toEqual([
			path.join("src", "a.ts"),
		]);
	});

	it("drops the root itself, which is no source file", () => {
		expect(
			filter([entry(root)], { root, include: ["**"], exclude: [] }),
		).toEqual([]);
	});

	it("cannot be widened by an absolute include glob", () => {
		const kept = filter(
			[entry("/etc/hosts"), entry(path.join(elsewhere, "b.ts"))],
			{
				root,
				include: ["/etc/**", `${elsewhere}/**`, "**/*"],
				exclude: [],
			},
		);
		expect(kept).toEqual([]);
	});

	it("compares against the resolved root, so a symlinked root keeps its files", async () => {
		const alias = path.join(elsewhere, "alias");
		await symlink(root, alias, "dir");
		const kept = filter([entry(path.join(root, "src", "a.ts"))], {
			root: alias,
			include: ["src/**/*.ts"],
			exclude: [],
		});
		expect(kept).toHaveLength(1);
	});
});
