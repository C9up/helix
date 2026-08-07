/**
 * `runnerHooks` run once for the whole run, not once per worker.
 *
 * The difference is a migration that runs once versus once per test file. It
 * used to be the latter, defended by "a resource opened in the parent would not
 * exist in the workers" — true of an in-memory one, and false of everything
 * these hooks actually do.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	GLOBAL_HOOKS_ENV,
	globalHooksHandledByParent,
	runGlobalHooks,
} from "../../../src/runtime/global-hooks.js";

let root: string;
const savedFlag = process.env[GLOBAL_HOOKS_ENV];

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "helix-globalhooks-"));
	delete process.env[GLOBAL_HOOKS_ENV];
});

afterEach(async () => {
	if (savedFlag === undefined) delete process.env[GLOBAL_HOOKS_ENV];
	else process.env[GLOBAL_HOOKS_ENV] = savedFlag;
	await rm(root, { recursive: true, force: true });
});

/** Write a bootstrap module and hand back its path. */
async function bootstrap(body: string): Promise<string> {
	const file = path.join(root, "bootstrap.ts");
	await writeFile(file, body, "utf8");
	return file;
}

describe("runGlobalHooks", () => {
	it("runs setup once and marks the workers to skip it", async () => {
		const log = path.join(root, "log.json");
		const file = await bootstrap(
			[
				'import { appendFileSync } from "node:fs"',
				"export const runnerHooks = {",
				`  setup: [() => appendFileSync(${JSON.stringify(log)}, "setup\\n")],`,
				"}",
				"",
			].join("\n"),
		);

		expect(globalHooksHandledByParent()).toBe(false);
		await runGlobalHooks(file);

		const { readFileSync } = await import("node:fs");
		expect(readFileSync(log, "utf8")).toBe("setup\n");
		// Every worker spawned from here inherits this and skips the hooks.
		expect(globalHooksHandledByParent()).toBe(true);
	});

	it("unwinds undos before teardowns, both in reverse", async () => {
		const log = path.join(root, "log.json");
		const file = await bootstrap(
			[
				'import { appendFileSync } from "node:fs"',
				`const write = (m) => appendFileSync(${JSON.stringify(log)}, m + "\\n")`,
				"export const runnerHooks = {",
				'  setup: [() => { write("setup"); return () => write("undo") }],',
				'  teardown: [() => write("teardown-first"), () => write("teardown-second")],',
				"}",
				"",
			].join("\n"),
		);

		const drop = await runGlobalHooks(file);
		await drop();

		const { readFileSync } = await import("node:fs");
		expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
			"setup",
			"undo",
			"teardown-second",
			"teardown-first",
		]);
	});

	it("restores the flag afterwards, so a second run is not skipped", async () => {
		// The CLI exits right after and would never notice. A host calling this
		// twice in one process would: the second run would inherit the flag and
		// skip its own hooks in every worker.
		const log = path.join(root, "log.json");
		const file = await bootstrap(
			[
				'import { appendFileSync } from "node:fs"',
				"export const runnerHooks = {",
				`  setup: [() => appendFileSync(${JSON.stringify(log)}, "x")],`,
				"}",
				"",
			].join("\n"),
		);

		await (await runGlobalHooks(file))();
		expect(globalHooksHandledByParent()).toBe(false);

		// Second run: the hooks must run again, not be skipped.
		await (await runGlobalHooks(file))();

		const { readFileSync } = await import("node:fs");
		expect(readFileSync(log, "utf8")).toBe("xx");
	});

	it("does not mark anything when the bootstrap declares no hooks", async () => {
		const file = await bootstrap("export const plugins = []\n");

		const drop = await runGlobalHooks(file);
		await drop();

		// Nothing ran, so nothing for a worker to skip — a worker must still be
		// free to run hooks a later bootstrap adds.
		expect(globalHooksHandledByParent()).toBe(false);
	});

	it("is a no-op without a bootstrap at all", async () => {
		const drop = await runGlobalHooks(undefined);
		await expect(drop()).resolves.toBeUndefined();
		expect(globalHooksHandledByParent()).toBe(false);
	});

	it("unwinds what already ran when a setup hook throws", async () => {
		// Half-way through: the first hook opened something, the second fails. Its
		// undo has to run anyway, or the failure leaves the process changed.
		const log = path.join(root, "unwound.json");
		const file = await bootstrap(
			[
				'import { appendFileSync } from "node:fs"',
				`const write = (m) => appendFileSync(${JSON.stringify(log)}, m)`,
				"export const runnerHooks = {",
				"  setup: [",
				'    () => { write("first"); return () => write("|undone") },',
				'    () => { throw new Error("setup boom") },',
				"  ],",
				"}",
				"",
			].join("\n"),
		);

		await expect(runGlobalHooks(file)).rejects.toThrow("setup boom");

		const { readFileSync } = await import("node:fs");
		expect(readFileSync(log, "utf8")).toBe("first|undone");
	});

	it("leaves the flag alone when setup fails", async () => {
		const file = await bootstrap(
			[
				"export const runnerHooks = {",
				'  setup: [() => { throw new Error("setup boom") }],',
				"}",
				"",
			].join("\n"),
		);

		await expect(runGlobalHooks(file)).rejects.toThrow("setup boom");

		// A run that could not set itself up must not tell the workers their hooks
		// were already handled.
		expect(globalHooksHandledByParent()).toBe(false);
	});

	it("does not swallow an unimportable bootstrap", async () => {
		const file = path.join(root, "missing-bootstrap.ts");

		await expect(runGlobalHooks(file)).rejects.toThrow();
		expect(globalHooksHandledByParent()).toBe(false);
	});

	it("a failing teardown is reported, not thrown at the run", async () => {
		const file = await bootstrap(
			[
				"export const runnerHooks = {",
				'  teardown: [() => { throw new Error("teardown boom") }],',
				"}",
				"",
			].join("\n"),
		);

		const drop = await runGlobalHooks(file);
		// A broken teardown must not turn a green run red after the fact.
		await expect(drop()).resolves.toBeUndefined();
	});
});
