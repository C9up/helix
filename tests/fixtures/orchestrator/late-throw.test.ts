import { expect, test } from "../../../src/runtime/index.js";

/** Passes, then throws from a timer once the file has reported its result. */
test("throws after it resolved", () => {
	setTimeout(() => {
		throw new Error("BOOM-late");
	}, 200);
	expect(1).toBe(1);
});
