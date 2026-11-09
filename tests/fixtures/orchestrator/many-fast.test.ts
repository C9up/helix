import { expect, test } from "../../../src/runtime/index.js";

/** Twenty-five tests, each well under a 400ms per-test timeout, 6s in all. */
for (let i = 1; i <= 25; i += 1) {
	test(`fast test ${i}`, async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(i).toBe(i);
	});
}
