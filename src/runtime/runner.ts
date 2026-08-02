/**
 * The `runner` handed to plugins — Japa's `Runner` reduced to the surface a
 * plugin actually consumes: `getSummary()`.
 *
 * Japa's Runner also owns suite registration and reporter activation. Helix
 * does neither here (the CLI owns file discovery and reporting, one process per
 * file), so exposing those would be dead API. What remains is real: the summary
 * is tracked by subscribing to the very events the runtime emits, so it can
 * never drift from what a reporter sees.
 */

import type { Emitter } from "./emitter.js";

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
