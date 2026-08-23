import { describe, expect, it } from "vitest";
import { globToRegExp } from "../../src/cli/glob.js";

describe("helix > glob braces", () => {
	it("compiles a brace list containing a globstar alternative", () => {
		const re = globToRegExp("{*.ts,**/*.ts}");
		expect(re.test("a.ts")).toBe(true);
		expect(re.test("src/a.ts")).toBe(true);
		expect(re.test("a.js")).toBe(false);
	});
});
