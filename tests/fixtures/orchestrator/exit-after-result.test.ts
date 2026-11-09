import { expect, test } from "../../../src/runtime/index.js";

/** Passes, then kills its own worker with a status nobody announced. */
test("exits with 3 after it resolved", () => {
	setTimeout(() => process.exit(3), 200);
	expect(1).toBe(1);
});
