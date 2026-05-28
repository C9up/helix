import { describe, it, expect as vExpect } from "vitest";
import { AssertionError } from "../../../src/runtime/assertion-error.js";
import { expect } from "../../../src/runtime/expect.js";

describe("expect — sync chain", () => {
	it("passes on success, throws AssertionError on failure", () => {
		expect(1).toBe(1);
		vExpect(() => expect(1).toBe(2)).toThrow(AssertionError);
	});

	it(".not inverts pass/fail", () => {
		expect(1).not.toBe(2);
		vExpect(() => expect(1).not.toBe(1)).toThrow(AssertionError);
	});

	it("captures actual/expected on the thrown error", () => {
		try {
			expect({ a: 1 }).toEqual({ a: 2 });
			throw new Error("should have thrown");
		} catch (err) {
			vExpect(err).toBeInstanceOf(AssertionError);
			const e = err as AssertionError;
			vExpect(e.actual).toEqual({ a: 1 });
			// `expected` is always an array of matcher args — stable shape for reporters.
			vExpect(e.expected).toEqual([{ a: 2 }]);
			vExpect(e.operator).toBe("toEqual");
		}
	});
});

describe("expect — async chains", () => {
	it(".resolves runs matcher on resolved value", async () => {
		await expect(Promise.resolve(42)).resolves.toBe(42);
	});

	it(".resolves fails when promise rejects", async () => {
		await vExpect(
			expect(Promise.reject(new Error("boom"))).resolves.toBe(1),
		).rejects.toThrow(AssertionError);
	});

	it(".rejects runs matcher on rejection", async () => {
		await expect(Promise.reject(new Error("boom"))).rejects.toThrow("boom");
	});

	it(".rejects fails when promise resolves", async () => {
		await vExpect(expect(Promise.resolve(1)).rejects.toThrow()).rejects.toThrow(
			AssertionError,
		);
	});

	it(".resolves.not combines both", async () => {
		await expect(Promise.resolve(1)).resolves.not.toBe(2);
	});

	it("throws when .resolves used on non-promise", async () => {
		await vExpect(expect(42).resolves.toBe(42)).rejects.toThrow(AssertionError);
	});

	it(".not.resolves is supported (symmetric to .resolves.not)", async () => {
		await expect(Promise.resolve(1)).not.resolves.toBe(2);
	});

	it("matcher exceptions are wrapped in AssertionError", () => {
		// A constructor whose `Symbol.hasInstance` throws — `instanceof` will
		// propagate that error. The engine must wrap it as AssertionError.
		function Trap(): void {
			/* no-op, just needs a .prototype */
		}
		Object.defineProperty(Trap, Symbol.hasInstance, {
			value: () => {
				throw new Error("trap");
			},
		});
		vExpect(() => expect({}).toBeInstanceOf(Trap)).toThrow(AssertionError);
	});
});
