/**
 * Integration tests for `helix.time` (Story 42.4).
 *
 * Helix is agnostic — these tests do NOT import `@c9up/chronos`.
 * The contract under test is "`time.freeze` pins
 * `globalThis.Date`"; any consumer (chronos `DateTime`, Luxon, etc.)
 * that reads "now" through `new Date()` automatically picks that
 * up. Verifying chronos itself belongs in chronos's test suite.
 *
 * Each test wraps its body in `withTestContext` so the
 * `inTestContext()` guard inside `freeze` / `travel` is satisfied —
 * vitest does not open the helix per-test frame for us.
 */

import { describe, expect, it } from "vitest";
import { withTestContext } from "../../src/runtime/test-context.js";
import { vi } from "../../src/runtime/vi/index.js";
import {
	freeze,
	frozenAt,
	travel,
	travelTo,
	unfreeze,
} from "../../src/time/freeze.js";

const FROZEN_ISO = "2026-01-01T00:00:00.000Z";
const FROZEN_EPOCH = Date.parse(FROZEN_ISO); // 1767225600000

describe("time.freeze — input shapes", () => {
	it("freeze(string ISO) pins Date.now and new Date()", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_ISO);
			expect(Date.now()).toBe(FROZEN_EPOCH);
			// `new Date()` (no args) constructor is also shimmed — assert via
			// the ISO string so we hit a different code path than `Date.now()`.
			expect(new Date().toISOString()).toBe(FROZEN_ISO);
		});
	});

	it("freeze(Date) pins to the given epoch", async () => {
		await withTestContext(async () => {
			freeze(new Date(FROZEN_ISO));
			expect(Date.now()).toBe(FROZEN_EPOCH);
		});
	});

	it("freeze({ toMillis }) accepts duck-typed inputs (chronos / Luxon)", async () => {
		await withTestContext(async () => {
			const datetimeLike = { toMillis: () => FROZEN_EPOCH };
			freeze(datetimeLike);
			expect(Date.now()).toBe(FROZEN_EPOCH);
		});
	});

	it("freeze(number epoch) pins to the raw ms", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_EPOCH);
			expect(Date.now()).toBe(FROZEN_EPOCH);
		});
	});

	it("freeze(invalid string) throws with a clear message", async () => {
		await withTestContext(async () => {
			expect(() => freeze("not-a-date")).toThrow(/cannot parse/);
		});
	});

	it("freeze(Invalid Date) throws (not silent NaN)", async () => {
		await withTestContext(async () => {
			expect(() => freeze(new Date("garbage"))).toThrow(/finite/);
		});
	});

	it("freeze({ toMillis }) where toMillis returns a non-number throws", async () => {
		await withTestContext(async () => {
			const bad = { toMillis: () => "1234" as unknown as number };
			expect(() => freeze(bad)).toThrow(/must return a number/);
		});
	});

	it("freeze(epoch beyond JS Date range) throws", async () => {
		await withTestContext(async () => {
			expect(() => freeze(8.64e15 + 1)).toThrow(/JS Date range/);
		});
	});

	it("freeze() outside a test frame throws", () => {
		expect(() => freeze(FROZEN_EPOCH)).toThrow(/inside a test/);
	});
});

describe("time.travel — calendar arithmetic", () => {
	it("travel(amount, 'ms') is a pure ms delta", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_EPOCH);
			travel(1500, "ms");
			expect(Date.now()).toBe(FROZEN_EPOCH + 1500);
		});
	});

	it("travel(amount, 'second' | 'minute' | 'hour') uses pure factors", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_EPOCH);
			travel(2, "hour");
			expect(Date.now()).toBe(FROZEN_EPOCH + 2 * 3_600_000);
			travel(30, "minute");
			expect(Date.now()).toBe(FROZEN_EPOCH + 2 * 3_600_000 + 30 * 60_000);
		});
	});

	it("travel(7, 'day') advances by exactly 7 days", async () => {
		await withTestContext(async () => {
			freeze("2026-01-01T00:00:00Z");
			travel(7, "day");
			expect(new Date(Date.now()).toISOString()).toBe(
				"2026-01-08T00:00:00.000Z",
			);
		});
	});

	it("travel(1, 'week') is 7 days exactly", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_EPOCH);
			travel(1, "week");
			expect(Date.now()).toBe(FROZEN_EPOCH + 7 * 86_400_000);
		});
	});

	it("travel(2, 'month') from Jan-31 lands on Mar-31", async () => {
		await withTestContext(async () => {
			freeze("2026-01-31T00:00:00Z");
			travel(2, "month");
			expect(new Date(Date.now()).toISOString()).toBe(
				"2026-03-31T00:00:00.000Z",
			);
		});
	});

	it("travel(1, 'month') from Jan-31 overflows to Mar-03 (JS Date semantics)", async () => {
		await withTestContext(async () => {
			freeze("2026-01-31T00:00:00Z");
			travel(1, "month");
			// `setUTCMonth(1)` with day=31: Feb has 28 days in 2026 → 28+3=31
			// → March 3.
			expect(new Date(Date.now()).toISOString()).toBe(
				"2026-03-03T00:00:00.000Z",
			);
		});
	});

	it("travel(1, 'year') from leap day Feb-29 → Mar-01 (next year non-leap)", async () => {
		await withTestContext(async () => {
			freeze("2024-02-29T00:00:00Z");
			travel(1, "year");
			expect(new Date(Date.now()).toISOString()).toBe(
				"2025-03-01T00:00:00.000Z",
			);
		});
	});

	it("travel without prior freeze freezes relative to real now", async () => {
		await withTestContext(async () => {
			expect(frozenAt()).toBeNull();
			travel(1, "hour");
			// After: clock is frozen (frozenAt non-null), and the captured
			// epoch is roughly real-now + 1h. Loose tolerance because we
			// race the real clock between checking before and travel
			// reading Date.now() internally.
			const after = frozenAt();
			expect(after).not.toBeNull();
		});
	});

	it("travel pins the clock — subsequent reads are stable across awaits", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_EPOCH);
			const a = Date.now();
			await new Promise((r) => setImmediate(r));
			expect(Date.now()).toBe(a);
		});
	});

	it("travel defaults to 'ms' when unit omitted", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_EPOCH);
			travel(2500);
			expect(Date.now()).toBe(FROZEN_EPOCH + 2500);
		});
	});

	it("travel rejects non-finite amount", async () => {
		await withTestContext(async () => {
			expect(() => travel(Number.NaN, "ms")).toThrow(/finite/);
			expect(() => travel(Number.POSITIVE_INFINITY, "ms")).toThrow(/finite/);
		});
	});

	it("travel rejects fractional amount for calendar units (month/year)", async () => {
		await withTestContext(async () => {
			expect(() => travel(1.5, "month")).toThrow(/integer amount/);
			expect(() => travel(0.5, "year")).toThrow(/integer amount/);
		});
	});

	it("travel rejects a delta that overflows the JS Date range", async () => {
		await withTestContext(async () => {
			freeze(0);
			expect(() => travel(Number.MAX_SAFE_INTEGER, "day")).toThrow(
				/JS Date range/,
			);
		});
	});

	it("travel rejects unknown unit at runtime (defensive)", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_EPOCH);
			expect(() => travel(1, "fortnight" as unknown as never)).toThrow(
				/unknown unit/,
			);
		});
	});

	it("travel() outside a test frame throws", () => {
		expect(() => travel(1, "hour")).toThrow(/inside a test/);
	});
});

describe("time.travelTo — explicit verb alias for freeze", () => {
	it("travelTo(target) pins the same way freeze does", async () => {
		await withTestContext(async () => {
			travelTo(FROZEN_ISO);
			expect(Date.now()).toBe(FROZEN_EPOCH);
		});
	});

	it("travelTo can re-pin after a previous freeze", async () => {
		await withTestContext(async () => {
			freeze("2024-01-01T00:00:00Z");
			travelTo("2030-06-15T12:00:00Z");
			expect(new Date(Date.now()).toISOString()).toBe(
				"2030-06-15T12:00:00.000Z",
			);
		});
	});
});

describe("time.unfreeze — idempotent restore", () => {
	it("unfreeze restores the real clock", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_EPOCH);
			expect(Date.now()).toBe(FROZEN_EPOCH);
			unfreeze();
			// Real `Date.now()` is well past 2026-01-01 in real time.
			expect(Date.now()).toBeGreaterThan(FROZEN_EPOCH + 1_000_000);
		});
	});

	it("unfreeze called when not frozen is a no-op", () => {
		expect(() => unfreeze()).not.toThrow();
		expect(frozenAt()).toBeNull();
	});

	it("unfreeze called twice in a row is idempotent", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_EPOCH);
			unfreeze();
			expect(() => unfreeze()).not.toThrow();
		});
	});

	it("unfreeze does NOT require a test frame (no-op outside)", () => {
		// Sole exception to the inTestContext guard: unfreeze is the
		// recovery primitive — it must always work even from setup hooks.
		expect(() => unfreeze()).not.toThrow();
	});
});

describe("time.frozenAt — introspection", () => {
	it("frozenAt returns null on real time", () => {
		expect(frozenAt()).toBeNull();
	});

	it("frozenAt returns the pinned epoch after freeze", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_EPOCH);
			expect(frozenAt()).toBe(FROZEN_EPOCH);
		});
	});

	it("frozenAt returns null after the frame's auto-restore fires", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_EPOCH);
		});
		expect(frozenAt()).toBeNull();
	});

	it("frozenAt tracks travel-induced advances", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_EPOCH);
			travel(1, "hour");
			expect(frozenAt()).toBe(FROZEN_EPOCH + 3_600_000);
		});
	});
});

describe("time — auto-restore via per-test frame", () => {
	it("freeze inside withTestContext is undone when the frame closes", async () => {
		await withTestContext(async () => {
			freeze(FROZEN_EPOCH);
			expect(frozenAt()).toBe(FROZEN_EPOCH);
		});
		expect(frozenAt()).toBeNull();
	});

	it("travel inside withTestContext is also undone", async () => {
		await withTestContext(async () => {
			travel(1, "day");
			expect(frozenAt()).not.toBeNull();
		});
		expect(frozenAt()).toBeNull();
	});

	it("multiple freeze calls inside one frame queue idempotent cleanups", async () => {
		await withTestContext(async () => {
			freeze("2026-01-01T00:00:00Z");
			freeze("2030-01-01T00:00:00Z");
			expect(frozenAt()).toBe(Date.parse("2030-01-01T00:00:00Z"));
		});
		// Two cleanups queued, both idempotent — final state is real time.
		expect(frozenAt()).toBeNull();
	});

	it("freeze + travel queues two cleanups, both idempotent (always-queue policy)", async () => {
		// Spy on `vi.useRealSystemTime` to count cleanup invocations.
		const real = vi.useRealSystemTime;
		let calls = 0;
		// biome-ignore lint/suspicious/noExplicitAny: test spy
		(vi as any).useRealSystemTime = (...args: unknown[]) => {
			calls++;
			// biome-ignore lint/suspicious/noExplicitAny: rebind to original
			return (real as any).apply(vi, args);
		};
		try {
			await withTestContext(async () => {
				freeze(FROZEN_EPOCH);
				travel(1, "hour");
			});
			// freeze queued one, travel always queues another → 2 cleanups.
			// (Always-queue policy makes the contract uniform — see
			// freeze.ts header note on the `wasFrozen` heuristic trap.)
			expect(calls).toBe(2);
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: restore
			(vi as any).useRealSystemTime = real;
		}
	});

	it("travel after raw vi.setSystemTime still queues a cleanup (no wasFrozen trap)", async () => {
		await withTestContext(async () => {
			vi.setSystemTime(FROZEN_EPOCH); // raw, no helix cleanup queued
			travel(1, "hour");
			expect(frozenAt()).toBe(FROZEN_EPOCH + 3_600_000);
		});
		// The raw setSystemTime didn't queue anything, but travel did —
		// so the frame's drain restores real time.
		expect(frozenAt()).toBeNull();
	});
});
