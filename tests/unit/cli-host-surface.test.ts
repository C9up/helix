/**
 * The pieces a host (ream's `ream test`) composes to drive helix the way
 * `helix test` does: the `--files` rule, list values that survive commas on
 * their way to the workers, and the watcher's polling mode.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filterByFileFilters } from "../../src/cli/file-filter.js";
import { createWatcher } from "../../src/cli/watch/watcher.js";
import { encodeEnvList, envList } from "../../src/runtime/cli-args.js";

describe("filterByFileFilters", () => {
	const files = [
		"/app/tests/unit/user.test.ts",
		"/app/tests/unit/post.spec.ts",
		"/app/tests/functional/user.test.ts",
	];

	it("keeps every file without a filter", () => {
		expect(filterByFileFilters(files, undefined)).toEqual(files);
		expect(filterByFileFilters(files, [])).toEqual(files);
	});

	it("matches a file name without its test suffix", () => {
		expect(filterByFileFilters(files, ["user"])).toEqual([
			"/app/tests/unit/user.test.ts",
			"/app/tests/functional/user.test.ts",
		]);
	});

	it("matches path segments read from the right, `*` matching any", () => {
		expect(filterByFileFilters(files, ["unit/*"])).toEqual([
			"/app/tests/unit/user.test.ts",
			"/app/tests/unit/post.spec.ts",
		]);
		expect(filterByFileFilters(files, ["functional/user"])).toEqual([
			"/app/tests/functional/user.test.ts",
		]);
	});

	it("matches a path the file ends with", () => {
		expect(filterByFileFilters(files, ["tests/unit/post.spec.ts"])).toEqual([
			"/app/tests/unit/post.spec.ts",
		]);
	});

	it("keeps a file any filter matches", () => {
		expect(filterByFileFilters(files, ["post", "functional/*"])).toEqual([
			"/app/tests/unit/post.spec.ts",
			"/app/tests/functional/user.test.ts",
		]);
	});
});

describe("env lists", () => {
	const saved = process.env.HELIX_LIST_PROBE;
	afterEach(() => {
		if (saved === undefined) delete process.env.HELIX_LIST_PROBE;
		else process.env.HELIX_LIST_PROBE = saved;
	});

	it("carry a title with a comma intact", () => {
		process.env.HELIX_LIST_PROBE = encodeEnvList([
			"a title, with a comma",
			"plain",
		]);
		expect(envList("HELIX_LIST_PROBE")).toEqual([
			"a title, with a comma",
			"plain",
		]);
	});

	it("still read the comma-separated form the CLI flags use", () => {
		process.env.HELIX_LIST_PROBE = "a, b ,,c";
		expect(envList("HELIX_LIST_PROBE")).toEqual(["a", "b", "c"]);
	});

	it("read an empty encoded list as unset", () => {
		process.env.HELIX_LIST_PROBE = encodeEnvList([]);
		expect(envList("HELIX_LIST_PROBE")).toBeUndefined();
	});
});

describe("createWatcher — polling", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("notices a change, an addition and a removal by polling", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "helix-poll-"));
		dirs.push(root);
		mkdirSync(path.join(root, "src"));
		writeFileSync(path.join(root, "src/a.ts"), "v1\n");
		writeFileSync(path.join(root, "src/gone.ts"), "x\n");

		const seen: string[][] = [];
		const watcher = createWatcher({
			root,
			include: ["src/**/*.ts"],
			exclude: ["node_modules/**"],
			debounceMs: 20,
			poll: true,
			pollIntervalMs: 40,
			onChange: (paths) => {
				seen.push([...paths].map((p) => path.basename(p)).sort());
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		writeFileSync(path.join(root, "src/a.ts"), "v2, longer\n");
		writeFileSync(path.join(root, "src/new.ts"), "n\n");
		rmSync(path.join(root, "src/gone.ts"));
		writeFileSync(path.join(root, "src/ignored.md"), "n\n");
		await new Promise((resolve) => setTimeout(resolve, 300));
		await watcher.close();

		expect(seen.flat().sort()).toEqual(["a.ts", "gone.ts", "new.ts"]);
	});
});
