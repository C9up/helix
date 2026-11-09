/**
 * `collect` reads V8 coverage dumps written by worker processes. Their shape is
 * checked rather than assumed: an entry that is not a script — a truncated
 * dump, a file that only looks like one — is skipped instead of crashing the
 * coverage report after a green run.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collect } from "../../src/cli/coverage/collect.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "helix-collect-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const fn = {
	functionName: "f",
	isBlockCoverage: true,
	ranges: [{ startOffset: 0, endOffset: 10, count: 1 }],
};

describe("coverage collect", () => {
	it("keeps well-formed scripts and skips the rest", async () => {
		const source = path.join(dir, "a.ts");
		await writeFile(source, "export const a = 1;\n");
		await writeFile(
			path.join(dir, "coverage-1.json"),
			JSON.stringify({
				result: [
					{
						scriptId: "1",
						url: pathToFileURL(source).href,
						functions: [fn],
					},
					{ scriptId: "2", url: pathToFileURL(source).href },
					{ scriptId: "3", url: 42, functions: [fn] },
					{
						scriptId: "4",
						url: pathToFileURL(source).href,
						functions: [{ ...fn, ranges: [{ startOffset: "0" }] }],
					},
					null,
				],
			}),
		);
		await writeFile(path.join(dir, "coverage-2.json"), '{"result": 5}');

		const files = await collect(dir);
		expect(files).toHaveLength(1);
		expect(files[0]?.file).toBe(source);
		expect(files[0]?.functions).toEqual([fn]);
	});
});
