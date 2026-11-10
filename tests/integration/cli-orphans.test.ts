/**
 * A worker never outlives the run that spawned it. When the CLI dies without a
 * chance to clean up — SIGKILL, the OOM killer of a memory-capped scope — a
 * worker stuck in a hanging test used to stay alive, reparented to init, for as
 * long as anything kept its event loop busy. It now notices the parent is gone
 * and takes its own process group down with it.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { project, runtimeUrl } from "../__helpers__/cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, "../../bin/helix.js");

const roots: string[] = [];
const pids: number[] = [];
const clis: ChildProcess[] = [];

afterEach(async () => {
	// Whatever the assertions said, nothing this test started may survive it.
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	for (const cli of clis.splice(0)) cli.kill("SIGKILL");
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

/** Alive, and not a zombie waiting for a reaper. */
function alive(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The state follows the parenthesised command name.
		return (
			stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
		);
	} catch {
		return false;
	}
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return check();
}

const hanging = [
	`import { test } from "${runtimeUrl}";`,
	'import { spawn } from "node:child_process";',
	'import { writeFileSync } from "node:fs";',
	'test("hangs", async () => {',
	'	const sleeper = spawn("sleep", ["7741.5"], { stdio: "ignore" });',
	"	setInterval(() => {}, 1000);",
	'	writeFileSync("pids.json", JSON.stringify({ worker: process.pid, parent: process.ppid, sleeper: sleeper.pid }));',
	"	await new Promise(() => {});",
	"});",
	"",
].join("\n");

const pools: ReadonlyArray<[string, (root: string) => string[]]> = [
	["native pool", () => []],
	["TypeScript pool", (root) => ["--coverage", `--coverage-dir=${root}/cov`]],
];

describe.skipIf(process.platform !== "linux").each(pools)(
	"a worker whose CLI died — %s",
	(_label, extra) => {
		it("exits with its process group within two seconds", async () => {
			const root = await project({ "tests/hang.test.ts": hanging });
			roots.push(root);
			const env: Record<string, string | undefined> = { ...process.env };
			for (const key of Object.keys(env)) {
				if (key.startsWith("HELIX_") || key === "CI") delete env[key];
			}
			const cli = spawn(
				process.execPath,
				[
					bin,
					"test",
					"tests/hang.test.ts",
					"--colors=false",
					"--timeout=600000",
					"--file-timeout=600000",
					...extra(root),
				],
				{ cwd: root, env, stdio: "ignore" },
			);
			clis.push(cli);

			const pidFile = path.join(root, "pids.json");
			expect(await waitFor(() => existsSync(pidFile), 30_000)).toBe(true);
			const recorded: unknown = JSON.parse(readFileSync(pidFile, "utf8"));
			const read = (key: string): number => {
				const value =
					recorded !== null && typeof recorded === "object"
						? Reflect.get(recorded, key)
						: undefined;
				if (typeof value !== "number") throw new Error(`no ${key} pid`);
				return value;
			};
			const worker = read("worker");
			const parent = read("parent");
			const sleeper = read("sleeper");
			pids.push(worker, sleeper, parent);

			// The process that spawned the worker dies without running anything.
			process.kill(parent, "SIGKILL");

			expect(await waitFor(() => !alive(worker), 2_000)).toBe(true);
			expect(await waitFor(() => !alive(sleeper), 2_000)).toBe(true);
		}, 60_000);
	},
);
