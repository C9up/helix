/**
 * `vi` — Vitest-compatible facade wiring together `vi.fn`, `vi.spyOn`,
 * fake timers, and system-time overrides.
 *
 * State isolation via `AsyncLocalStorage`: each `runTestFile` enters a
 * fresh `ViState`. Concurrent runs never share spies, timer queues, or
 * system-clock pins. A forgotten `useRealTimers()` / `useRealSystemTime()`
 * is cleaned up by `withViContext`'s finally block.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	createFakeTimerController,
	type FakeTimerController,
} from "./fake-timers.js";
import { type AnyFn, createSpy, isSpy, type Spy } from "./spy.js";
import { type SpyOnOptions, spyOn } from "./spyOn.js";
import {
	clearFakeEpoch,
	createSystemClock,
	registerSystemClockContext,
	type SystemClock,
	setFakeEpoch,
} from "./system-time.js";

/** Minimal surface helix's container facade depends on. Lives here
 *  rather than under `container/` so the runtime stays peer-dep-light
 *  (no import of `@c9up/ream`'s Container type). */
export interface ContainerLike {
	restore(token: ContainerToken): void;
}
export type ContainerToken =
	| (new (
			...args: never[]
	  ) => unknown)
	| string
	| symbol;

interface ViState {
	spies: Set<Spy>;
	timers: FakeTimerController;
	clock: SystemClock;
	/** Returned by `registerSystemClockContext` — removes this context's clock from the global resolver. */
	unregisterClock: () => void;
}

function createViState(): ViState {
	const clock = createSystemClock();
	const unregisterClock = registerSystemClockContext(() => clock);
	return {
		spies: new Set(),
		timers: createFakeTimerController(),
		clock,
		unregisterClock,
	};
}

const storage = new AsyncLocalStorage<ViState>();
let fallbackState: ViState = createViState();

function currentState(): ViState {
	return storage.getStore() ?? fallbackState;
}

/**
 * Exposed for unit tests that run outside `withViContext`: reset the
 * module-level fallback state so a forgotten `vi.fn()` or pinned clock
 * from a prior test doesn't bleed into the next.
 */
export function resetFallbackState(): void {
	fallbackState.unregisterClock();
	fallbackState.timers.uninstall();
	for (const spy of fallbackState.spies) {
		try {
			spy.mockRestore();
		} catch {
			/* best-effort cleanup — ignore failures */
		}
	}
	fallbackState = createViState();
}

/**
 * Run `body` under its own `vi` state. `runTestFile` in `worker.ts` wraps
 * each file in this scope so fake timers and spy registrations don't leak
 * between concurrent runs.
 */
export async function withViContext<T>(body: () => Promise<T>): Promise<T> {
	const state = createViState();
	try {
		return await storage.run(state, body);
	} finally {
		// Tear down in reverse: spies first (so restored methods work under
		// real timers), then timers, then system clock.
		// (Per-test container overrides drain in `withTestContext`'s
		// finally — see `runtime/test-context.ts`.)
		const spiesReversed = [...state.spies].reverse();
		for (const spy of spiesReversed) {
			try {
				spy.mockRestore();
			} catch {
				// One spy's restore failing must not block the others.
			}
		}
		if (state.timers.isActive()) state.timers.uninstall();
		clearFakeEpoch(state.clock);
		state.unregisterClock();
	}
}

function fn<Fn extends AnyFn>(implementation?: Fn): Spy<Fn> {
	const spy = createSpy<Fn>({
		name: "spy",
		defaultImplementation: implementation,
	});
	currentState().spies.add(spy);
	return spy;
}

/** Identical semantics to `matchers.isSpy` — re-exported so both surfaces agree. */
const isMockFunction = isSpy;

function viSpyOn<Obj extends object, Key extends keyof Obj>(
	obj: Obj,
	key: Key,
	options: SpyOnOptions = {},
): Spy {
	const spy = spyOn(obj, key, options);
	currentState().spies.add(spy);
	return spy;
}

function useFakeTimers(options: { now?: number | Date } = {}): typeof vi {
	const s = currentState();
	const pin =
		options.now instanceof Date
			? options.now.getTime()
			: typeof options.now === "number"
				? options.now
				: Date.now();
	s.timers.install(pin);
	// Fake timers also pin `Date.now()` / `new Date()` (per spec AC 4) via
	// the same epoch — writing to the context's system clock so the shim
	// returns the pinned value.
	setFakeEpoch(s.clock, pin);
	return vi;
}

function useRealTimers(): typeof vi {
	const s = currentState();
	s.timers.uninstall();
	clearFakeEpoch(s.clock);
	return vi;
}

function syncClockFromTimers(s: ViState): void {
	if (s.clock.fakeEpoch !== null) {
		setFakeEpoch(s.clock, s.timers.now());
	}
}

function advanceTimersByTime(ms: number): typeof vi {
	const s = currentState();
	try {
		s.timers.advanceBy(ms);
	} finally {
		// Sync even on throw so the clock reflects the attempted advance.
		syncClockFromTimers(s);
	}
	return vi;
}

function runAllTimers(): typeof vi {
	const s = currentState();
	try {
		s.timers.runAll();
	} finally {
		syncClockFromTimers(s);
	}
	return vi;
}

function runOnlyPendingTimers(): typeof vi {
	const s = currentState();
	try {
		s.timers.runOnlyPending();
	} finally {
		syncClockFromTimers(s);
	}
	return vi;
}

function getTimerCount(): number {
	return currentState().timers.pending();
}

function clearAllMocks(): typeof vi {
	for (const spy of currentState().spies) spy.mockClear();
	return vi;
}

function resetAllMocks(): typeof vi {
	for (const spy of currentState().spies) spy.mockReset();
	return vi;
}

/**
 * Restore every `spyOn`-created spy in the current context to its
 * original. `vi.fn()`-created spies are left as-is (they have nothing to
 * restore — spec AC 5).
 */
function restoreAllMocks(): typeof vi {
	const spies = [...currentState().spies].reverse();
	for (const spy of spies) {
		if (!spy.__isSpyOn) continue;
		try {
			spy.mockRestore();
		} catch {
			// Continue even if one restore throws so the rest still run.
		}
	}
	return vi;
}

export const vi = {
	fn,
	spyOn: viSpyOn,
	isMockFunction,
	useFakeTimers,
	useRealTimers,
	advanceTimersByTime,
	runAllTimers,
	runOnlyPendingTimers,
	getTimerCount,
	setSystemTime: (time: Date | number) => {
		setFakeEpoch(currentState().clock, time);
		return vi;
	},
	getMockedSystemTime: () => currentState().clock.fakeEpoch,
	clearAllTimers: () => {
		currentState().timers.clear();
		return vi;
	},
	clearAllMocks,
	resetAllMocks,
	restoreAllMocks,
	/** Escape hatch: clear the pinned system time. */
	useRealSystemTime: () => {
		clearFakeEpoch(currentState().clock);
		return vi;
	},
};

export type Vi = typeof vi;
