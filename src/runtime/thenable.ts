/**
 * Is this value thenable?
 *
 * Written once because the check appeared in four places, each spelling it as
 * `typeof (x as { then?: unknown }).then === "function"` — a cast whose only
 * job was to reach a property, on a value the surrounding condition had not
 * proven was an object. `in` narrows, so nothing has to be asserted.
 *
 * A thenable FUNCTION is exotic but legal, and the checks this replaces
 * accepted one, so both object and function pass.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	);
}

/**
 * Does this value carry a numeric `length`?
 *
 * Same reason as {@link isThenable}: the check was two casts, one to test the
 * property and one to read it, on a value only proven truthy.
 */
export function hasLength(value: unknown): value is { length: number } {
	// A string has one and is not an object — `in` cannot ask a primitive, and
	// the check this replaces accepted strings, which `toHaveLength("abc", 3)`
	// depends on.
	if (typeof value === "string") return true;
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		"length" in value &&
		typeof value.length === "number"
	);
}
