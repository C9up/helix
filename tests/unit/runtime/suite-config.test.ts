/**
 * `suites[].configure` — Japa's per-suite callback, re-imported in the worker
 * because a function cannot cross the CLI→worker boundary.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySuiteConfigure } from "../../../src/runtime/suite-config.js";
import { makeSuiteHandle, resetTaps } from "../../../src/runtime/suite-taps.js";

let root: string;
const saved = {
	config: process.env.HELIX_SUITE_CONFIG,
	key: process.env.HELIX_SUITE_CONFIG_KEY,
};

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "helix-suitecfg-"));
	resetTaps();
});

afterEach(async () => {
	resetTaps();
	for (const [name, value] of [
		["HELIX_SUITE_CONFIG", saved.config],
		["HELIX_SUITE_CONFIG_KEY", saved.key],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await rm(root, { recursive: true, force: true });
});

/** Write a config module and point the worker env at it. */
async function configWith(body: string, key?: string): Promise<void> {
	const file = path.join(root, "helix.config.ts");
	await writeFile(file, body, "utf8");
	process.env.HELIX_SUITE_CONFIG = file;
	if (key === undefined) delete process.env.HELIX_SUITE_CONFIG_KEY;
	else process.env.HELIX_SUITE_CONFIG_KEY = key;
}

describe("applySuiteConfigure", () => {
	it("calls the configure of the RUNNING suite only", async () => {
		await configWith(
			[
				"export default { suites: [",
				'  { name: "e2e", files: "x", configure: (s) => s.setup(() => "e2e") },',
				'  { name: "unit", files: "x", configure: (s) => s.setup(() => "unit") },',
				"] }",
				"",
			].join("\n"),
		);
		const setup: Array<() => unknown> = [];

		await applySuiteConfigure("e2e", makeSuiteHandle("e2e", setup, []));

		expect(setup).toHaveLength(1);
		expect(setup[0]()).toBe("e2e");
	});

	it("finds the suites under a dotted key, as ream declares them", async () => {
		await configWith(
			[
				"export default { tests: { suites: [",
				'  { name: "e2e", files: "x", configure: (s) => s.setup(() => "nested") },',
				"] } }",
				"",
			].join("\n"),
			"tests.suites",
		);
		const setup: Array<() => unknown> = [];

		await applySuiteConfigure("e2e", makeSuiteHandle("e2e", setup, []));

		expect(setup[0]?.()).toBe("nested");
	});

	it("does nothing when no config module was named", async () => {
		process.env.HELIX_SUITE_CONFIG = "";
		const setup: Array<() => unknown> = [];

		await applySuiteConfigure("e2e", makeSuiteHandle("e2e", setup, []));

		expect(setup).toHaveLength(0);
	});

	it("does nothing for a suite the config does not declare", async () => {
		await configWith(
			'export default { suites: [{ name: "unit", files: "x", configure: (s) => s.setup(() => 1) }] }\n',
		);
		const setup: Array<() => unknown> = [];

		await applySuiteConfigure("e2e", makeSuiteHandle("e2e", setup, []));

		expect(setup).toHaveLength(0);
	});

	it("tolerates a suite that declares no configure", async () => {
		await configWith(
			'export default { suites: [{ name: "e2e", files: "x" }] }\n',
		);
		const setup: Array<() => unknown> = [];

		await expect(
			applySuiteConfigure("e2e", makeSuiteHandle("e2e", setup, [])),
		).resolves.toBeUndefined();
		expect(setup).toHaveLength(0);
	});

	it("tolerates a config whose suites are not an array", async () => {
		await configWith('export default { suites: "nope" }\n');
		const setup: Array<() => unknown> = [];

		await expect(
			applySuiteConfigure("e2e", makeSuiteHandle("e2e", setup, [])),
		).resolves.toBeUndefined();
	});
});
