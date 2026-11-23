import { E_HELIX_ASSERTION_FAILED } from "../errors.js";

export type { AssertionErrorInit } from "../errors.js";

/** Whether `value` is the error a failed `expect` or `assert` throws. */
export function isAssertionError(
	value: unknown,
): value is E_HELIX_ASSERTION_FAILED {
	return value instanceof E_HELIX_ASSERTION_FAILED;
}
