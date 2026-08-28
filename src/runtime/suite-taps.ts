/**
 * `suite.onTest()` / `suite.onGroup()` — the taps helix's `Suite` exposes to
 * `configureSuite`, so a bootstrap can configure every test or group of a suite
 * without touching the test files.
 *
 *     export const configureSuite = (suite) => {
 *       if (suite.name === "e2e") suite.onTest((test) => test.timeout(30_000))
 *     }
 *
 * `configureSuite` runs before the test file is imported, so the callbacks are
 * stored and applied to the collected tree just before execution — the same
 * point at which helix's taps fire (each test, once, before it runs).
 *
 * Each method maps onto a field the collection tree already carries; nothing
 * here is a facade over behaviour helix does not have. helix `Test` members that
 * belong to EXECUTION rather than configuration — `run`, `exec`, `context`,
 * `executed`, `failed`, `options` — are absent: helix owns execution, and a
 * handle that pretended otherwise would be lying about what a callback can do.
 */

import type { Runner } from "./runner.js";
import type { SuiteNode, TestNode } from "./suite.js";

/** A hook body, as `test.setup()` / `group.setup()` take it. */
type Handler = () => void | Promise<void>;

/** How `test.tags()` combines with the tags already declared. */
export type TagStrategy = "replace" | "append" | "prepend";

/** The helix `Test` surface a tap can configure. */
export interface TestHandle {
	/** The declared title. */
	readonly title: string;
	skip(
		skip?: boolean | (() => boolean | Promise<boolean>),
		reason?: string,
	): TestHandle;
	fails(reason?: string): TestHandle;
	timeout(ms: number): TestHandle;
	disableTimeout(): TestHandle;
	resetTimeout(ms?: number): TestHandle;
	tags(tags: string[], strategy?: TagStrategy): TestHandle;
	retry(retries: number): TestHandle;
	waitForDone(): TestHandle;
	pin(): TestHandle;
	setup(handler: Handler): TestHandle;
	teardown(handler: Handler): TestHandle;
}

/** The helix `Group` surface a tap can configure. */
export interface GroupHandle {
	/** The declared title. */
	readonly title: string;
	/** Configure every test of this group (`group.tap`). */
	tap(callback: (test: TestHandle) => void): GroupHandle;
	setup(handler: Handler): GroupHandle;
	teardown(handler: Handler): GroupHandle;
	/** Per-test hooks and defaults — helix `group.each`. */
	readonly each: {
		setup(handler: Handler): void;
		teardown(handler: Handler): void;
		timeout(ms: number): void;
		retry(retries: number): void;
	};
}

export function testHandle(node: TestNode): TestHandle {
	const handle: TestHandle = {
		get title(): string {
			return node.name;
		},
		skip(skip = true, reason) {
			if (typeof skip === "function") node.skipCondition = skip;
			else node.mode = skip ? "skip" : "run";
			if (reason !== undefined) node.reason = reason;
			return handle;
		},
		fails(reason) {
			node.failing = true;
			if (reason !== undefined) node.reason = reason;
			return handle;
		},
		timeout(ms) {
			node.timeoutMs = ms;
			return handle;
		},
		disableTimeout() {
			node.timeoutMs = 0;
			return handle;
		},
		resetTimeout(ms) {
			node.timeoutMs = ms ?? 0;
			return handle;
		},
		tags(tags, strategy = "replace") {
			const current = node.tags ?? [];
			node.tags =
				strategy === "append"
					? [...current, ...tags]
					: strategy === "prepend"
						? [...tags, ...current]
						: [...tags];
			return handle;
		},
		retry(retries) {
			node.retries = retries;
			return handle;
		},
		waitForDone() {
			node.waitForDone = true;
			return handle;
		},
		pin() {
			node.pinned = true;
			return handle;
		},
		setup(fn) {
			node.setups ??= [];
			node.setups.push(fn);
			return handle;
		},
		teardown(fn) {
			node.teardowns ??= [];
			node.teardowns.push(fn);
			return handle;
		},
	};
	return handle;
}

export function groupHandle(node: SuiteNode): GroupHandle {
	const handle: GroupHandle = {
		get title(): string {
			return node.name;
		},
		tap(callback) {
			for (const child of node.children) {
				if (child.kind === "test") callback(testHandle(child));
			}
			return handle;
		},
		setup(fn) {
			node.hooks.push({ type: "beforeAll", fn });
			return handle;
		},
		teardown(fn) {
			node.hooks.push({ type: "afterAll", fn });
			return handle;
		},
		each: {
			setup(fn) {
				node.hooks.push({ type: "beforeEach", fn });
			},
			teardown(fn) {
				node.hooks.push({ type: "afterEach", fn });
			},
			timeout(ms) {
				node.eachTimeout = ms;
			},
			retry(retries) {
				node.eachRetries = retries;
			},
		},
	};
	return handle;
}

/**
 * What a `setup` hook may return so it gets undone afterwards — helix's
 * `@poppinss/hooks` cleanup handler, called with `(error, runner)`.
 */
export type SuiteHookCleanup = (
	error: Error | null,
	runner: Runner,
) => void | Promise<void>;

/**
 * A run-level hook, as `suite.setup()` / `suite.teardown()` take it.
 *
 * The API hands it the `runner`, and lets a `setup` hook RETURN its own undo — the
 * idiom AdonisJS is written in (`setup: [() => testUtils.db().migrate()]`,
 * where `migrate()` resolves to the rollback). Both are honoured.
 *
 * The `Runner` import is type-only, so this module stays a leaf at runtime even
 * though `runner.ts` imports it.
 */
export type SuiteHook =
	| ((runner: Runner) => void | Promise<void>)
	| ((runner: Runner) => SuiteHookCleanup | Promise<SuiteHookCleanup>);

/**
 * What `configureSuite` and `runner.onSuite` receive — helix's `Suite`, minus
 * the members that only make sense to whoever OWNS execution (`add`, `stack`,
 * `exec`, `failed`): helix builds the tree from the file's own `describe`/`test`
 * and runs it itself, so a handle exposing those would be lying about what a
 * callback can do. Everything a callback can genuinely configure is here.
 */
export interface SuiteHandle {
	/** The suite these files belong to (`--suite`, or a `helix.config` suite). */
	readonly name: string;
	/** Run before this suite's tests. */
	setup(fn: SuiteHook): SuiteHandle;
	/** Run after this suite's tests, in reverse registration order. */
	teardown(fn: SuiteHook): SuiteHandle;
	/** Configure every test of the suite before it runs (`Suite#onTest`). */
	onTest(callback: (test: TestHandle) => void): SuiteHandle;
	/** Configure every group of the suite before it runs (`Suite#onGroup`). */
	onGroup(callback: (group: GroupHandle) => void): SuiteHandle;
	/** Stop this suite at the first failure (`Suite#bail`). */
	bail(toggle?: boolean): SuiteHandle;
}

/**
 * A handle whose `setup`/`teardown` append to the given arrays — the caller
 * owns when those hooks run, so the same handle serves the bootstrap's
 * `configureSuite` and a plugin's `runner.onSuite`.
 */
export function makeSuiteHandle(
	name: string,
	setup: SuiteHook[],
	teardown: SuiteHook[],
): SuiteHandle {
	const handle: SuiteHandle = {
		name,
		setup(fn) {
			setup.push(fn);
			return handle;
		},
		teardown(fn) {
			teardown.push(fn);
			return handle;
		},
		onTest(callback) {
			registerTestTap(callback);
			return handle;
		},
		onGroup(callback) {
			registerGroupTap(callback);
			return handle;
		},
		bail(toggle = true) {
			setBail(toggle);
			return handle;
		},
	};
	return handle;
}

/**
 * The suite the current `configure()` call is running for. Set before plugins
 * run so `runner.onSuite` has something to hand back — a worker runs exactly
 * one suite, so helix's "called once per suite" is "called once".
 */
let current: SuiteHandle | undefined;

export function setCurrentSuite(handle: SuiteHandle | undefined): void {
	current = handle;
}

export function currentSuite(): SuiteHandle | undefined {
	return current;
}

/**
 * Callbacks registered before the file is imported (`configureSuite`, and a
 * plugin reaching for `runner.bail`), applied once the tree exists. Process-wide,
 * like the rest of the bootstrap state.
 */
const taps: {
	onTest: Array<(test: TestHandle) => void>;
	onGroup: Array<(group: GroupHandle) => void>;
	bail?: boolean;
} = { onTest: [], onGroup: [] };

/** Register a per-test tap (`Suite#onTest`). */
export function registerTestTap(callback: (test: TestHandle) => void): void {
	taps.onTest.push(callback);
}

/** Register a per-group tap (`Suite#onGroup`). */
export function registerGroupTap(callback: (group: GroupHandle) => void): void {
	taps.onGroup.push(callback);
}

/** Ask this suite to stop at the first failure (`Suite#bail`). */
export function setBail(toggle: boolean): void {
	taps.bail = toggle;
}

/** Whether a tap asked for bail; `undefined` leaves the CLI flag in charge. */
export function tappedBail(): boolean | undefined {
	return taps.bail;
}

/** Test seam: drop every registered tap. */
export function resetTaps(): void {
	taps.onTest.length = 0;
	taps.onGroup.length = 0;
	taps.bail = undefined;
	current = undefined;
}

/**
 * Walk the collected tree, handing every test to the `onTest` taps and every
 * group to the `onGroup` ones. Depth-first in declaration order, so a tap sees
 * the tests in the order they will run.
 */
export function applyTaps(root: SuiteNode): void {
	if (taps.onTest.length === 0 && taps.onGroup.length === 0) return;
	const walk = (node: SuiteNode): void => {
		for (const child of node.children) {
			if (child.kind === "test") {
				for (const callback of taps.onTest) callback(testHandle(child));
				continue;
			}
			for (const callback of taps.onGroup) callback(groupHandle(child));
			walk(child);
		}
	};
	walk(root);
}
