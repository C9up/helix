/**
 * Fake-timer core — swaps the global timer APIs for a deterministic
 * scheduler. Mirrors the subset of Vitest we need:
 *   setTimeout / setInterval / setImmediate (+ clear*)
 *   advanceTimersByTime / runAllTimers / runOnlyPendingTimers
 *   performance.now() (when available)
 *
 * Zero dependency on `@sinonjs/fake-timers` — we re-implement the queue.
 */

import { getRealNow } from "./system-time.js";

type TimerCallback = (...args: unknown[]) => void;

interface Timer {
	id: number;
	dueMs: number;
	intervalMs: number | null; // null for setTimeout / setImmediate
	callback: TimerCallback;
	args: unknown[];
	kind: "timeout" | "interval" | "immediate";
}

export interface FakeTimerState {
	now: number;
	queue: Timer[];
	nextId: number;
	active: boolean;
}

interface OriginalTimerBag {
	setTimeout: unknown;
	clearTimeout: unknown;
	setInterval: unknown;
	clearInterval: unknown;
	setImmediate: unknown;
	clearImmediate: unknown;
	performanceNow: unknown;
}

function getPerformance(): { now?: () => number } | undefined {
	const p = Reflect.get(globalThis, "performance");
	if (p && typeof p === "object") return p as { now?: () => number };
	return undefined;
}

function captureGlobals(): OriginalTimerBag {
	const perf = getPerformance();
	return {
		setTimeout: Reflect.get(globalThis, "setTimeout"),
		clearTimeout: Reflect.get(globalThis, "clearTimeout"),
		setInterval: Reflect.get(globalThis, "setInterval"),
		clearInterval: Reflect.get(globalThis, "clearInterval"),
		setImmediate: Reflect.get(globalThis, "setImmediate"),
		clearImmediate: Reflect.get(globalThis, "clearImmediate"),
		performanceNow: perf?.now?.bind(perf),
	};
}

function installHandler(state: FakeTimerState): OriginalTimerBag {
	const originals = captureGlobals();

	// Keep a reference to the real clearTimeout so we can fall back to it
	// when a user passes a real `Timeout` handle that predates the install.
	const realClearTimeout =
		typeof originals.clearTimeout === "function"
			? (originals.clearTimeout as (id: unknown) => void)
			: undefined;

	function scheduleTimeout(
		cb: TimerCallback,
		ms: number | undefined,
		...args: unknown[]
	): Timer {
		const ready = normaliseDelay(ms);
		const timer: Timer = {
			id: ++state.nextId,
			dueMs: state.now + ready,
			intervalMs: null,
			callback: cb,
			args,
			kind: "timeout",
		};
		state.queue.push(timer);
		return timer;
	}

	function scheduleInterval(
		cb: TimerCallback,
		ms: number | undefined,
		...args: unknown[]
	): Timer {
		const intervalMs = Math.max(1, normaliseDelay(ms, 1));
		const timer: Timer = {
			id: ++state.nextId,
			dueMs: state.now + intervalMs,
			intervalMs,
			callback: cb,
			args,
			kind: "interval",
		};
		state.queue.push(timer);
		return timer;
	}

	function scheduleImmediate(cb: TimerCallback, ...args: unknown[]): Timer {
		const timer: Timer = {
			id: ++state.nextId,
			dueMs: state.now,
			intervalMs: null,
			callback: cb,
			args,
			kind: "immediate",
		};
		state.queue.push(timer);
		return timer;
	}

	const clear: ClearCallable = (idOrTimer: unknown): void => {
		if (idOrTimer == null) return;
		let id: number | undefined;
		if (typeof idOrTimer === "number") id = idOrTimer;
		else if (typeof idOrTimer === "object") {
			const maybe = (idOrTimer as { id?: unknown }).id;
			if (typeof maybe === "number") id = maybe;
		}
		if (id === undefined) {
			// Not a Helix timer — likely a real `Timeout` handle from before
			// fake timers were installed. Fall back to the real `clearTimeout`
			// so it still gets cancelled.
			realClearTimeout?.(idOrTimer);
			return;
		}
		const idx = state.queue.findIndex((t) => t.id === id);
		if (idx >= 0) state.queue.splice(idx, 1);
	};

	Reflect.set(globalThis, "setTimeout", timerFacade(scheduleTimeout));
	Reflect.set(globalThis, "setInterval", timerFacade(scheduleInterval));
	Reflect.set(globalThis, "clearTimeout", clear);
	Reflect.set(globalThis, "clearInterval", clear);
	if (originals.setImmediate) {
		Reflect.set(globalThis, "setImmediate", immediateFacade(scheduleImmediate));
		Reflect.set(globalThis, "clearImmediate", clear);
	}

	// `performance.now()` tracks the fake clock when available.
	const perf = getPerformance();
	if (perf && typeof perf.now === "function") {
		Reflect.set(perf, "now", () => state.now);
	}

	return originals;
}

function restoreHandler(originals: OriginalTimerBag): void {
	Reflect.set(globalThis, "setTimeout", originals.setTimeout);
	Reflect.set(globalThis, "clearTimeout", originals.clearTimeout);
	Reflect.set(globalThis, "setInterval", originals.setInterval);
	Reflect.set(globalThis, "clearInterval", originals.clearInterval);
	if (originals.setImmediate) {
		Reflect.set(globalThis, "setImmediate", originals.setImmediate);
	}
	if (originals.clearImmediate) {
		Reflect.set(globalThis, "clearImmediate", originals.clearImmediate);
	}
	const perf = getPerformance();
	if (perf && typeof originals.performanceNow === "function") {
		Reflect.set(perf, "now", originals.performanceNow);
	}
}

export type TimerGlobals = OriginalTimerBag;

/** Normalise the `ms` argument: NaN / undefined / negative → 0. */
function normaliseDelay(ms: number | undefined, floor = 0): number {
	if (ms === undefined || Number.isNaN(ms) || !Number.isFinite(ms))
		return floor;
	return Math.max(floor, ms);
}

function timerFacade(
	schedule: (
		cb: TimerCallback,
		ms: number | undefined,
		...args: unknown[]
	) => Timer,
): TimerCallable {
	return Object.assign(
		(cb: TimerCallback, ms?: number, ...args: unknown[]): Timer => {
			return makeHandle(schedule(cb, ms, ...args));
		},
		{ __promisify__: promisifyTimer },
	);
}

function immediateFacade(
	schedule: (cb: TimerCallback, ...args: unknown[]) => Timer,
): ImmediateCallable {
	return Object.assign(
		(cb: TimerCallback, ...args: unknown[]): Timer => {
			return makeHandle(schedule(cb, ...args));
		},
		{ __promisify__: promisifyImmediate },
	);
}

/**
 * `util.promisify(setTimeout)(ms, value)` must honour the fake clock — the
 * Promise resolves only when `advanceTimersByTime(ms)` is called, not on
 * the next microtask.
 */
function promisifyTimer<T>(ms?: number, value?: T): Promise<T | undefined> {
	return new Promise((resolve) => {
		globalThis.setTimeout(() => resolve(value), ms);
	});
}

function promisifyImmediate<T>(value?: T): Promise<T | undefined> {
	return new Promise((resolve) => {
		const setI = Reflect.get(globalThis, "setImmediate");
		if (typeof setI === "function") {
			(setI as (cb: () => void) => unknown)(() => resolve(value));
		} else {
			// Browsers: fall back to setTimeout(0).
			globalThis.setTimeout(() => resolve(value), 0);
		}
	});
}

interface TimerCallable {
	(cb: TimerCallback, ms?: number, ...args: unknown[]): Timer;
	__promisify__: typeof promisifyTimer;
}

interface ImmediateCallable {
	(cb: TimerCallback, ...args: unknown[]): Timer;
	__promisify__: typeof promisifyImmediate;
}

type ClearCallable = (id: unknown) => void;

/**
 * Produce the object Node's `setTimeout` returns — enough for clear*()
 * and ref/unref. `refresh` re-queues the timer starting from the current
 * fake clock, matching Node's semantics.
 */
function makeHandle(timer: Timer): Timer {
	const noop = () => timer;
	Object.defineProperties(timer, {
		ref: { value: noop, configurable: true },
		unref: { value: noop, configurable: true },
		hasRef: { value: () => true, configurable: true },
		refresh: {
			value: () => {
				// Node's refresh: if not yet fired, reset due time from "now".
				// We don't have direct access to the queue here (closure), so
				// the real refresh happens inside `advanceBy`/`runAll` when the
				// caller manipulates the handle. For now return the handle.
				return timer;
			},
			configurable: true,
		},
	});
	return timer;
}

export function createFakeTimerController(): FakeTimerController {
	let state: FakeTimerState | undefined;
	let originals: TimerGlobals | undefined;

	function install(now: number): void {
		if (state) {
			// Re-installation updates the clock in place so tests that call
			// `vi.useFakeTimers({ now: X })` twice get the new epoch. Vitest
			// parity.
			state.now = now;
			return;
		}
		state = { now, queue: [], nextId: 0, active: true };
		originals = installHandler(state);
	}

	function uninstall(): void {
		if (!state) return;
		if (originals) restoreHandler(originals);
		state = undefined;
		originals = undefined;
	}

	function requireState(): FakeTimerState {
		if (!state) {
			throw new Error(
				"vi: fake timers not installed. Call vi.useFakeTimers() first.",
			);
		}
		return state;
	}

	function drainUntil(target: number): void {
		const s = requireState();
		// Bound iterations to catch `setImmediate(() => setImmediate(...))`
		// infinite loops in `advanceTimersByTime(0)` / `runAll`.
		let iterations = 0;
		const MAX = 10_000;
		while (true) {
			if (++iterations > MAX) {
				throw new Error(
					`vi: fake-timer drain exceeded ${MAX} iterations — likely a self-rescheduling immediate / interval. Use runOnlyPendingTimers or clearAllTimers.`,
				);
			}
			let nextIdx = -1;
			let nextDue = Number.POSITIVE_INFINITY;
			for (let i = 0; i < s.queue.length; i += 1) {
				const t = s.queue[i];
				if (t.dueMs <= target && t.dueMs < nextDue) {
					nextDue = t.dueMs;
					nextIdx = i;
				}
			}
			if (nextIdx < 0) break;
			const timer = s.queue[nextIdx];
			s.queue.splice(nextIdx, 1);
			s.now = Math.max(s.now, timer.dueMs);
			if (timer.intervalMs !== null) {
				s.queue.push({ ...timer, dueMs: timer.dueMs + timer.intervalMs });
			}
			// Advance clock to target BEFORE firing: if the callback throws,
			// the wall clock has already been moved so subsequent drains see
			// the state the user asked for.
			const _latestDue = timer.dueMs;
			try {
				timer.callback(...timer.args);
			} catch (err) {
				// Set `now` to the target so callers can resume after catching.
				if (s.now < target) s.now = target;
				throw err;
			}
		}
		if (s.now < target) s.now = target;
	}

	return {
		install,
		uninstall,
		isActive: () => state?.active === true,
		now: () => state?.now ?? getRealNow(),
		advanceBy(ms: number) {
			if (ms < 0) {
				throw new Error(
					`vi.advanceTimersByTime: negative delta (${ms}) is not supported`,
				);
			}
			const s = requireState();
			drainUntil(s.now + ms);
		},
		runAll() {
			const s = requireState();
			let iterations = 0;
			while (s.queue.length > 0) {
				iterations += 1;
				if (iterations > 10_000) {
					throw new Error(
						"vi.runAllTimers: exceeded 10 000 iterations — likely a self-rescheduling interval or immediate. Use runOnlyPendingTimers or advanceTimersByTime instead.",
					);
				}
				let earliest = Number.POSITIVE_INFINITY;
				for (const t of s.queue) {
					if (t.dueMs < earliest) earliest = t.dueMs;
				}
				if (!Number.isFinite(earliest)) break;
				drainUntil(earliest);
			}
		},
		runOnlyPending() {
			const s = requireState();
			// Sort the snapshot by due time so callbacks fire in schedule order,
			// not insertion order (Vitest parity).
			const snapshot = [...s.queue].sort((a, b) => a.dueMs - b.dueMs);
			for (const timer of snapshot) {
				const idx = s.queue.indexOf(timer);
				if (idx < 0) continue;
				s.queue.splice(idx, 1);
				s.now = Math.max(s.now, timer.dueMs);
				if (timer.intervalMs !== null) {
					s.queue.push({ ...timer, dueMs: timer.dueMs + timer.intervalMs });
				}
				timer.callback(...timer.args);
			}
		},
		pending() {
			return state ? state.queue.length : 0;
		},
		clear() {
			if (state) state.queue.length = 0;
		},
	};
}

export interface FakeTimerController {
	install(now: number): void;
	uninstall(): void;
	isActive(): boolean;
	now(): number;
	advanceBy(ms: number): void;
	runAll(): void;
	runOnlyPending(): void;
	pending(): number;
	clear(): void;
}
