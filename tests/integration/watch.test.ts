import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunOutcome } from "../../src/cli/run.js";
import { runWatch } from "../../src/cli/watch/loop.js";
import { createWatcher } from "../../src/cli/watch/watcher.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
	cleanups.length = 0;
});

function mkTmp(): string {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "helix-watch-"));
	cleanups.push(tmp);
	return tmp;
}

function makeOutcome(): RunOutcome {
	return {
		summary: {
			totals: { pass: 0, fail: 0, skip: 0, todo: 0, fileErrors: 0 },
			files: [],
			fileErrors: [],
			durationMs: 0,
		},
		exitCode: 0,
	};
}

function nextTick(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("watch — createWatcher", () => {
	it("debounces a burst of writes into one onChange", async () => {
		const tmp = mkTmp();
		mkdirSync(path.join(tmp, "src"));
		const target = path.join(tmp, "src/a.ts");
		writeFileSync(target, "v1\n");

		let calls = 0;
		const watcher = createWatcher({
			root: tmp,
			include: ["src/**/*.ts"],
			exclude: ["node_modules/**"],
			debounceMs: 80,
			onChange: () => {
				calls += 1;
			},
		});

		// Five rapid writes within the debounce window.
		for (let i = 0; i < 5; i += 1) {
			writeFileSync(target, `v${i + 2}\n`);
			await nextTick(5);
		}
		await nextTick(200);
		await watcher.close();

		expect(calls).toBe(1);
	}, 5000);

	it("ignores changes outside include or matching exclude", async () => {
		const tmp = mkTmp();
		mkdirSync(path.join(tmp, "node_modules"));
		mkdirSync(path.join(tmp, "src"));

		let calls = 0;
		const watcher = createWatcher({
			root: tmp,
			include: ["src/**/*.ts"],
			exclude: ["node_modules/**"],
			debounceMs: 60,
			onChange: () => {
				calls += 1;
			},
		});

		writeFileSync(path.join(tmp, "node_modules/junk.js"), "ignored\n");
		writeFileSync(path.join(tmp, "src/a.md"), "ignored\n");
		await nextTick(200);
		await watcher.close();

		expect(calls).toBe(0);
	}, 5000);

	it("close() is idempotent and stops further notifications", async () => {
		const tmp = mkTmp();
		mkdirSync(path.join(tmp, "src"));
		let calls = 0;
		const watcher = createWatcher({
			root: tmp,
			include: ["src/**/*.ts"],
			exclude: [],
			debounceMs: 50,
			onChange: () => {
				calls += 1;
			},
		});
		await watcher.close();
		await watcher.close();
		writeFileSync(path.join(tmp, "src/a.ts"), "v\n");
		await nextTick(150);
		expect(calls).toBe(0);
	}, 5000);

	it("rejects an out-of-range debounce", () => {
		expect(() =>
			createWatcher({
				root: os.tmpdir(),
				include: ["**/*"],
				exclude: [],
				debounceMs: -1,
				onChange: () => {},
			}),
		).toThrow(/debounceMs/);
	});

	it("rejects an empty include array (silent watcher prevention)", () => {
		expect(() =>
			createWatcher({
				root: os.tmpdir(),
				include: [],
				exclude: [],
				debounceMs: 50,
				onChange: () => {},
			}),
		).toThrow(/include must be non-empty/);
	});
});

describe("watch — runWatch loop", () => {
	it("runs once on startup, then re-runs on change", async () => {
		const tmp = mkTmp();
		mkdirSync(path.join(tmp, "src"));
		const target = path.join(tmp, "src/a.ts");
		writeFileSync(target, "v1\n");

		let invocations = 0;
		const runOnce = async (): Promise<RunOutcome> => {
			invocations += 1;
			return makeOutcome();
		};

		const ac = new AbortController();
		const promise = runWatch(
			{
				root: tmp,
				include: ["src/**/*.ts"],
				exclude: [],
				debounceMs: 60,
				signal: ac.signal,
			},
			runOnce,
		);

		await nextTick(80);
		writeFileSync(target, "v2\n");
		await nextTick(250);

		ac.abort();
		const outcome = await promise;

		expect(invocations).toBeGreaterThanOrEqual(2);
		expect(outcome.exitCode).toBe(0);
	}, 5000);

	it("serialises re-runs (queue at most one follow-up)", async () => {
		const tmp = mkTmp();
		mkdirSync(path.join(tmp, "src"));
		const target = path.join(tmp, "src/a.ts");
		writeFileSync(target, "v1\n");

		let inProgress = false;
		let invocations = 0;
		let maxConcurrent = 0;
		let concurrent = 0;
		const runOnce = async (): Promise<RunOutcome> => {
			invocations += 1;
			concurrent += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			inProgress = true;
			await nextTick(120);
			inProgress = false;
			concurrent -= 1;
			return makeOutcome();
		};

		const ac = new AbortController();
		const promise = runWatch(
			{
				root: tmp,
				include: ["src/**/*.ts"],
				exclude: [],
				debounceMs: 30,
				signal: ac.signal,
			},
			runOnce,
		);

		await nextTick(50);
		for (let i = 0; i < 8; i += 1) {
			writeFileSync(target, `v${i + 2}\n`);
			await nextTick(20);
		}
		await nextTick(500);
		expect(inProgress).toBe(false);

		ac.abort();
		await promise;

		// Invariant: re-runs are serialised — never concurrent.
		expect(maxConcurrent).toBe(1);
		expect(invocations).toBeGreaterThanOrEqual(2);
		// Tight upper bound: 1 (initial) + 1 (queued follow-up) +
		// 1 (post-queue late event from flush after the queued run drains)
		// = 3 max in normal scheduling.
		expect(invocations).toBeLessThanOrEqual(3);
	}, 8000);

	it("abort drains in-flight run before resolving", async () => {
		const tmp = mkTmp();
		mkdirSync(path.join(tmp, "src"));
		writeFileSync(path.join(tmp, "src/a.ts"), "v1\n");

		let inFlightCompleted = false;
		const runOnce = async (): Promise<RunOutcome> => {
			await nextTick(150);
			inFlightCompleted = true;
			return makeOutcome();
		};

		const ac = new AbortController();
		const promise = runWatch(
			{
				root: tmp,
				include: ["src/**/*.ts"],
				exclude: [],
				debounceMs: 30,
				signal: ac.signal,
			},
			runOnce,
		);

		await nextTick(20);
		ac.abort();
		const outcome = await promise;

		expect(inFlightCompleted).toBe(true);
		expect(outcome.exitCode).toBe(0);
	}, 5000);

	it("returns a fallback outcome (exit 0) when the initial run throws", async () => {
		const tmp = mkTmp();
		mkdirSync(path.join(tmp, "src"));
		writeFileSync(path.join(tmp, "src/a.ts"), "v1\n");

		const runOnce = async (): Promise<RunOutcome> => {
			throw new Error("simulated runOnce failure");
		};

		const ac = new AbortController();
		const promise = runWatch(
			{
				root: tmp,
				include: ["src/**/*.ts"],
				exclude: [],
				debounceMs: 30,
				signal: ac.signal,
			},
			runOnce,
		);

		await nextTick(50);
		ac.abort();
		const outcome = await promise;

		expect(outcome.exitCode).toBe(0);
		expect(outcome.summary).toBeDefined();
	}, 5000);
});
