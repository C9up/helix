/**
 * The `Date` shim behind `vi.setSystemTime` / `useFakeTimers`: importing helix
 * replaces no global, the shim exists only while a clock is pinned, and while
 * it does it behaves as `Date` for subclassing, constructor identity and
 * `instanceof`.
 */

import { afterEach, describe, expect, it } from "vitest";

const RealDate = globalThis.Date;
const PIN = Date.UTC(2020, 0, 1);

async function loadVi(): Promise<
	typeof import("../../../../src/runtime/vi/index.js")
> {
	return import("../../../../src/runtime/vi/index.js");
}

describe("Date shim — install only while pinned", () => {
	afterEach(async () => {
		(await loadVi()).resetFallbackState();
	});

	it("importing the barrel leaves globalThis.Date untouched", async () => {
		await import("../../../../src/index.js");
		expect(globalThis.Date).toBe(RealDate);
		expect(new Date().constructor === Date).toBe(true);
		expect(Date.length).toBe(7);
	});

	it("installs on setSystemTime and uninstalls on useRealSystemTime", async () => {
		const { vi } = await loadVi();
		vi.setSystemTime(PIN);
		expect(globalThis.Date).not.toBe(RealDate);
		expect(Date.now()).toBe(PIN);
		vi.useRealSystemTime();
		expect(globalThis.Date).toBe(RealDate);
	});

	it("uninstalls on useRealTimers after useFakeTimers", async () => {
		const { vi } = await loadVi();
		vi.useFakeTimers({ now: PIN });
		expect(new Date().toISOString()).toBe(new RealDate(PIN).toISOString());
		vi.useRealTimers();
		expect(globalThis.Date).toBe(RealDate);
	});

	it("uninstalls when a pinned file context ends", async () => {
		const { vi, withViContext } = await loadVi();
		await withViContext(async () => {
			vi.setSystemTime(PIN);
			expect(Date.now()).toBe(PIN);
		});
		expect(globalThis.Date).toBe(RealDate);
	});

	it("stays installed while another context still pins the clock", async () => {
		const { vi, withViContext } = await loadVi();
		vi.setSystemTime(PIN);
		await withViContext(async () => {
			vi.setSystemTime(PIN + 1);
			vi.useRealSystemTime();
		});
		expect(Date.now()).toBe(PIN);
		vi.useRealSystemTime();
		expect(globalThis.Date).toBe(RealDate);
	});
});

describe("Date shim — behaves as Date while installed", () => {
	afterEach(async () => {
		(await loadVi()).resetFallbackState();
	});

	it("a subclass keeps its prototype and reads the pinned clock", async () => {
		const { vi } = await loadVi();
		vi.setSystemTime(PIN);
		class MyDate extends Date {
			hello(): string {
				return "hi";
			}
		}
		const m = new MyDate();
		expect(m instanceof MyDate).toBe(true);
		expect(m.hello()).toBe("hi");
		expect(m.getTime()).toBe(PIN);
		expect(new MyDate(5).getTime()).toBe(5);
	});

	it("a subclass declared before the pin keeps working", async () => {
		class Early extends Date {
			tag(): string {
				return "early";
			}
		}
		const { vi } = await loadVi();
		vi.setSystemTime(PIN);
		const e = new Early();
		expect(e.tag()).toBe("early");
		expect(e instanceof Date).toBe(true);
	});

	it("keeps constructor identity, length and the string form", async () => {
		const { vi } = await loadVi();
		vi.setSystemTime(PIN);
		const d = new Date();
		expect(d.constructor === Date).toBe(true);
		expect(Date.prototype.constructor === Date).toBe(true);
		expect(Date.length).toBe(7);
		expect(Date.name).toBe("Date");
		expect(Object.prototype.toString.call(d)).toBe("[object Date]");
		expect(Date()).toBe(new RealDate(PIN).toString());
		expect(Date.parse("2020-01-01T00:00:00Z")).toBe(PIN);
		expect(Date.UTC(2020, 0, 1)).toBe(PIN);
	});

	it("dates made before the pin are still instances of Date", async () => {
		const before = new Date(0);
		const { vi } = await loadVi();
		vi.setSystemTime(PIN);
		expect(before instanceof Date).toBe(true);
		expect(new Date() instanceof RealDate).toBe(true);
		class Sub extends Date {}
		// A subclass does not claim every date: only its own instances.
		expect(before instanceof Sub).toBe(false);
		expect(new Sub() instanceof Sub).toBe(true);
	});
});
