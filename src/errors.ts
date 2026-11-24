/**
 * Helix errors, one per code. Every refusal helix raises carries a `code` in
 * the `E_HELIX_` namespace, so a caller (a plugin, a programmatic `run()`, a
 * test checking its own misuse) can branch on `error.code` or on
 * `instanceof errors.E_HELIX_…` instead of on a message.
 */
import { createError, Exception } from "@c9up/flare";

/** What a failed assertion carries for a reporter to render a diff. */
export interface AssertionErrorInit {
	message: string;
	actual?: unknown;
	expected?: unknown;
	operator?: string;
	showDiff?: boolean;
}

/**
 * Thrown by `expect` and `assert` when an assertion does not hold. Carries
 * structured fields so runners (Vitest-compatible reporters, IDE
 * integrations) can render diffs.
 */
export class E_HELIX_ASSERTION_FAILED extends Exception {
	static override code = "E_HELIX_ASSERTION_FAILED";

	readonly actual: unknown;
	readonly expected: unknown;
	readonly operator: string | undefined;
	readonly showDiff: boolean;

	constructor(init: AssertionErrorInit, options?: ErrorOptions) {
		super(init.message, options);
		// Reporters and IDE integrations recognise a failed assertion by this
		// name, as they do Vitest's and Chai's; the code says which runner.
		this.name = "AssertionError";
		this.actual = init.actual;
		this.expected = init.expected;
		this.operator = init.operator;
		this.showDiff = init.showDiff ?? true;
	}
}

/** A test, hook or file ran past its timeout. */
export const E_HELIX_TIMEOUT = createError<[string, number]>(
	"%s exceeded %dms timeout",
	"E_HELIX_TIMEOUT",
);

/** A test failed itself through `meta.abort(message)`. */
export const E_HELIX_TEST_ABORTED = createError<[string]>(
	"%s",
	"E_HELIX_TEST_ABORTED",
);

/**
 * A `.only` / `.pin()` reached a run that does not allow them (on CI, or
 * without `--allow-only`): the test fails instead of running, so a modifier
 * left in a commit cannot narrow the run to a green subset.
 */
export const E_HELIX_UNEXPECTED_ONLY = createError<[string]>(
	"Unexpected %s modifier. Remove it or pass --allow-only to bypass this error",
	"E_HELIX_UNEXPECTED_ONLY",
);

/**
 * A test file registered no test (often a typo, or tests registered on a
 * second copy of helix). `--pass-with-no-tests` accepts it.
 */
export const E_HELIX_NO_TEST_SUITE = createError<[string]>(
	"No test suite found in file %s",
	"E_HELIX_NO_TEST_SUITE",
);

/**
 * A plugin tried to drive the runner. The CLI owns discovery and execution; a
 * worker is handed one file and told to run it. Thrown rather than left absent
 * so the plugin gets a sentence instead of a missing-property crash.
 */
export const E_HELIX_RUNNER_NOT_DRIVABLE = createError<[string]>(
	"runner.%s() is not available: helix runs one process per test file, so the CLI owns discovery and execution and a worker only runs the file it was given. Reporting is the CLI's too — use `--reporters` or `run({ reporterInstance })`.",
	"E_HELIX_RUNNER_NOT_DRIVABLE",
);

/** A `describe` body returned a promise. */
export const E_HELIX_ASYNC_DESCRIBE = createError<[string]>(
	"describe(%s): body returned a Promise. Async describe is not supported — await the setup in a `beforeAll` hook instead.",
	"E_HELIX_ASYNC_DESCRIBE",
);

/** A `test.group()` declared inside another group. */
export const E_HELIX_NESTED_GROUP = createError<[string, string]>(
	'test.group("%s") cannot be nested inside group "%s" — helix does not allow nested groups.',
	"E_HELIX_NESTED_GROUP",
);

/** A test-scoped helper called while no test runs. */
export const E_HELIX_NO_ACTIVE_TEST = createError<[string]>(
	"%s",
	"E_HELIX_NO_ACTIVE_TEST",
);

/** `helix.override()` called before `helix.useContainer()`. */
export const E_HELIX_NO_ACTIVE_CONTAINER = createError(
	"helix.override: no active container. Call helix.useContainer(container) before invoking override(), or use overrideOn(container, token, value).",
	"E_HELIX_NO_ACTIVE_CONTAINER",
);

/** `runTestFile()` given a relative path. */
export const E_HELIX_RELATIVE_PATH = createError<[string]>(
	'runTestFile: expected absolute path, got "%s". Resolve against cwd or __dirname before calling.',
	"E_HELIX_RELATIVE_PATH",
);

/** `vi.spyOn()` on a property the target does not have. */
export const E_HELIX_SPY_NO_PROPERTY = createError<[string]>(
	'vi.spyOn: property "%s" does not exist on the target',
	"E_HELIX_SPY_NO_PROPERTY",
);

/** `vi.spyOn()` on a value that is already a spy. */
export const E_HELIX_ALREADY_SPIED = createError<[string]>(
	'vi.spyOn: "%s" is already a spy. Call mockRestore() before spying again.',
	"E_HELIX_ALREADY_SPIED",
);

/** `vi.spyOn()` asked for a getter or setter the property does not have. */
export const E_HELIX_SPY_NO_ACCESSOR = createError<[string]>(
	"%s",
	"E_HELIX_SPY_NO_ACCESSOR",
);

/** `vi.spyOn()` on a property that is not a function. */
export const E_HELIX_SPY_NOT_FUNCTION = createError<[string, string]>(
	'vi.spyOn: "%s" is not a function (got %s). Pass { accessor } for accessors.',
	"E_HELIX_SPY_NOT_FUNCTION",
);

/** A fake-timer call made before `vi.useFakeTimers()`. */
export const E_HELIX_FAKE_TIMERS_NOT_INSTALLED = createError(
	"vi: fake timers not installed. Call vi.useFakeTimers() first.",
	"E_HELIX_FAKE_TIMERS_NOT_INSTALLED",
);

/** A fake-timer drain that never ends. */
export const E_HELIX_TIMER_LOOP = createError<[string]>(
	"%s",
	"E_HELIX_TIMER_LOOP",
);

/** A time or date helix cannot use. */
export const E_HELIX_INVALID_TIME = createError<[string]>(
	"%s",
	"E_HELIX_INVALID_TIME",
);

/** A coverage threshold that is not a number from 0 to 100, or not supported. */
export const E_HELIX_INVALID_COVERAGE_THRESHOLD = createError<[string]>(
	"%s",
	"E_HELIX_INVALID_COVERAGE_THRESHOLD",
);

/** A diff-coverage config that cannot overlay the coverage. */
export const E_HELIX_INVALID_DIFF_COVERAGE = createError<[string]>(
	"%s",
	"E_HELIX_INVALID_DIFF_COVERAGE",
);

/** A file pattern that does not compile. */
export const E_HELIX_INVALID_GLOB = createError<[string]>(
	'Cannot read "%s" as a glob pattern — check that every {, ( and [ is closed.',
	"E_HELIX_INVALID_GLOB",
);

/** A worker count below 1. */
export const E_HELIX_INVALID_THREADS = createError<[string]>(
	"Semaphore: initial permits must be a finite number >= 1, got %s",
	"E_HELIX_INVALID_THREADS",
);

/** A watch option out of range. */
export const E_HELIX_INVALID_WATCH_OPTIONS = createError<[string]>(
	"%s",
	"E_HELIX_INVALID_WATCH_OPTIONS",
);

/** `fs.watch` failed on the watched root. */
export const E_HELIX_WATCH_FAILED = createError<[string, string]>(
	"createWatcher: fs.watch failed on %s: %s",
	"E_HELIX_WATCH_FAILED",
);

/**
 * A worker failed outside the tests: it could not start, sent a broken frame,
 * exited without a result, or exited in a way its result does not explain.
 * The pool reports it as a file error under this code.
 */
export const E_HELIX_WORKER_FAILED = createError<[string]>(
	"%s",
	"E_HELIX_WORKER_FAILED",
);

/**
 * The native engine is missing, stale or not built for this platform. The
 * message names the platform package to install; the load error is its
 * `cause`.
 */
export const E_HELIX_NATIVE_REQUIRED = createError<[string]>(
	"%s",
	"E_HELIX_NATIVE_REQUIRED",
);

/** An invariant of helix itself broke. */
export const E_HELIX_INTERNAL = createError<[string]>("%s", "E_HELIX_INTERNAL");
