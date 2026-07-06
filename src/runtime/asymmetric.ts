/**
 * Asymmetric matchers — `expect.objectContaining`, `expect.arrayContaining`,
 * `expect.stringContaining`, `expect.any`, `expect.anything`.
 *
 * Each is a small object carrying an `asymmetricMatch(actual)` method (the
 * Jest/Vitest convention). `equals`/`partialEquals` recognise the brand and
 * delegate to `asymmetricMatch` instead of doing structural comparison, so an
 * asymmetric matcher can appear anywhere inside an expected value.
 */

import { equals, partialEquals } from "./equals.js";

const BRAND = "__helixAsymmetricMatcher";

export interface AsymmetricMatcher {
	readonly [BRAND]: true;
	/** Return `true` when `actual` satisfies this matcher. */
	asymmetricMatch(actual: unknown): boolean;
	/** Human-readable label used in failure diagnostics. */
	toString(): string;
}

export function isAsymmetricMatcher(
	value: unknown,
): value is AsymmetricMatcher {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Partial<AsymmetricMatcher>)[BRAND] === true &&
		typeof (value as AsymmetricMatcher).asymmetricMatch === "function"
	);
}

function make(
	label: string,
	match: (actual: unknown) => boolean,
): AsymmetricMatcher {
	return { [BRAND]: true, asymmetricMatch: match, toString: () => label };
}

/** `expect.anything()` — matches any value except `null`/`undefined`. */
export function anything(): AsymmetricMatcher {
	return make(
		"anything()",
		(actual) => actual !== null && actual !== undefined,
	);
}

/** Constructor accepted by `expect.any(...)`, including primitive wrappers. */
export type Constructor = new (...args: never[]) => unknown;

/** `expect.any(Ctor)` — matches by type/constructor (primitive-aware). */
export function any(ctor: Constructor): AsymmetricMatcher {
	const name = (ctor as { name?: string }).name ?? "anonymous";
	return make(`any(${name})`, (actual) => {
		if (ctor === (String as unknown)) return typeof actual === "string";
		if (ctor === (Number as unknown)) return typeof actual === "number";
		if (ctor === (Boolean as unknown)) return typeof actual === "boolean";
		if (ctor === (BigInt as unknown)) return typeof actual === "bigint";
		if (ctor === (Symbol as unknown)) return typeof actual === "symbol";
		if (ctor === (Function as unknown)) return typeof actual === "function";
		if (ctor === (Object as unknown)) {
			return typeof actual === "object" && actual !== null;
		}
		try {
			return actual instanceof ctor;
		} catch {
			return false;
		}
	});
}

/** `expect.stringContaining(sub)` — matches a string containing `sub`. */
export function stringContaining(sub: string): AsymmetricMatcher {
	return make(
		`stringContaining(${JSON.stringify(sub)})`,
		(actual) => typeof actual === "string" && actual.includes(sub),
	);
}

/** `expect.stringMatching(re)` — matches a string against a regexp/substring. */
export function stringMatching(pattern: string | RegExp): AsymmetricMatcher {
	return make(`stringMatching(${String(pattern)})`, (actual) => {
		if (typeof actual !== "string") return false;
		return typeof pattern === "string"
			? actual.includes(pattern)
			: pattern.test(actual);
	});
}

/** `expect.objectContaining(subset)` — matches an object superset of `subset`. */
export function objectContaining(
	subset: Record<string, unknown>,
): AsymmetricMatcher {
	return make("objectContaining(...)", (actual) =>
		partialEquals(actual, subset),
	);
}

/** `expect.arrayContaining(items)` — every item must appear in `actual`. */
export function arrayContaining(items: readonly unknown[]): AsymmetricMatcher {
	return make("arrayContaining(...)", (actual) => {
		if (!Array.isArray(actual)) return false;
		return items.every((want) => actual.some((have) => equals(have, want)));
	});
}
