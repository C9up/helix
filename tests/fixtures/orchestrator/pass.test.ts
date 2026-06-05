import { expect, test } from "../../../src/runtime/index.js";

test("a passes", () => {
	expect(1 + 1).toBe(2);
});

test("b passes", () => {
	expect([1, 2]).toContain(2);
});
