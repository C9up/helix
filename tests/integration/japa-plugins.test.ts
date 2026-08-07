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

import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("official Japa plugins", () => {
	it("instrument helix when @japa/runner/core is aliased", async () => {
		expect(await runFixture(true)).toBe(0);
	}, 60_000);

	it("do nothing without the alias — which is what makes the test above mean something", async () => {
		expect(await runFixture(false)).toBe(1);
	}, 60_000);
});
