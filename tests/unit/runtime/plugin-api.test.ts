/**
 * The plugin API — Japa hands a plugin `{ config, cliArgs, runner, emitter }`;
 * helix hands the same four (plus its `context`/`cleanup` extras), so a Japa
 * plugin's body ports over unchanged.
 */

import { afterEach, describe, expect, it } from "vitest";
import { configure, type PluginApi } from "../../../src/runtime/configure.js";
import { executeRoot } from "../../../src/runtime/run.js";
import { resetRoot, test } from "../../../src/runtime/suite.js";

const FILTER_ENV = [
	"HELIX_TAGS",
	"HELIX_TESTS",
	"HELIX_GROUPS",
	"HELIX_MATCH_ALL",
	"HELIX_TIMEOUT",
	"HELIX_RETRIES",
	"HELIX_GREP",
];

afterEach(() => {
	for (const name of FILTER_ENV) delete process.env[name];
});

/** Install a plugin and hand back the API object it received. */
async function capture(
	options: Parameters<typeof configure>[0] = {},
): Promise<PluginApi> {
	let received: PluginApi | undefined;
	await configure({
		...options,
		plugins: [
			(api) => {
				received = api;
			},
		],
	});
	if (received === undefined) throw new Error("the plugin never ran");
	return received;
}

describe("plugin API — Japa surface", () => {
	it("exposes the options the run was configured with", async () => {
		const api = await capture({ timeout: 1234, retries: 2 });

		expect(api.config.timeout).toBe(1234);
		expect(api.config.retries).toBe(2);
	});

	it("exposes the filters the CLI forwarded", async () => {
		process.env.HELIX_TAGS = "@slow,~@flaky";
		process.env.HELIX_TESTS = "one,two";
		process.env.HELIX_GROUPS = "alpha";
		process.env.HELIX_MATCH_ALL = "1";
		process.env.HELIX_TIMEOUT = "500";
		process.env.HELIX_RETRIES = "3";
		process.env.HELIX_GREP = "slow";

		const api = await capture();

		expect(api.cliArgs).toEqual({
			tags: ["@slow", "~@flaky"],
			tests: ["one", "two"],
			groups: ["alpha"],
			matchAll: true,
			timeout: 500,
			retries: 3,
			grep: "slow",
		});
	});

	it("leaves cliArgs entries undefined when no flag was passed", async () => {
		const api = await capture();

		expect(api.cliArgs.tags).toBeUndefined();
		expect(api.cliArgs.matchAll).toBeUndefined();
	});

	it("hands over the emitter the runtime actually emits on", async () => {
		const api = await capture();
		const seen: string[] = [];
		api.emitter.on("test:end", (t) => seen.push(t.title.expanded));
		api.emitter.on("group:start", (g) => seen.push(`group:${g.title}`));

		const root = resetRoot();
		test.group("outer", () => {
			test("inner", () => {});
		});
		await executeRoot(root, "inline");

		expect(seen).toEqual(["group:outer", "inner"]);
	});

	it("tracks the run through runner.getSummary()", async () => {
		const api = await capture();

		const root = resetRoot();
		test("green", () => {});
		test("red", () => {
			throw new Error("boom");
		});
		test("ignored", () => {}).skip();
		test("later");
		await executeRoot(root, "inline");

		const summary = api.runner.getSummary();
		expect(summary.aggregates).toEqual({
			total: 4,
			passed: 1,
			failed: 1,
			skipped: 1,
			todo: 1,
		});
		expect(summary.hasError).toBe(true);
		expect(summary.failedTestsTitles).toEqual(["red"]);
	});
});
