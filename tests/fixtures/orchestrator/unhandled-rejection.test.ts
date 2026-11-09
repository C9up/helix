import { expect, test } from "../../../src/runtime/index.js";

/** A rejection nobody handles, raised while the test is still running. */
test("floating rejection", async () => {
	void Promise.reject(new Error("BOOM-floating"));
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(1).toBe(1);
});

test("a sibling that passes", () => {
	expect(2).toBe(2);
});
