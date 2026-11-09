import { expect, test } from "../../../src/runtime/index.js";

/** Passes, then rejects from a timer once the file has reported its result. */
test("rejects after it resolved", () => {
	setTimeout(() => {
		void Promise.reject(new Error("BOOM-late-reject"));
	}, 200);
	expect(1).toBe(1);
});
