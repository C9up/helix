/**
 * `equals()` and the matcher factories must agree on what a matcher IS.
 *
 * The brand was written as a string literal in both `asymmetric.ts` (which
 * stamps it) and `equals.ts` (which reads it), with a comment explaining that
 * importing across them would cycle. One rule, two spellings: changing either
 * side would have made `equals` stop recognising every `expect.any()` and fall
 * back to structural comparison — silently, since nothing compared the two.
 */

import { describe, it, expect as vitestExpect } from "vitest";
import {
	any,
	anything,
	objectContaining,
} from "../../src/runtime/asymmetric.js";
import {
	ASYMMETRIC_BRAND,
	isAsymmetricMatcher,
} from "../../src/runtime/asymmetric-brand.js";
import { equals } from "../../src/runtime/equals.js";

describe("helix > the asymmetric brand is one rule", () => {
	it("stamps the brand the guard reads", () => {
		const matcher = any(Number);

		vitestExpect(isAsymmetricMatcher(matcher)).toBe(true);
		vitestExpect(Reflect.get(matcher, ASYMMETRIC_BRAND)).toBe(true);
	});

	it("lets equals() recognise every factory", () => {
		vitestExpect(equals(5, any(Number))).toBe(true);
		vitestExpect(equals("x", anything())).toBe(true);
		vitestExpect(equals({ a: 1, b: 2 }, objectContaining({ a: 1 }))).toBe(true);
	});

	it("matches on either side of the comparison", () => {
		vitestExpect(equals(any(Number), 5)).toBe(true);
	});

	it("does not treat an unbranded lookalike as a matcher", () => {
		// A domain object that happens to expose asymmetricMatch must be compared
		// structurally, not asked to judge itself.
		const lookalike = { asymmetricMatch: () => true };

		vitestExpect(isAsymmetricMatcher(lookalike)).toBe(false);
		vitestExpect(equals(5, lookalike)).toBe(false);
	});

	it("rejects a branded object with no match function", () => {
		vitestExpect(isAsymmetricMatcher({ [ASYMMETRIC_BRAND]: true })).toBe(false);
	});
});
