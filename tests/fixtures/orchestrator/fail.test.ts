import { expect, test } from "../../../src/runtime/index.js";

test("fails on purpose", () => {
	expect(1).toBe(2);
});

test("passes despite sibling", () => {
	expect("ok").toBe("ok");
});
