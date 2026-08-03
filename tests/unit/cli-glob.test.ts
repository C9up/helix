/**
 * Glob compilation for suite `files` entries — what makes an AdonisJS
 * `adonisrc.ts` suite list portable verbatim.
 */

import { describe, expect, it } from "vitest";
import {
	globBaseDir,
	globRejection,
	globToRegExp,
	isGlob,
} from "../../src/cli/glob.js";

/** Does `pattern` select `file`? */
function matches(pattern: string, file: string): boolean {
	return globToRegExp(pattern).test(file);
}

describe("isGlob", () => {
	it("separates patterns from plain paths", () => {
		expect(isGlob("tests/unit")).toBe(false);
		expect(isGlob("tests/unit/a.spec.ts")).toBe(false);
		expect(isGlob("tests/unit/**")).toBe(true);
		expect(isGlob("tests/*.spec.ts")).toBe(true);
		expect(isGlob("tests/a.spec.(js|ts)")).toBe(true);
		expect(isGlob("tests/{a,b}/c.ts")).toBe(true);
	});
});

describe("globBaseDir", () => {
	it("is the leading pattern-free path", () => {
		expect(globBaseDir("tests/unit/**/*.spec.ts")).toBe("tests/unit");
		expect(globBaseDir("tests/**/*.ts")).toBe("tests");
		expect(globBaseDir("**/*.spec.ts")).toBe(".");
		expect(globBaseDir("tests/unit")).toBe("tests/unit");
	});
});

describe("globToRegExp", () => {
	it("matches the AdonisJS default suite pattern", () => {
		const pattern = "tests/unit/**/*.spec.(js|ts)";

		expect(matches(pattern, "tests/unit/a.spec.ts")).toBe(true);
		expect(matches(pattern, "tests/unit/a.spec.js")).toBe(true);
		expect(matches(pattern, "tests/unit/nested/deep/b.spec.ts")).toBe(true);
		expect(matches(pattern, "tests/unit/helper.ts")).toBe(false);
		expect(matches(pattern, "tests/functional/a.spec.ts")).toBe(false);
	});

	it("globstar spans zero directories", () => {
		// fast-glob/picomatch semantics — `**/` may match nothing at all, which is
		// why the Adonis default finds `tests/unit/a.spec.ts`.
		expect(matches("tests/**/*.ts", "tests/a.ts")).toBe(true);
		expect(matches("tests/**/*.ts", "tests/a/b/c.ts")).toBe(true);
	});

	it("a single star stays within one segment", () => {
		expect(matches("tests/*.ts", "tests/a.ts")).toBe(true);
		expect(matches("tests/*.ts", "tests/nested/a.ts")).toBe(false);
	});

	it("supports brace alternation, `?` and character classes", () => {
		expect(matches("tests/{unit,e2e}/a.ts", "tests/unit/a.ts")).toBe(true);
		expect(matches("tests/{unit,e2e}/a.ts", "tests/e2e/a.ts")).toBe(true);
		expect(matches("tests/{unit,e2e}/a.ts", "tests/api/a.ts")).toBe(false);
		expect(matches("tests/a?.ts", "tests/a1.ts")).toBe(true);
		expect(matches("tests/a?.ts", "tests/a12.ts")).toBe(false);
		expect(matches("tests/[ab].ts", "tests/a.ts")).toBe(true);
		expect(matches("tests/[!ab].ts", "tests/c.ts")).toBe(true);
		expect(matches("tests/[!ab].ts", "tests/a.ts")).toBe(false);
	});

	it("treats a dot as a literal, not `any character`", () => {
		expect(matches("tests/a.spec.ts", "tests/a.spec.ts")).toBe(true);
		expect(matches("tests/a.spec.ts", "tests/aXspec.ts")).toBe(false);
	});

	it("is anchored at both ends", () => {
		expect(matches("tests/*.ts", "src/tests/a.ts")).toBe(false);
		expect(matches("tests/*.ts", "tests/a.ts.bak")).toBe(false);
	});
});

describe("globRejection", () => {
	it("refuses what it cannot honour, instead of half-matching", () => {
		expect(globRejection("!tests/unit/**")).toMatch(/negation/);
		expect(globRejection("tests/+(a|b)/*.ts")).toMatch(/extglob/);
		expect(globRejection("tests/@(a|b)/*.ts")).toMatch(/extglob/);
	});

	it("accepts the shapes it does compile", () => {
		expect(globRejection("tests/unit/**/*.spec.(js|ts)")).toBeUndefined();
		expect(globRejection("tests/{a,b}/*.ts")).toBeUndefined();
	});
});
