/**
 * The `runner` handed to plugins — Japa's `Runner`, minus what a worker cannot
 * honestly own.
 *
 * Present, and identical to Japa: `getSummary()`, `failed`, `bail(toggle)`,
 * `onSuite(callback)`. The summary is tracked by subscribing to the very events
 * the runtime emits, so it can never drift from what a reporter sees.
 *
 * Absent, deliberately:
 *   - `registerReporter` — reporters live in the CLI process, which is the only
 *     one that sees every file. A reporter registered from a worker would
 *     report one file and claim to be the run. Use `--reporters`, or
 *     `run({ reporterInstance })` programmatically.
 *   - `add` / `suites` / `start` / `exec` / `end` — the CLI discovers the files
 *     and drives execution; a worker is handed one file to run.
 */

import type { Emitter } from "./emitter.js";
import { currentSuite, type SuiteHandle, setBail } from "./suite-taps.js";

/** Test counts for a run (Japa `summary.aggregates`). */
export interface SummaryAggregates {
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	todo: number;
}

/** What `runner.getSummary()` returns. */
export interface RunnerSummary {
	aggregates: SummaryAggregates;
	hasError: boolean;
	/** Wall-clock duration of the run in ms; `0` until `runner:end`. */
	duration: number;
	/** Full titles of the tests that failed. */
	failedTestsTitles: string[];
}

/**
 * Tracks a run by listening to the emitter, and answers `getSummary()`. One
 * instance per process, wired to the process-wide emitter.
 */
export class Runner {
	readonly #aggregates: SummaryAggregates = {
		total: 0,
		passed: 0,
		failed: 0,
		skipped: 0,
		todo: 0,
	};
	readonly #failedTestsTitles: string[] = [];
	#hasError = false;
	#duration = 0;
	#startedAt = 0;

	constructor(emitter: Emitter) {
		emitter.on("runner:start", () => {
			// A run starts from zero. The IPC worker mode runs several files in one
			// process, and a summary must describe the file it belongs to.
			this.#reset();
			this.#startedAt = Date.now();
		});
		emitter.on("test:end", (test) => {
			this.#aggregates.total += 1;
			if (test.hasError) {
				this.#aggregates.failed += 1;
				this.#failedTestsTitles.push(test.title.expanded);
			} else if (test.isTodo === true) {
				this.#aggregates.todo += 1;
			} else if (test.isSkipped === true) {
				this.#aggregates.skipped += 1;
			} else {
				this.#aggregates.passed += 1;
			}
		});
		emitter.on("runner:end", (payload) => {
			this.#hasError = payload.hasError;
			this.#duration = Date.now() - this.#startedAt;
		});
	}

	/** Zero the counters — called when a run starts. */
	#reset(): void {
		this.#aggregates.total = 0;
		this.#aggregates.passed = 0;
		this.#aggregates.failed = 0;
		this.#aggregates.skipped = 0;
		this.#aggregates.todo = 0;
		this.#failedTestsTitles.length = 0;
		this.#hasError = false;
		this.#duration = 0;
	}

	/** Whether anything has failed so far (Japa `Runner#failed`). */
	get failed(): boolean {
		return this.#hasError || this.#aggregates.failed > 0;
	}

	/**
	 * Stop at the first failure (Japa `Runner#bail`). A plugin runs before the
	 * test file is collected, so this reaches the run it was called for; the
	 * `--bail` flag still wins when both are set.
	 */
	bail(toggle = true): this {
		setBail(toggle);
		return this;
	}

	/**
	 * Configure the suite before it runs (Japa `Runner#onSuite`). Japa calls the
	 * callback once per suite; a worker runs exactly one, so it is called once,
	 * immediately — plugins run before the suite's hooks, so what the callback
	 * registers still takes effect.
	 */
	onSuite(callback: (suite: SuiteHandle) => void): this {
		const suite = currentSuite();
		if (suite) callback(suite);
		return this;
	}

	/**
	 * The run's summary. Meaningful once `runner:end` has fired — the point a
	 * Japa reporter reads it from.
	 */
	getSummary(): RunnerSummary {
		return {
			aggregates: { ...this.#aggregates },
			hasError: this.#hasError,
			duration: this.#duration,
			failedTestsTitles: [...this.#failedTestsTitles],
		};
	}
}
