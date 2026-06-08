/**
 * Assertion error thrown by `expect` — carries structured fields so runners
 * (Vitest-compatible reporters, IDE integrations) can render diffs.
 */
export interface AssertionErrorInit {
	message: string;
	actual?: unknown;
	expected?: unknown;
	operator?: string;
	showDiff?: boolean;
}

export class AssertionError extends Error {
	readonly actual: unknown;
	readonly expected: unknown;
	readonly operator: string | undefined;
	readonly showDiff: boolean;

	constructor(init: AssertionErrorInit) {
		super(init.message);
		this.name = "AssertionError";
		this.actual = init.actual;
		this.expected = init.expected;
		this.operator = init.operator;
		this.showDiff = init.showDiff ?? true;
		// V8 only: strip framework frames so the stack points at user code.
		const capture = (
			Error as { captureStackTrace?: (target: object, ctor: object) => void }
		).captureStackTrace;
		if (typeof capture === "function") {
			capture(this, AssertionError);
		}
	}
}

export function isAssertionError(value: unknown): value is AssertionError {
	return value instanceof AssertionError;
}
