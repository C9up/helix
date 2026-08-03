/**
 * The plugin API — Japa hands a plugin `{ config, cliArgs, runner, emitter }`;
 * helix hands the same four (plus its `context`/`cleanup` extras), so a Japa
 * plugin's body ports over unchanged.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cliArgs, resetCLIArgs } from "../../../src/runtime/cli-args.js";
import {
	configure,
	drainRunnerTeardowns,
	getConfiguredDefaults,
	type PluginApi,
} from "../../../src/runtime/configure.js";
import { executeRoot } from "../../../src/runtime/run.js";
import { resetRoot, test } from "../../../src/runtime/suite.js";
import { resetTaps, tappedBail } from "../../../src/runtime/suite-taps.js";

/** Every variable the CLI forwards — the whole set, so none leaks to the next test. */
const FLAG_ENV = [
	"HELIX_TAGS",
	"HELIX_TESTS",
	"HELIX_GROUPS",
	"HELIX_MATCH_ALL",
	"HELIX_TIMEOUT",
	"HELIX_RETRIES",
	"HELIX_GREP",
	"HELIX_SUITE",
	"HELIX_FILES",
	"HELIX_REPORTERS",
	"HELIX_BAIL",
	"HELIX_BAIL_LAYER",
	"HELIX_FAILED",
	"HELIX_FORCE_EXIT",
	"HELIX_LIST_PINNED",
	"HELIX_POSITIONALS",
];

afterEach(() => {
	for (const name of FLAG_ENV) delete process.env[name];
	// `cliArgs` is materialised once so a plugin's edits stick; clearing the
	// environment is therefore not enough to un-see a flag.
	resetCLIArgs();
	resetTaps();
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

	it("exposes the run-shaping flags too, not just the filters", async () => {
		process.env.HELIX_SUITE = "functional";
		process.env.HELIX_FILES = "user,admin";
		process.env.HELIX_REPORTERS = "spec,json";
		process.env.HELIX_BAIL = "1";
		process.env.HELIX_BAIL_LAYER = "group";
		process.env.HELIX_FAILED = "1";
		process.env.HELIX_FORCE_EXIT = "1";

		const api = await capture();

		expect(api.cliArgs.suite).toBe("functional");
		expect(api.cliArgs.files).toEqual(["user", "admin"]);
		expect(api.cliArgs.reporters).toEqual(["spec", "json"]);
		expect(api.cliArgs.bail).toBe(true);
		expect(api.cliArgs.bailLayer).toBe("group");
		expect(api.cliArgs.failed).toBe(true);
		expect(api.cliArgs.forceExit).toBe(true);
	});

	it("exposes the positionals and --list-pinned, as Japa's CLIArgs does", async () => {
		process.env.HELIX_POSITIONALS = "unit,functional";
		process.env.HELIX_LIST_PINNED = "1";

		const api = await capture();

		expect(api.cliArgs._).toEqual(["unit", "functional"]);
		expect(api.cliArgs.listPinned).toBe(true);
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

describe("plugin API — what a plugin can steer", () => {
	it("a plugin's edit to config.timeout reaches the run", async () => {
		// Japa documents config as something a plugin edits, so the defaults have
		// to be read back AFTER the plugins — not before them.
		await configure({
			timeout: 100,
			plugins: [
				(api) => {
					api.config.timeout = 4321;
				},
			],
		});

		expect(getConfiguredDefaults().timeout).toBe(4321);
	});

	it("a plugin's edit to cliArgs reaches the run", async () => {
		process.env.HELIX_TAGS = "@from-env";

		let observed: string[] | undefined;
		await configure({
			plugins: [
				(api) => {
					api.cliArgs.tags = ["@from-plugin"];
				},
				(api) => {
					observed = api.cliArgs.tags;
				},
			],
		});

		// The same object across accesses, and across plugins.
		expect(observed).toEqual(["@from-plugin"]);
		expect(cliArgs().tags).toEqual(["@from-plugin"]);
	});

	it("plugins run BEFORE the setup hooks, as in Japa", async () => {
		const order: string[] = [];
		await configure({
			setup: [
				() => {
					order.push("setup");
				},
			],
			plugins: [
				() => {
					order.push("plugin");
				},
			],
		});

		expect(order).toEqual(["plugin", "setup"]);
	});

	it("runner.onSuite hands over the suite, and its hooks still run", async () => {
		const order: string[] = [];
		let seenName: string | undefined;

		await configure({
			suite: "functional",
			plugins: [
				(api) => {
					api.runner.onSuite((suite) => {
						seenName = suite.name;
						suite.setup(() => {
							order.push("from onSuite");
						});
					});
				},
			],
		});

		expect(seenName).toBe("functional");
		// Registered from a plugin, yet still executed — that only holds because
		// setup hooks are drained after the plugins.
		expect(order).toEqual(["from onSuite"]);
	});

	it("runner.bail asks the run to stop at the first failure", async () => {
		expect(tappedBail()).toBeUndefined();

		await configure({
			plugins: [
				(api) => {
					api.runner.bail();
				},
			],
		});

		expect(tappedBail()).toBe(true);
	});

	it("a setup hook gets the runner and its returned undo is honoured", async () => {
		// The AdonisJS idiom: `setup: [() => testUtils.db().migrate()]`, where
		// migrate() resolves to the rollback. Ignoring the return would leave the
		// migration in place after the run.
		const order: string[] = [];
		let sawRunner = false;

		await configure({
			setup: [
				(runner) => {
					sawRunner = typeof runner.getSummary === "function";
					order.push("setup");
					return () => {
						order.push("undo");
					};
				},
			],
			teardown: [
				() => {
					order.push("teardown");
				},
			],
		});

		expect(sawRunner).toBe(true);
		expect(order).toEqual(["setup"]);

		await drainRunnerTeardowns();
		// The undo unwinds before the explicit teardown — it is the innermost
		// thing that was opened.
		expect(order).toEqual(["setup", "undo", "teardown"]);
	});

	it("runner.failed reflects the run", async () => {
		const api = await capture();

		// The runner is process-wide and zeroes itself on `runner:start`, so read
		// it where Japa does: after a run, never before one.
		const green = resetRoot();
		test("green", () => {});
		await executeRoot(green, "inline");
		expect(api.runner.failed).toBe(false);

		const red = resetRoot();
		test("red", () => {
			throw new Error("boom");
		});
		await executeRoot(red, "inline");
		expect(api.runner.failed).toBe(true);
	});
});
