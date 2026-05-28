/**
 * Time freeze / travel — ergonomic surface over `vi.setSystemTime`
 * with per-test auto-restore.
 *
 * **Helix is agnostic — no cross-package imports.** This module
 * never imports `@c9up/chronos`. The clock pin happens entirely
 * through `vi.setSystemTime` (which shims `globalThis.Date`); any
 * code in user-land that calls `new Date()` — chronos `DateTime`
 * included — picks up the frozen epoch automatically.
 *
 * Calendar arithmetic for `month` / `year` uses `Date.UTC` math
 * locally so we don't take a runtime dependency on chronos.
 *
 * **Concurrency note.** `vi.setSystemTime` writes to the `vi`
 * context that wraps the current test FILE (`withViContext`), not
 * the per-test frame (`withTestContext`). Two `withTestContext`
 * frames running in parallel inside the same file (e.g. via
 * `Promise.all([withTestContext(A), withTestContext(B)])`) share
 * one Date shim — A's freeze leaks into B. The helix runtime
 * executes tests strictly sequentially (`runSuite`'s for-await
 * loop), so this is not reachable through the documented test
 * path. Callers who manually compose `withTestContext` in parallel
 * inside a single file must serialise their freezes themselves.
 */

import { inTestContext, registerTestCleanup } from "../runtime/test-context.js";
import { vi } from "../runtime/vi/index.js";

/** Anything with a `toMillis()` method (e.g. chronos `DateTime`,
 *  Luxon `DateTime`) is accepted via duck typing — no import. */
interface MillisLike {
	toMillis(): number;
}

/** Inputs accepted by `freeze` / `travelTo`. */
export type TimeInput = string | number | Date | MillisLike;

/** Calendar units supported by `time.travel`. `ms` is the bare-metal
 *  fallback; `month` and `year` use `Date.UTC` math; the rest are pure
 *  ms multipliers. UTC-only — tests should freeze to a UTC instant. */
export type TimeUnit =
	| "ms"
	| "second"
	| "minute"
	| "hour"
	| "day"
	| "week"
	| "month"
	| "year";

/** JS `Date` represents instants from `-8.64e15` to `+8.64e15` ms.
 *  Anything beyond becomes "Invalid Date" — refuse early so callers
 *  see a clear error instead of `setSystemTime(NaN)` downstream. */
const JS_DATE_MAX = 8_640_000_000_000_000;

/**
 * Pin `Date.now()` / `new Date()` (and anything that reads through
 * them — e.g. `DateTime.now()`) to the given moment. Auto-restored
 * at end-of-test via the helix test frame, so a forgotten
 * `unfreeze()` does not leak into the next test.
 *
 * Throws when called outside a test frame — a queued cleanup would
 * never fire there, so the freeze would leak across tests silently.
 */
export function freeze(input: TimeInput): void {
	requireTestContext("freeze");
	const ms = inputToMs(input);
	vi.setSystemTime(ms);
	registerTestCleanup(() => {
		vi.useRealSystemTime();
	});
}

/**
 * Advance the clock by `amount` × `unit`. If the clock isn't frozen
 * yet, freezes it relative to the real `Date.now()` first, then
 * applies the delta — so a one-shot `time.travel(7, 'day')` works
 * without an explicit `freeze()`.
 *
 * Always queues a cleanup so the auto-restore path is uniform —
 * cleanups are idempotent (each calls `vi.useRealSystemTime`),
 * accumulating closures across many `travel` calls in one test is
 * intentional and cheap.
 *
 * Throws when called outside a test frame, same reason as `freeze`.
 */
export function travel(amount: number, unit: TimeUnit = "ms"): void {
	requireTestContext("travel");
	if (!Number.isFinite(amount)) {
		throw new Error(`helix.time.travel: amount must be finite, got ${amount}.`);
	}
	if ((unit === "month" || unit === "year") && !Number.isInteger(amount)) {
		throw new Error(
			`helix.time.travel: '${unit}' requires an integer amount, got ${amount}. Calendar units don't compose cleanly with fractions.`,
		);
	}
	const base = vi.getMockedSystemTime() ?? Date.now();
	const next = applyDelta(base, amount, unit);
	requireInDateRange(next, "travel");
	vi.setSystemTime(next);
	// Always queue — `vi.useRealSystemTime` is idempotent so duplicate
	// cleanups across `freeze + travel` are harmless. Always-queue
	// guards against the "user pinned via raw `vi.setSystemTime`,
	// then called `travel`" trap where the heuristic would skip.
	registerTestCleanup(() => {
		vi.useRealSystemTime();
	});
}

/**
 * Travel TO a specific moment. Equivalent to `freeze(target)` —
 * exists as an explicit verb so "travel to 2026" reads better than
 * "freeze at 2026" in tests.
 */
export function travelTo(target: TimeInput): void {
	freeze(target);
}

/**
 * Restore the real system clock immediately. Idempotent — safe to
 * call when not currently frozen. Auto-restore still fires at
 * end-of-test, so calling `unfreeze` early is purely a
 * test-readability choice.
 */
export function unfreeze(): void {
	vi.useRealSystemTime();
}

/**
 * Read the currently frozen epoch, or `null` when running on real
 * time. Useful for tests that compose `freeze` with their own clock
 * arithmetic.
 */
export function frozenAt(): number | null {
	return vi.getMockedSystemTime();
}

function requireTestContext(verb: string): void {
	if (!inTestContext()) {
		throw new Error(
			`helix.time.${verb}: must be called inside a test (no active test frame). Calls from top-level setup leak across tests — use vi.setSystemTime directly with manual cleanup if that is what you want.`,
		);
	}
}

function inputToMs(input: TimeInput): number {
	let ms: number;
	if (typeof input === "number") {
		ms = input;
	} else if (input instanceof Date) {
		ms = input.getTime();
	} else if (typeof input === "string") {
		ms = Date.parse(input);
		if (Number.isNaN(ms)) {
			throw new Error(
				`helix.time: cannot parse '${input}' as a date — pass an ISO 8601 string, Date, number (epoch ms), or an object with toMillis().`,
			);
		}
	} else if (
		typeof input === "object" &&
		input !== null &&
		typeof (input as MillisLike).toMillis === "function"
	) {
		const result = (input as MillisLike).toMillis();
		if (typeof result !== "number") {
			throw new Error(
				`helix.time: input.toMillis() must return a number, got ${typeof result}.`,
			);
		}
		ms = result;
	} else {
		throw new Error(
			`helix.time: unsupported input type ${typeof input}. Use string / Date / number / { toMillis() }.`,
		);
	}
	requireInDateRange(ms, "freeze");
	return ms;
}

function requireInDateRange(ms: number, verb: string): void {
	if (!Number.isFinite(ms)) {
		throw new Error(
			`helix.time.${verb}: epoch must be finite, got ${ms}. (Did you pass an Invalid Date or a NaN?)`,
		);
	}
	if (Math.abs(ms) > JS_DATE_MAX) {
		throw new Error(
			`helix.time.${verb}: epoch ${ms} exceeds the JS Date range (±8.64e15 ms). The resulting clock would be 'Invalid Date'.`,
		);
	}
}

function applyDelta(base: number, amount: number, unit: TimeUnit): number {
	switch (unit) {
		case "ms":
			return base + amount;
		case "second":
			return base + amount * 1_000;
		case "minute":
			return base + amount * 60_000;
		case "hour":
			return base + amount * 3_600_000;
		case "day":
			return base + amount * 86_400_000;
		case "week":
			return base + amount * 604_800_000;
		case "month":
		case "year": {
			// UTC calendar math — JS `Date` mutators handle month
			// overflow (e.g. month 13 → year+1 month 1) and clamp
			// month-end days (e.g. Jan 31 + 1 month → Feb 28/29).
			const d = new Date(base);
			if (unit === "year") {
				d.setUTCFullYear(d.getUTCFullYear() + amount);
			} else {
				d.setUTCMonth(d.getUTCMonth() + amount);
			}
			return d.getTime();
		}
		default: {
			// Defensive — TS narrows this branch to `never`, but a
			// runtime cast (`unit as TimeUnit`) could land here.
			const exhaustive: never = unit;
			throw new Error(
				`helix.time.travel: unknown unit '${exhaustive as string}'.`,
			);
		}
	}
}
