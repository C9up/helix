/**
 * Official Japa plugins, running on helix.
 *
 * A plugin does not talk to the runner through an interface — `@japa/assert`
 * does `TestContext.getter(…)` and `Test.executed(…)` on the classes it
 * imported from `@japa/runner/core`. Matching that API's SHAPE was never
 * enough, which is what "not drop-in" meant for the whole of this package's
 * life. Redirecting the specifier is what closes it.
 *
 * The contrast is the test: with the alias the plugin's registration lands,
 * without it nothing does. A single positive run would prove nothing, since
 * helix ships its own `assert` and would satisfy a naive check either way.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const aliasLoader = path.resolve(here, "../../src/japa/japa-alias.mjs");
const workerEntry = path.resolve(here, "../../src/runtime/cli-worker.ts");

let root: string;
const savedBootstrap = process.env.HELIX_BOOTSTRAP;

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "helix-japa-"));
});

afterEach(async () => {
	if (savedBootstrap === undefined) delete process.env.HELIX_BOOTSTRAP;
	else process.env.HELIX_BOOTSTRAP = savedBootstrap;
	await rm(root, { recursive: true, force: true });
});

/** The tsx loader every worker needs to read the TypeScript fixtures. */
function tsxLoader(): string | undefined {
	const store = path.resolve(here, "../../../../node_modules/.pnpm");
	if (!existsSync(store)) return undefined;
	const entry = readdirSync(store).find((name) => name.startsWith("tsx@"));
	if (entry === undefined) return undefined;
	return `file://${path.join(store, entry, "node_modules/tsx/dist/loader.mjs")}`;
}

const silent = {
	onFileStart() {},
	onFileResult() {},
	onFileError() {},
	onSummary() {},
};

/**
 * A bootstrap whose plugin is written the way a Japa plugin is: it imports the
 * classes and instruments them. `japaProbe` is deliberately a name helix does
 * NOT ship, so the assertion cannot pass for another reason.
 */
async function project(): Promise<string> {
	// ESM, explicitly: without it the TS loader compiles the fixture to CJS, the
	// import becomes a `require`, and an ESM resolve hook never sees it. That is
	// a real constraint on the alias, not a quirk of the fixture.
	await writeFile(
		path.join(root, "package.json"),
		JSON.stringify({ name: "japa-fixture", type: "module", private: true }),
		"utf8",
	);
	await writeFile(
		path.join(root, "bootstrap.ts"),
		[
			'import { Test, TestContext } from "@japa/runner/core"',
			"export const plugins = [",
			"  () => {",
			'    TestContext.getter("japaProbe", () => "from-japa-core", true)',
			"    Test.executed(() => {})",
			"  },",
			"]",
			"",
		].join("\n"),
		"utf8",
	);
	const spec = path.join(root, "a.test.ts");
	await writeFile(
		spec,
		[
			`import { test } from "${path.resolve(here, "../../src/runtime/index.ts")}"`,
			'test("sees what the plugin registered", (ctx) => {',
			'  if (ctx.japaProbe !== "from-japa-core") {',
			'    throw new Error("japaProbe=" + String(ctx.japaProbe))',
			"  }",
			"})",
			"",
		].join("\n"),
		"utf8",
	);
	process.env.HELIX_BOOTSTRAP = path.join(root, "bootstrap.ts");
	return spec;
}

/** Run the fixture, optionally with the alias loader in the workers. */
async function runFixture(withAlias: boolean): Promise<number> {
	const spec = await project();
	const loader = tsxLoader();
	const outcome = await run({
		root,
		files: [spec],
		threads: 1,
		workerEntry,
		reporterInstance: silent,
		nodeArgs: [
			...(loader === undefined ? [] : ["--import", loader]),
			...(withAlias ? ["--import", `file://${aliasLoader}`] : []),
		],
	});
	return outcome.exitCode;
}

/**
 * A fixture whose plugin throws from `Test.executed` — a verdict, not a
 * teardown. `@japa/assert` validates `assert.plan(n)` exactly there.
 */
async function verdictProject(shouldThrow: boolean): Promise<string> {
	await writeFile(
		path.join(root, "package.json"),
		JSON.stringify({ name: "japa-fixture", type: "module", private: true }),
		"utf8",
	);
	await writeFile(
		path.join(root, "bootstrap.ts"),
		[
			'import { Test } from "@japa/runner/core"',
			"export const plugins = [",
			"  () => {",
			"    Test.executed((_test, hasError) => {",
			`      if (!hasError && ${shouldThrow}) throw new Error("plugin verdict")`,
			"    })",
			"  },",
			"]",
			"",
		].join("\n"),
		"utf8",
	);
	const spec = path.join(root, "a.test.ts");
	await writeFile(
		spec,
		[
			`import { test } from "${path.resolve(here, "../../src/runtime/index.ts")}"`,
			'test("passes on its own", () => {})',
			"",
		].join("\n"),
		"utf8",
	);
	process.env.HELIX_BOOTSTRAP = path.join(root, "bootstrap.ts");
	return spec;
}

describe("Test.executed is a verdict", () => {
	it("fails a test that passed on its own", async () => {
		// Swallowed, this makes every assertion-plan check inert: the plugin
		// validates, throws, and the run stays green.
		const spec = await verdictProject(true);
		const loader = tsxLoader();
		const outcome = await run({
			root,
			files: [spec],
			threads: 1,
			workerEntry,
			reporterInstance: silent,
			nodeArgs: [
				...(loader === undefined ? [] : ["--import", loader]),
				"--import",
				`file://${aliasLoader}`,
			],
		});

		expect(outcome.exitCode).toBe(1);
		expect(outcome.summary.files[0]?.tests[0]?.error?.message).toBe(
			"plugin verdict",
		);
	}, 60_000);

	it("leaves a passing test alone when it does not throw", async () => {
		const spec = await verdictProject(false);
		const loader = tsxLoader();
		const outcome = await run({
			root,
			files: [spec],
			threads: 1,
			workerEntry,
			reporterInstance: silent,
			nodeArgs: [
				...(loader === undefined ? [] : ["--import", loader]),
				"--import",
				`file://${aliasLoader}`,
			],
		});

		expect(outcome.exitCode).toBe(0);
	}, 60_000);
});

describe("official Japa plugins", () => {
	it("instrument helix when @japa/runner/core is aliased", async () => {
		expect(await runFixture(true)).toBe(0);
	}, 60_000);

	it("do nothing without the alias — which is what makes the test above mean something", async () => {
		expect(await runFixture(false)).toBe(1);
	}, 60_000);
});

describe("the parent resolves @japa/runner/core like the workers", () => {
	it("applies the alias before importing the bootstrap for global hooks", async () => {
		// The parent imports the bootstrap too, for `runnerHooks`. Without the
		// alias the two processes resolve that specifier differently — the parent
		// to the real Japa, the workers to the shim — so a bootstrap registering
		// at the top level registers on a class nothing reads. A project that
		// installed only `@japa/assert` cannot even import it in the parent.
		//
		// Checked in a spawned process: a resolve hook registered inside the test
		// runner's own module graph never reaches its imports.
		const marker = path.join(root, "who.txt");
		await writeFile(
			path.join(root, "package.json"),
			JSON.stringify({ name: "japa-parent", type: "module", private: true }),
			"utf8",
		);
		await writeFile(
			path.join(root, "bootstrap.ts"),
			[
				'import { appendFileSync } from "node:fs"',
				'import { Test } from "@japa/runner/core"',
				`appendFileSync(${JSON.stringify(marker)}, String(Test.isHelixShim === true))`,
				"export const runnerHooks = { setup: [() => {}] }",
				"",
			].join("\n"),
			"utf8",
		);

		const script = [
			`import { runGlobalHooks } from "${path.resolve(here, "../../src/runtime/global-hooks.ts")}"`,
			`await runGlobalHooks(${JSON.stringify(path.join(root, "bootstrap.ts"))}, { japaPlugins: true })`,
		].join("\n");

		const loader = tsxLoader();
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					...(loader === undefined ? [] : ["--import", loader]),
					"--input-type=module",
					"-e",
					script,
				],
				{ stdio: ["ignore", "ignore", "inherit"] },
			);
			child.on("exit", (code) =>
				code === 0 ? resolve() : reject(new Error(`child exited ${code}`)),
			);
		});

		const { readFileSync } = await import("node:fs");
		expect(readFileSync(marker, "utf8")).toBe("true");
	}, 60_000);
});

describe("the alias can be turned back off", () => {
	it("does not leak into a later run in the same process", async () => {
		// `node:module.register()` has no counterpart, so a hook installed once
		// stays. A host running twice in one process would keep resolving
		// `@japa/runner/core` to the shim after asking for the real one — silently,
		// which is the worst version of it.
		//
		// The fixture lives inside the package so `@japa/runner` IS resolvable:
		// the second run must resolve the REAL module, not merely fail to find one.
		const local = path.resolve(here, "../../.tmp-alias-scope");
		await rm(local, { recursive: true, force: true });
		await mkdir(local, { recursive: true });
		try {
			const marker = path.join(local, "who.txt");
			for (const n of [1, 2]) {
				await writeFile(
					path.join(local, `bootstrap${n}.ts`),
					[
						'import { appendFileSync } from "node:fs"',
						'import { Test } from "@japa/runner/core"',
						`appendFileSync(${JSON.stringify(marker)}, String(Test.isHelixShim === true) + "\\n")`,
						"export const runnerHooks = { setup: [() => {}] }",
						"",
					].join("\n"),
					"utf8",
				);
			}

			const script = [
				`import { runGlobalHooks } from "${path.resolve(here, "../../src/runtime/global-hooks.ts")}"`,
				`await (await runGlobalHooks(${JSON.stringify(path.join(local, "bootstrap1.ts"))}, { japaPlugins: true }))()`,
				`await (await runGlobalHooks(${JSON.stringify(path.join(local, "bootstrap2.ts"))}, { japaPlugins: false }))()`,
			].join("\n");

			const loader = tsxLoader();
			await new Promise<void>((resolve, reject) => {
				const child = spawn(
					process.execPath,
					[
						...(loader === undefined ? [] : ["--import", loader]),
						"--input-type=module",
						"-e",
						script,
					],
					{ stdio: ["ignore", "ignore", "pipe"] },
				);
				let err = "";
				child.stderr?.on("data", (c) => {
					err += String(c);
				});
				child.on("exit", (code) =>
					code === 0
						? resolve()
						: reject(new Error(`child exited ${code}: ${err.slice(0, 400)}`)),
				);
			});

			const { readFileSync } = await import("node:fs");
			expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual([
				"true",
				"false",
			]);
		} finally {
			await rm(local, { recursive: true, force: true });
		}
	}, 60_000);
});
