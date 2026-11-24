/**
 * An error's code reaches what the user reads: the spec reporter prints it
 * before the message, the json reporter carries it on the test's error and on
 * a file error. On both pools — the native engine re-reads every frame the
 * worker sends, so a field its mirror lacks never reaches a reporter.
 */

import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helix, project, runtimeUrl } from "../__helpers__/cli.js";

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(
		roots.map((root) => rm(root, { recursive: true, force: true })),
	);
});

const failing = [
	`import { expect, test } from "${runtimeUrl}";`,
	'test("asserts", () => {',
	"	expect(1).toBe(2);",
	"});",
	// Nothing will ever settle it, and nothing else is pending: the deadline
	// alone must keep the worker alive until it fires.
	'test("hangs", () => new Promise(() => {})).timeout(100);',
	'test("aborts", (ctx) => {',
	'	ctx.test.options.meta.abort("stopped here");',
	"});",
	'test("plain", () => {',
	'	throw new Error("no code on this one");',
	"});",
	"",
].join("\n");

const rejecting = [
	`import { expect, test } from "${runtimeUrl}";`,
	'test("passes but leaks a rejection", () => {',
	'	Promise.reject(Object.assign(new Error("late"), { code: "E_LATE_REJECT" }));',
	"	expect(1).toBe(1);",
	"});",
	"",
].join("\n");

const stuck = "while (true) {}\n";

const hanging = [
	`import { beforeEach, describe, test, vi } from "${runtimeUrl}";`,
	'describe("hook", () => {',
	"	beforeEach(() => new Promise(() => {}));",
	'	test("behind a hook that never settles", () => {}).timeout(100);',
	"});",
	'describe("fake clock", () => {',
	'	test("hangs with fake timers installed", async () => {',
	"		vi.useFakeTimers();",
	"		await new Promise(() => {});",
	"	}).timeout(100);",
	"});",
	"",
].join("\n");

const focused = [
	`import { test } from "${runtimeUrl}";`,
	'test.only("focused", () => {});',
	"",
].join("\n");

const empty = `import "${runtimeUrl}";\nexport {};\n`;

// Long deadlines that must not outlive their test: one on a body that
// rejects, one re-armed through a finished test's handle.
const settled = [
	`import { test } from "${runtimeUrl}";`,
	"let finished;",
	'test("rejects", async () => { throw new Error("boom"); }).timeout(60_000);',
	'test("finishes", (ctx) => { finished = ctx.test; }).timeout(60_000);',
	'test("re-arms a finished test", () => { finished.resetTimeout(60_000); });',
	"",
].join("\n");

/** The pools a run can take: the native engine, or the TypeScript one. */
const pools: Array<[string, (root: string) => string[]]> = [
	["native", () => []],
	["TypeScript", (root) => ["--coverage", `--coverage-dir=${root}/cov`]],
];

interface JsonEvent {
	event: string;
	result?: {
		file: string;
		tests: Array<{ name: string; error?: { code?: string } }>;
	};
	error?: { file?: string; code?: string; message: string };
}

function events(stdout: string): JsonEvent[] {
	return stdout
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line));
}

// Every case spawns a whole `helix test` run, which under a loaded,
// coverage-instrumented suite outgrows Vitest's 5s default.
describe.each(pools)(
	"helix test — error codes on the %s pool",
	{ timeout: 30_000 },
	(_, extra) => {
		let root: string;

		beforeAll(async () => {
			root = await project({
				"tests/failing.test.ts": failing,
				"tests/rejecting.test.ts": rejecting,
				"tests/stuck.test.ts": stuck,
				"tests/hanging.test.ts": hanging,
				"tests/focused.test.ts": focused,
				"tests/empty.test.ts": empty,
				"tests/settled.test.ts": settled,
			});
			roots.push(root);
		});

		it("the spec reporter prints each test error's code", () => {
			const run = helix(root, ["tests/failing.test.ts", ...extra(root)]);
			expect(run.status).toBe(1);
			expect(run.stdout).toContain("[E_HELIX_ASSERTION_FAILED] expected");
			expect(run.stdout).toContain(
				'[E_HELIX_TIMEOUT] test "hangs" exceeded 100ms timeout',
			);
			expect(run.stdout).toContain("[E_HELIX_TEST_ABORTED] stopped here");
			expect(run.stdout).toMatch(/\n {6}no code on this one\n/);
		});

		it("the json reporter carries each test error's code", () => {
			const run = helix(root, [
				"tests/failing.test.ts",
				"--reporter=json",
				...extra(root),
			]);
			expect(run.status).toBe(1);
			const end = events(run.stdout).find((e) => e.event === "file:end");
			const codes = end?.result?.tests.map((t) => [t.name, t.error?.code]);
			expect(codes).toEqual([
				["asserts", "E_HELIX_ASSERTION_FAILED"],
				["hangs", "E_HELIX_TIMEOUT"],
				["aborts", "E_HELIX_TEST_ABORTED"],
				["plain", undefined],
			]);
		});

		it("a hook or a fake-clock test that never settles times out, coded", () => {
			const run = helix(root, [
				"tests/hanging.test.ts",
				"--reporter=json",
				...extra(root),
			]);
			expect(run.status).toBe(1);
			const all = events(run.stdout);
			expect(all.find((e) => e.event === "file:error")).toBeUndefined();
			const end = all.find((e) => e.event === "file:end");
			const codes = end?.result?.tests.map((t) => [t.name, t.error?.code]);
			expect(codes).toEqual([
				["behind a hook that never settles", "E_HELIX_TIMEOUT"],
				["hangs with fake timers installed", "E_HELIX_TIMEOUT"],
			]);
		});

		it("a deadline never holds the worker open once its test is over", () => {
			const run = helix(root, ["tests/settled.test.ts", ...extra(root)]);
			expect(run.status).toBe(1);
			expect(run.stdout).toContain("boom");
			expect(run.stderr).not.toContain("did not exit");
		});

		it("a .only the run does not allow fails its test with E_HELIX_UNEXPECTED_ONLY", () => {
			const run = helix(root, [
				"tests/focused.test.ts",
				"--allow-only=false",
				"--reporter=json",
				...extra(root),
			]);
			expect(run.status).toBe(1);
			const end = events(run.stdout).find((e) => e.event === "file:end");
			expect(end?.result?.tests.map((t) => t.error?.code)).toEqual([
				"E_HELIX_UNEXPECTED_ONLY",
			]);
		});

		it("a file that declares no test is a file error coded E_HELIX_NO_TEST_SUITE", () => {
			const run = helix(root, [
				"tests/empty.test.ts",
				"--reporter=json",
				...extra(root),
			]);
			expect(run.status).toBe(1);
			const error = events(run.stdout).find((e) => e.event === "file:error");
			expect(error?.error).toMatchObject({
				code: "E_HELIX_NO_TEST_SUITE",
				message: expect.stringContaining("No test suite found in file"),
			});
		});

		it("a file error keeps the code of what was thrown", () => {
			const run = helix(root, [
				"tests/rejecting.test.ts",
				"--reporter=json",
				...extra(root),
			]);
			expect(run.status).toBe(1);
			const error = events(run.stdout).find((e) => e.event === "file:error");
			expect(error?.error).toMatchObject({
				code: "E_LATE_REJECT",
				message: expect.stringContaining("late"),
			});
		});

		it("a file past its deadline is a file error coded E_HELIX_TIMEOUT", () => {
			const run = helix(root, [
				"tests/stuck.test.ts",
				"--file-timeout=1000",
				"--reporter=json",
				...extra(root),
			]);
			expect(run.status).toBe(1);
			const error = events(run.stdout).find((e) => e.event === "file:error");
			expect(error?.error).toMatchObject({
				code: "E_HELIX_TIMEOUT",
				message: expect.stringContaining("timed out after 1000ms"),
			});
		});
	},
);
