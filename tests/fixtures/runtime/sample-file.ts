/**
 * Fixture loaded by worker.test.ts — exercises the full collection flow:
 * nested describe, before/after hooks, passing + failing + skipped + todo.
 */
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	test,
} from "../../../src/runtime/index.js";

describe("fixture", () => {
	const events: string[] = [];
	beforeAll(() => {
		events.push("beforeAll");
	});
	afterAll(() => {
		// events not asserted externally, just proves hook executed
		events.push("afterAll");
	});

	it("passes", () => {
		expect(1 + 1).toBe(2);
	});

	it("fails on purpose", () => {
		expect(1).toBe(2);
	});

	test.skip("skipped", () => {
		throw new Error("should not run");
	});

	test.todo("pending work");
});
