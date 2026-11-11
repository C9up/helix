import {
	afterAll,
	describe,
	expect,
	test,
} from "../../../src/runtime/index.js";

describe("outer", () => {
	describe("inner", () => {
		afterAll(() => {
			throw new Error("inner afterAll broke");
		});
		test("leaf", () => {
			expect(1).toBe(1);
		});
	});
	test("sibling", () => {
		expect(true).toBe(true);
	});
});
