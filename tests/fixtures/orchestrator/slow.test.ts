import { expect, test } from "../../../src/runtime/index.js";

test("takes one second", async () => {
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	expect(1).toBe(1);
});

test("a quick sibling", () => {
	expect(1).toBe(1);
});
