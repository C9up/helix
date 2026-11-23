/**
 * Every refusal helix raises carries a stable `code`, so a caller can branch
 * on it instead of on a message. Each case below triggers the real refusal.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { finaliseDiff } from "../../src/cli/coverage/diff/index.js";
import { enforce } from "../../src/cli/coverage/thresholds.js";
import type { CoverageSummary } from "../../src/cli/coverage/types.js";
import { globToRegExp } from "../../src/cli/glob.js";
import type { Reporter } from "../../src/cli/reporter.js";
import { run } from "../../src/cli/run.js";
import { createWatcher } from "../../src/cli/watch/watcher.js";
import {
	clearActiveContainer,
	override,
} from "../../src/container/override.js";
import { errors } from "../../src/index.js";
import { expect as helixExpect } from "../../src/runtime/expect.js";
import { executeRoot, thrownValue } from "../../src/runtime/run.js";
import {
	describe as helixDescribe,
	test as helixTest,
	resetRoot,
} from "../../src/runtime/suite.js";
import {
	getActiveTestOrFail,
	withTestContext,
} from "../../src/runtime/test-context.js";
import { resetFallbackState, vi } from "../../src/runtime/vi/index.js";
import { runTestFile } from "../../src/runtime/worker.js";
import { freeze, travel } from "../../src/time/freeze.js";
import { defined } from "../__helpers__/defined.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const emptyCoverage: CoverageSummary = {
	files: [],
	total: {
		lines: { covered: 0, total: 0, pct: 100 },
		statements: { covered: 0, total: 0, pct: 100 },
		functions: { covered: 0, total: 0, pct: 100 },
		branches: { covered: 0, total: 0, pct: 100 },
	},
};

const silentReporter: Reporter = {
	onFileStart() {},
	onFileResult() {},
	onFileError() {},
	onSummary() {},
};

describe("helix error codes — configuration", () => {
	it("E_HELIX_INVALID_COVERAGE_THRESHOLD: a threshold outside 0–100", () => {
		expect(() => enforce(emptyCoverage, { lines: 120 })).toThrow(
			expect.objectContaining({ code: "E_HELIX_INVALID_COVERAGE_THRESHOLD" }),
		);
		expect(() => enforce(emptyCoverage, { lines: Number.NaN })).toThrow(
			expect.objectContaining({ code: "E_HELIX_INVALID_COVERAGE_THRESHOLD" }),
		);
	});

	it("E_HELIX_INVALID_COVERAGE_THRESHOLD: a diff threshold diff mode cannot gate", async () => {
		await expect(
			finaliseDiff({
				enabled: true,
				root: os.tmpdir(),
				coverage: emptyCoverage,
				thresholds: { branches: 80 },
			}),
		).rejects.toMatchObject({ code: "E_HELIX_INVALID_COVERAGE_THRESHOLD" });
	});

	it("E_HELIX_INVALID_GLOB: an unbalanced glob", () => {
		expect(() => globToRegExp("{a,b")).toThrow(errors.E_HELIX_INVALID_GLOB);
		expect(() => globToRegExp("{a,b")).toThrow(
			expect.objectContaining({ code: "E_HELIX_INVALID_GLOB" }),
		);
	});

	it("E_HELIX_INVALID_DIFF_COVERAGE: diff coverage without coverage, or a disjoint cwd", async () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "helix-codes-"));
		const other = mkdtempSync(path.join(os.tmpdir(), "helix-codes-other-"));
		try {
			await expect(
				run({
					root: tmp,
					files: [],
					threads: 1,
					reporterInstance: silentReporter,
					diffCoverage: { enabled: true },
				}),
			).rejects.toMatchObject({ code: "E_HELIX_INVALID_DIFF_COVERAGE" });
			await expect(
				run({
					root: tmp,
					files: [],
					threads: 1,
					reporterInstance: silentReporter,
					coverage: {
						enabled: true,
						reporters: [],
						outputDir: path.join(tmp, "coverage"),
						root: tmp,
					},
					diffCoverage: { enabled: true, cwd: other },
				}),
			).rejects.toMatchObject({ code: "E_HELIX_INVALID_DIFF_COVERAGE" });
		} finally {
			rmSync(tmp, { recursive: true, force: true });
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("E_HELIX_INVALID_WATCH_OPTIONS / E_HELIX_WATCH_FAILED: watcher misuse", () => {
		const base = {
			root: os.tmpdir(),
			include: ["**/*.ts"],
			exclude: [],
			debounceMs: 50,
			onChange: () => {},
		};
		expect(() => createWatcher({ ...base, include: [] })).toThrow(
			expect.objectContaining({ code: "E_HELIX_INVALID_WATCH_OPTIONS" }),
		);
		expect(() => createWatcher({ ...base, debounceMs: -1 })).toThrow(
			expect.objectContaining({ code: "E_HELIX_INVALID_WATCH_OPTIONS" }),
		);
		expect(() =>
			createWatcher({
				...base,
				root: path.join(os.tmpdir(), "helix-codes-missing-dir", "nope"),
			}),
		).toThrow(expect.objectContaining({ code: "E_HELIX_WATCH_FAILED" }));
	});

	it("E_HELIX_INVALID_THREADS: a thread count that is not a number", async () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "helix-codes-threads-"));
		try {
			await expect(
				run({
					root: tmp,
					files: [path.join(here, "../fixtures/orchestrator/fail.test.ts")],
					threads: Number.NaN,
					reporterInstance: silentReporter,
				}),
			).rejects.toMatchObject({ code: "E_HELIX_INVALID_THREADS" });
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("E_HELIX_RELATIVE_PATH: runTestFile with a relative path", async () => {
		await expect(runTestFile("tests/x.test.ts")).rejects.toMatchObject({
			code: "E_HELIX_RELATIVE_PATH",
		});
	});
});

describe("helix error codes — test context", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("E_HELIX_NO_ACTIVE_TEST: test-only helpers called outside a test", () => {
		expect(() => getActiveTestOrFail()).toThrow(
			expect.objectContaining({ code: "E_HELIX_NO_ACTIVE_TEST" }),
		);
		expect(() => freeze(0)).toThrow(
			expect.objectContaining({ code: "E_HELIX_NO_ACTIVE_TEST" }),
		);
		expect(() => override("token", 1)).toThrow(
			expect.objectContaining({ code: "E_HELIX_NO_ACTIVE_TEST" }),
		);
		const macro = helixTest.macro(() => 1);
		expect(() => macro()).toThrow(
			expect.objectContaining({ code: "E_HELIX_NO_ACTIVE_TEST" }),
		);
	});

	it("E_HELIX_NO_ACTIVE_CONTAINER: override with no container in use", async () => {
		await withTestContext(async () => {
			expect(() => override("token", 1)).toThrow(
				expect.objectContaining({ code: "E_HELIX_NO_ACTIVE_CONTAINER" }),
			);
		});
	});

	it("E_HELIX_INVALID_TIME: time travel with an unusable amount or date", async () => {
		await withTestContext(async () => {
			expect(() => travel(Number.NaN)).toThrow(
				expect.objectContaining({ code: "E_HELIX_INVALID_TIME" }),
			);
			expect(() => travel(1.5, "month")).toThrow(
				expect.objectContaining({ code: "E_HELIX_INVALID_TIME" }),
			);
			expect(() => freeze("not a date")).toThrow(
				expect.objectContaining({ code: "E_HELIX_INVALID_TIME" }),
			);
			expect(() => freeze(9e15)).toThrow(
				expect.objectContaining({ code: "E_HELIX_INVALID_TIME" }),
			);
		});
	});
});

describe("helix error codes — suite declaration", () => {
	it("E_HELIX_ASYNC_DESCRIBE: a describe body that returns a Promise", () => {
		resetRoot();
		expect(() => helixDescribe("async", async () => {})).toThrow(
			expect.objectContaining({ code: "E_HELIX_ASYNC_DESCRIBE" }),
		);
		resetRoot();
	});

	it("E_HELIX_NESTED_GROUP: a group inside a group", () => {
		resetRoot();
		expect(() =>
			helixTest.group("outer", () => {
				helixTest.group("inner", () => {});
			}),
		).toThrow(expect.objectContaining({ code: "E_HELIX_NESTED_GROUP" }));
		resetRoot();
	});
});

describe("helix error codes — test outcomes", () => {
	it("E_HELIX_TIMEOUT: a test that outlives its timeout", async () => {
		const root = resetRoot();
		helixTest("hangs", () => new Promise<void>(() => {}));
		const result = await executeRoot(root, "inline", { timeoutMs: 50 });
		const error = defined(defined(result.tests[0]).error);
		expect(thrownValue(error)).toMatchObject({ code: "E_HELIX_TIMEOUT" });
	});

	it("E_HELIX_TEST_ABORTED: meta.abort() fails the running test", async () => {
		const root = resetRoot();
		helixTest("aborts", (ctx) => {
			const abort = Reflect.get(ctx.test.options.meta, "abort");
			if (typeof abort === "function")
				Reflect.apply(abort, undefined, ["stop"]);
		});
		const result = await executeRoot(root, "inline", {});
		const error = defined(defined(result.tests[0]).error);
		expect(error.message).toBe("stop");
		expect(thrownValue(error)).toMatchObject({ code: "E_HELIX_TEST_ABORTED" });
	});

	it("E_HELIX_ASSERTION_FAILED: a failed expect()", () => {
		expect(() => helixExpect(1).toBe(2)).toThrow(
			errors.E_HELIX_ASSERTION_FAILED,
		);
		expect(() => helixExpect(1).toBe(2)).toThrow(
			expect.objectContaining({ code: "E_HELIX_ASSERTION_FAILED" }),
		);
	});
});

describe("helix error codes — vi", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.useRealSystemTime();
		vi.restoreAllMocks();
		resetFallbackState();
	});

	it("E_HELIX_FAKE_TIMERS_NOT_INSTALLED: advancing real timers", () => {
		expect(() => vi.advanceTimersByTime(10)).toThrow(
			expect.objectContaining({ code: "E_HELIX_FAKE_TIMERS_NOT_INSTALLED" }),
		);
	});

	it("E_HELIX_INVALID_TIME: a negative advance, or an unusable system time", () => {
		vi.useFakeTimers();
		expect(() => vi.advanceTimersByTime(-1)).toThrow(
			expect.objectContaining({ code: "E_HELIX_INVALID_TIME" }),
		);
		expect(() => vi.setSystemTime(Number.NaN)).toThrow(
			expect.objectContaining({ code: "E_HELIX_INVALID_TIME" }),
		);
	});

	it("E_HELIX_TIMER_LOOP: runAllTimers on a self-rescheduling interval", () => {
		vi.useFakeTimers();
		setInterval(() => {}, 1);
		expect(() => vi.runAllTimers()).toThrow(
			expect.objectContaining({ code: "E_HELIX_TIMER_LOOP" }),
		);
	});

	it("spyOn refusals carry their own codes", () => {
		const target = {
			fn(): number {
				return 1;
			},
			value: 1,
			get readOnly(): number {
				return 1;
			},
		};
		const loose: Record<string, unknown> = {};
		expect(() => vi.spyOn(loose, "missing")).toThrow(
			expect.objectContaining({ code: "E_HELIX_SPY_NO_PROPERTY" }),
		);
		expect(() => vi.spyOn(target, "value")).toThrow(
			expect.objectContaining({ code: "E_HELIX_SPY_NOT_FUNCTION" }),
		);
		expect(() => vi.spyOn(target, "readOnly", { accessor: "set" })).toThrow(
			expect.objectContaining({ code: "E_HELIX_SPY_NO_ACCESSOR" }),
		);
		vi.spyOn(target, "fn");
		expect(() => vi.spyOn(target, "fn")).toThrow(
			expect.objectContaining({ code: "E_HELIX_ALREADY_SPIED" }),
		);
	});
});
