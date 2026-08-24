/**
 * The brand that marks an asymmetric matcher, and the guard that reads it.
 *
 * Its own module because both `asymmetric.ts` (which creates matchers) and
 * `equals.ts` (which must recognise them) need it, and `asymmetric.ts` imports
 * `equals.ts` — so neither can own it without a cycle. It used to be spelled as
 * a literal on both sides: a rule written twice, where changing one side would
 * silently stop `expect.any()` from being recognised and turn every matcher
 * into a plain structural comparison.
 */

export const ASYMMETRIC_BRAND = "__helixAsymmetricMatcher";

export interface AsymmetricMatcher {
	readonly [ASYMMETRIC_BRAND]: true;
	/** Return `true` when `actual` satisfies this matcher. */
	asymmetricMatch(actual: unknown): boolean;
	/** Human-readable label used in failure diagnostics. */
	toString(): string;
}

export function isAsymmetricMatcher(
	value: unknown,
): value is AsymmetricMatcher {
	if (typeof value !== "object" || value === null) return false;
	return (
		Reflect.get(value, ASYMMETRIC_BRAND) === true &&
		typeof Reflect.get(value, "asymmetricMatch") === "function"
	);
}
