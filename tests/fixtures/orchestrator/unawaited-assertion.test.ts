import { expect, test } from "../../../src/runtime/index.js";

/** A failing `.resolves` the body forgot to await. */
test("forgot to await a failing async assertion", () => {
	expect(
		new Promise((resolve) => setTimeout(() => resolve(1), 100)),
	).resolves.toBe(2);
});

test("a sibling that passes", () => {
	expect(2).toBe(2);
});
