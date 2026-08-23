/**
 * An unbalanced `{`, `(` or `[` compiles to an unbalanced regex, and the raw
 * failure read as an internal pattern the author never wrote — "Invalid
 * regular expression: /^(?:a|b$/" says nothing about the glob that caused it.
 */
import { describe, expect, it } from "vitest";
import { globToRegExp } from "../../src/cli/glob.js";

describe("helix > malformed glob", () => {
	it("names the pattern the author actually wrote", () => {
		for (const bad of ["{a,b", "*(a|b", "tests/{unit,e2e/**/*.ts"]) {
			expect(() => globToRegExp(bad)).toThrow(
				`Cannot read "${bad}" as a glob pattern`,
			);
		}
	});

	it("keeps the underlying error as the cause", () => {
		try {
			globToRegExp("{a,b");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect((err as Error).cause).toBeInstanceOf(SyntaxError);
		}
	});

	it("still compiles a well-formed pattern", () => {
		const re = globToRegExp("tests/{unit,e2e}/**/*.spec.ts");
		expect(re.test("tests/unit/a/b.spec.ts")).toBe(true);
		expect(re.test("tests/other/a.spec.ts")).toBe(false);
	});
});
