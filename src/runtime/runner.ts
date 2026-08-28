/**
 * The `runner` handed to plugins — helix's `Runner`, minus what a worker cannot
 * honestly own.
 *
 * Present, and identical to helix: `getSummary()`, `failed`, `bail(toggle)`,
 * `onSuite(callback)`. The summary is tracked by subscribing to the very events
 * the runtime emits, so it can never drift from what a reporter sees.
 *
 * `registerReporter` works, with its scope stated: a helix reporter is
 * `(runner, emitter) => void`, and the emitter it gets is this worker's, which
 * sees this worker's FILE. That is what a worker can honestly offer, and it
 * beats the alternative — the method being absent, so a plugin calling it
 * dies on a `TypeError` with nothing explaining why. Run-wide output stays the
 * CLI's job: `--reporters`, or `run({ reporterInstance })`.
 *
 * `add` / `start` / `exec` / `end` THROW instead of being absent, for the same
 * reason: they drive execution, which the CLI owns, and a plugin reaching for
 * them deserves a sentence rather than a missing-property crash.
 */

import { type Emitter, emitter } from "./emitter.js";
import { currentSuite, type SuiteHandle, setBail } from "./suite-taps.js";

/** A helix reporter: a handler, or a named one wrapping it. */
export type ReporterHandler = (
	runner: Runner,
	emitter: Emitter,
) => void | Promise<void>;

export type ReporterContract =
	| ReporterHandler
	| { readonly name: string; handler: ReporterHandler };

/**
 * Raised when a plugin drives the runner. The CLI owns discovery and execution;
 * a worker is handed one file and told to run it. Thrown rather than left
 * absent so the plugin gets a sentence instead of a missing-property crash.
 */
export class RunnerNotDrivableError extends Error {
	constructor(method: string) {
		super(
			`runner.${method}() is not available: helix runs one process per test ` +
				"file, so the CLI owns discovery and execution and a worker only runs " +
				"the file it was given. Reporting is the CLI's too — use `--reporters` " +
				"or `run({ reporterInstance })`.",
		);
		this.name = "RunnerNotDrivableError";
	}
}

/** Test counts for a run (`summary.aggregates`). */
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

	/** Whether anything has failed so far (`Runner#failed`). */
	get failed(): boolean {
		return this.#hasError || this.#aggregates.failed > 0;
	}

	/**
	 * Stop at the first failure (`Runner#bail`). A plugin runs before the
	 * test file is collected, so this reaches the run it was called for; the
	 * `--bail` flag still wins when both are set.
	 */
	bail(toggle = true): this {
		setBail(toggle);
		return this;
	}

	/**
	 * Configure the suite before it runs (`Runner#onSuite`). helix calls the
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
	 * Register a helix reporter (`Runner#registerReporter`). It is handed
	 * this runner and this worker's emitter, so it observes THIS FILE — the
	 * whole run is only visible from the CLI process.
	 */
	registerReporter(reporter: ReporterContract): this {
		const handler =
			typeof reporter === "function" ? reporter : reporter.handler;
		void handler(this, emitter);
		return this;
	}

	/** The suites this worker runs — exactly one (`Runner#suites`). */
	get suites(): SuiteHandle[] {
		const suite = currentSuite();
		return suite === undefined ? [] : [suite];
	}

	/** Not available — see {@link RunnerNotDrivableError}. */
	add(): never {
		throw new RunnerNotDrivableError("add");
	}

	/** Not available — see {@link RunnerNotDrivableError}. */
	start(): never {
		throw new RunnerNotDrivableError("start");
	}

	/** Not available — see {@link RunnerNotDrivableError}. */
	exec(): never {
		throw new RunnerNotDrivableError("exec");
	}

	/** Not available — see {@link RunnerNotDrivableError}. */
	end(): never {
		throw new RunnerNotDrivableError("end");
	}

	/**
	 * The run's summary. Meaningful once `runner:end` has fired — the point a
	 * helix reporter reads it from.
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
