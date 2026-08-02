/**
 * The `--failed` cache — what turns "this failed last run" into a `--tests`
 * filter on the next one (Japa's retry plugin).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	failedTestTitles,
	readFailedCache,
	writeFailedCache,
} from "../../src/cli/failed-cache.js";
import type { Summary } from "../../src/cli/summary.js";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "helix-failed-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** A summary carrying the given test outcomes, spread over one file. */
function summaryOf(tests: Array<[string, "pass" | "fail"]>): Summary {
	return {
		totals: {
			pass: tests.filter(([, s]) => s === "pass").length,
			fail: tests.filter(([, s]) => s === "fail").length,
			skip: 0,
			todo: 0,
			fileErrors: 0,
		},
		files: [
			{
				file: "/tmp/a.test.ts",
				suites: [],
				tests: tests.map(([name, status]) => ({
					name,
					fullName: name,
					status,
					durationMs: 1,
				})),
				totals: {
					pass: tests.filter(([, s]) => s === "pass").length,
					fail: tests.filter(([, s]) => s === "fail").length,
					skip: 0,
					todo: 0,
				},
				durationMs: 1,
			},
		],
		fileErrors: [],
		durationMs: 1,
	};
}

describe("failed cache", () => {
	it("keeps only the failed titles", () => {
		const titles = failedTestTitles(
			summaryOf([
				["green", "pass"],
				["red", "fail"],
				["also red", "fail"],
			]),
		);

		expect(titles).toEqual(["red", "also red"]);
	});

	it("does not repeat a title that failed in several places", () => {
		const titles = failedTestTitles(
			summaryOf([
				["same name", "fail"],
				["same name", "fail"],
			]),
		);

		expect(titles).toEqual(["same name"]);
	});

	it("round-trips through the cache file", async () => {
		await writeFailedCache(
			root,
			summaryOf([
				["red", "fail"],
				["green", "pass"],
			]),
		);

		expect(await readFailedCache(root)).toEqual(["red"]);
	});

	it("reads back an empty list when nothing was cached", async () => {
		expect(await readFailedCache(root)).toEqual([]);
	});

	it("reads back an empty list when the cache is malformed", async () => {
		const file = path.join(root, "node_modules", ".cache", "helix");
		await mkdir(file, { recursive: true });
		await writeFile(path.join(file, "summary.json"), "{ not json", "utf8");

		expect(await readFailedCache(root)).toEqual([]);
	});

	it("does not throw when the cache cannot be written", async () => {
		// A root that does not exist and cannot be created under a file path.
		const blocked = path.join(root, "a-file");
		await writeFile(blocked, "", "utf8");

		await expect(
			writeFailedCache(path.join(blocked, "nested"), summaryOf([])),
		).resolves.toBeUndefined();
	});
});
