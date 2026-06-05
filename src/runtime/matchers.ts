import { equals, partialEquals } from "./equals.js";

/**
 * Matcher signature. Returns `{ pass, message }`:
 *   - `pass`: whether the assertion holds.
 *   - `message`: diagnostic message for the failure path. Called lazily to
 *     avoid formatting cost when the matcher passes.
 */
export interface MatcherResult {
	pass: boolean;
	message(): string;
}

export type Matcher<Args extends unknown[] = unknown[]> = (
	received: unknown,
	...args: Args
) => MatcherResult;

export interface SpyLike {
	__helixIsSpy: true;
	calls: unknown[][];
	callCount: number;
}

function isSpy(value: unknown): value is SpyLike {
	// Spies are callable, so `typeof` can be "function" OR "object".
	if (!value || (typeof value !== "object" && typeof value !== "function")) {
		return false;
	}
	const v = value as Partial<SpyLike>;
	return (
		v.__helixIsSpy === true &&
		Array.isArray(v.calls) &&
		typeof v.callCount === "number"
	);
}

function repr(value: unknown, maxLen = 200): string {
	try {
		if (typeof value === "string") {
			const s = JSON.stringify(value);
			return s.length > maxLen ? `${s.slice(0, maxLen)}..."` : s;
		}
		if (typeof value === "function") {
			const src = value.toString();
			return src.length > 40 ? `${src.slice(0, 40)}...` : src;
		}
		if (value === undefined) return "undefined";
		if (value === null) return "null";
		if (typeof value === "bigint") return `${value}n`;
		if (typeof value === "object") {
			const json = JSON.stringify(value);
			if (json === undefined) return String(value);
			return json.length > maxLen ? `${json.slice(0, maxLen)}...` : json;
		}
		return String(value);
	} catch {
		return String(value);
	}
}

export const matchers = {
	toBe(received: unknown, expected: unknown): MatcherResult {
		const pass = Object.is(received, expected);
		return {
			pass,
			message: () =>
				`expected ${repr(received)} to be ${repr(expected)} (strict equality)`,
		};
	},

	toEqual(received: unknown, expected: unknown): MatcherResult {
		const pass = equals(received, expected);
		return {
			pass,
			message: () =>
				`expected ${repr(received)} to deep-equal ${repr(expected)}`,
		};
	},

	toMatchObject(received: unknown, expected: unknown): MatcherResult {
		const pass = partialEquals(received, expected);
		return {
			pass,
			message: () =>
				`expected ${repr(received)} to match subset ${repr(expected)}`,
		};
	},

	toContain(received: unknown, item: unknown): MatcherResult {
		let pass = false;
		if (typeof received === "string" && typeof item === "string") {
			pass = received.includes(item);
		} else if (Array.isArray(received)) {
			// Deep equality so `.toContain({id:1})` works on arrays of objects.
			pass = received.some((x) => equals(x, item));
		} else if (received instanceof Set) {
			// Deep equality: consistent with the Array branch.
			for (const v of received) {
				if (equals(v, item)) {
					pass = true;
					break;
				}
			}
		}
		// NB: `toContain` intentionally does not support `Map` — its semantics
		// (keys? values? entries?) are ambiguous. Users should use
		// `expect([...map.keys()]).toContain(k)` explicitly.
		return {
			pass,
			message: () => `expected ${repr(received)} to contain ${repr(item)}`,
		};
	},

	toMatch(received: unknown, expected: RegExp | string): MatcherResult {
		if (typeof received !== "string") {
			return {
				pass: false,
				message: () =>
					`expected a string, got ${typeof received} (${repr(received)})`,
			};
		}
		const pass =
			expected instanceof RegExp
				? expected.test(received)
				: received.includes(expected);
		return {
			pass,
			message: () =>
				`expected "${received}" to match ${expected instanceof RegExp ? expected : `"${expected}"`}`,
		};
	},

	toHaveLength(received: unknown, length: number): MatcherResult {
		const actual =
			received && typeof (received as { length?: unknown }).length === "number"
				? (received as { length: number }).length
				: undefined;
		return {
			pass: actual === length,
			message: () =>
				`expected length ${length}, got ${actual === undefined ? "no .length" : actual} (value: ${repr(received)})`,
		};
	},

	toBeDefined(received: unknown): MatcherResult {
		return {
			pass: received !== undefined,
			message: () => `expected value to be defined, got undefined`,
		};
	},

	toBeUndefined(received: unknown): MatcherResult {
		return {
			pass: received === undefined,
			message: () => `expected value to be undefined, got ${repr(received)}`,
		};
	},

	toBeNull(received: unknown): MatcherResult {
		return {
			pass: received === null,
			message: () => `expected null, got ${repr(received)}`,
		};
	},

	toBeInstanceOf(received: unknown, ctor: unknown): MatcherResult {
		if (typeof ctor !== "function") {
			return {
				pass: false,
				message: () => `expected a constructor, got ${typeof ctor}`,
			};
		}
		// Arrow functions and bound functions without `prototype` are not
		// constructible; `x instanceof arrowFn` throws TypeError. Reject
		// upfront with a clean AssertionError instead of leaking the raw error.
		const ctorFn = ctor as { prototype?: unknown; name?: string };
		if (ctorFn.prototype === undefined) {
			return {
				pass: false,
				message: () =>
					`expected a constructor (function with a prototype), got ${ctorFn.name ?? "anonymous"} (arrow / bound fn?)`,
			};
		}
		let pass = false;
		try {
			pass = received instanceof (ctor as new (...a: unknown[]) => object);
		} catch {
			pass = false;
		}
		return {
			pass,
			message: () =>
				`expected ${repr(received)} to be instance of ${ctorFn.name ?? "anonymous"}`,
		};
	},

	toBeGreaterThan(received: unknown, expected: number | bigint): MatcherResult {
		if (typeof received !== "number" && typeof received !== "bigint") {
			return {
				pass: false,
				message: () => `expected a number or bigint, got ${typeof received}`,
			};
		}
		return {
			pass: compareGt(received, expected),
			message: () => `expected ${received} to be > ${expected}`,
		};
	},

	toBeGreaterThanOrEqual(
		received: unknown,
		expected: number | bigint,
	): MatcherResult {
		if (typeof received !== "number" && typeof received !== "bigint") {
			return {
				pass: false,
				message: () => `expected a number or bigint, got ${typeof received}`,
			};
		}
		return {
			pass: compareGte(received, expected),
			message: () => `expected ${received} to be >= ${expected}`,
		};
	},

	toBeLessThan(received: unknown, expected: number | bigint): MatcherResult {
		if (typeof received !== "number" && typeof received !== "bigint") {
			return {
				pass: false,
				message: () => `expected a number or bigint, got ${typeof received}`,
			};
		}
		return {
			pass: compareLt(received, expected),
			message: () => `expected ${received} to be < ${expected}`,
		};
	},

	toBeLessThanOrEqual(
		received: unknown,
		expected: number | bigint,
	): MatcherResult {
		if (typeof received !== "number" && typeof received !== "bigint") {
			return {
				pass: false,
				message: () => `expected a number or bigint, got ${typeof received}`,
			};
		}
		return {
			pass: compareLte(received, expected),
			message: () => `expected ${received} to be <= ${expected}`,
		};
	},

	toBeTruthy(received: unknown): MatcherResult {
		return {
			pass: Boolean(received),
			message: () => `expected ${repr(received)} to be truthy`,
		};
	},

	toBeFalsy(received: unknown): MatcherResult {
		return {
			pass: !received,
			message: () => `expected ${repr(received)} to be falsy`,
		};
	},

	toBeNaN(received: unknown): MatcherResult {
		return {
			pass: typeof received === "number" && Number.isNaN(received),
			message: () => `expected ${repr(received)} to be NaN`,
		};
	},

	toThrow(
		received: unknown,
		expected?: string | RegExp | Error | (new (...args: unknown[]) => Error),
	): MatcherResult {
		if (typeof received !== "function") {
			return {
				pass: false,
				message: () => `expected a function, got ${typeof received}`,
			};
		}
		let error: unknown;
		let returned: unknown;
		try {
			returned = received();
		} catch (err) {
			error = err;
		}
		if (
			error === undefined &&
			returned &&
			typeof (returned as { then?: unknown }).then === "function"
		) {
			// Swallow the rejection so it doesn't become an unhandledRejection.
			(returned as Promise<unknown>).catch(() => {});
			return {
				pass: false,
				message: () =>
					`expected function to throw synchronously, but it returned a Promise — use \`expect(fn()).rejects.toThrow(...)\` for async`,
			};
		}
		if (error === undefined) {
			return {
				pass: false,
				message: () => `expected function to throw, but it returned normally`,
			};
		}
		if (expected === undefined) {
			return { pass: true, message: () => `` };
		}
		const pass = matchThrownError(error, expected);
		return {
			pass,
			message: () =>
				`expected function to throw matching ${reprExpected(expected)}, got ${repr(error)}`,
		};
	},

	toHaveBeenCalled(received: unknown): MatcherResult {
		if (!isSpy(received)) {
			return {
				pass: false,
				message: () =>
					`toHaveBeenCalled requires a spy (from vi.fn/vi.spyOn); got ${repr(received)}`,
			};
		}
		return {
			pass: received.callCount > 0,
			message: () =>
				`expected spy to have been called at least once, but it wasn't`,
		};
	},

	toHaveBeenCalledTimes(received: unknown, n: number): MatcherResult {
		if (!isSpy(received)) {
			return {
				pass: false,
				message: () =>
					`toHaveBeenCalledTimes requires a spy; got ${repr(received)}`,
			};
		}
		return {
			pass: received.callCount === n,
			message: () =>
				`expected spy to be called ${n} times, got ${received.callCount}`,
		};
	},

	toHaveBeenCalledWith(
		received: unknown,
		...expectedArgs: unknown[]
	): MatcherResult {
		if (!isSpy(received)) {
			return {
				pass: false,
				message: () =>
					`toHaveBeenCalledWith requires a spy; got ${repr(received)}`,
			};
		}
		const pass = received.calls.some((actualArgs) =>
			equals(actualArgs, expectedArgs),
		);
		return {
			pass,
			message: () =>
				`expected spy to have been called with ${repr(expectedArgs)}\nActual calls: ${repr(received.calls)}`,
		};
	},

	toHaveBeenCalledOnce(received: unknown): MatcherResult {
		if (!isSpy(received)) {
			return {
				pass: false,
				message: () =>
					`toHaveBeenCalledOnce requires a spy; got ${repr(received)}`,
			};
		}
		return {
			pass: received.callCount === 1,
			message: () =>
				`expected spy to have been called exactly once, got ${received.callCount} calls`,
		};
	},
};

/**
 * Cross-type numeric comparison: JS's `>` / `>=` operators accept mixed
 * `number` and `bigint` operands, but TypeScript refuses the union. These
 * helpers narrow through typeof so the comparison is fully typed.
 */
function compareGt(a: number | bigint, b: number | bigint): boolean {
	if (typeof a === "number" && typeof b === "number") return a > b;
	if (typeof a === "bigint" && typeof b === "bigint") return a > b;
	// Mixed number/bigint — JS's `>` operator accepts it at runtime. Coerce
	// both sides to a common `number` view for the comparison; BigInt values
	// outside Number range lose precision only when larger than 2^53, which
	// is acceptable for ordering.
	return Number(a) > Number(b);
}

function compareGte(a: number | bigint, b: number | bigint): boolean {
	if (typeof a === "number" && typeof b === "number") return a >= b;
	if (typeof a === "bigint" && typeof b === "bigint") return a >= b;
	return Number(a) >= Number(b);
}

function compareLt(a: number | bigint, b: number | bigint): boolean {
	if (typeof a === "number" && typeof b === "number") return a < b;
	if (typeof a === "bigint" && typeof b === "bigint") return a < b;
	return Number(a) < Number(b);
}

function compareLte(a: number | bigint, b: number | bigint): boolean {
	if (typeof a === "number" && typeof b === "number") return a <= b;
	if (typeof a === "bigint" && typeof b === "bigint") return a <= b;
	return Number(a) <= Number(b);
}

function matchThrownError(
	error: unknown,
	expected: string | RegExp | Error | (new (...args: unknown[]) => Error),
): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	if (typeof expected === "string") return msg.includes(expected);
	if (expected instanceof RegExp) return expected.test(msg);
	if (expected instanceof Error) {
		return (
			error instanceof Error &&
			msg === expected.message &&
			Object.getPrototypeOf(error) === Object.getPrototypeOf(expected)
		);
	}
	// Ctor.
	return error instanceof (expected as new (...args: unknown[]) => Error);
}

function reprExpected(
	expected: string | RegExp | Error | (new (...args: unknown[]) => Error),
): string {
	if (typeof expected === "string") return `"${expected}"`;
	if (expected instanceof RegExp) return String(expected);
	if (expected instanceof Error)
		return `${expected.constructor.name}("${expected.message}")`;
	return (expected as { name?: string }).name ?? "anonymous";
}

export type MatcherName = keyof typeof matchers;
