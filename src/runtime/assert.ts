/**
 * `assert` — Japa/`@japa/assert` (chai-flavored) assertion surface, injected on
 * every test context as `ctx.assert`. Complements the Vitest `expect` API; some
 * teams (and the Adonis docs) reach for `assert.*`. Each call records an
 * assertion so `assert.plan(n)` / `expect.assertions(n)` stay accurate.
 */

import { AssertionError } from "./assertion-error.js";
import { equals } from "./equals.js";
import { recordAssertion, setExpectedAssertions } from "./test-context.js";

function raise(message: string, actual?: unknown, expected?: unknown): never {
	throw new AssertionError({ message, actual, expected });
}

function ok(
	condition: boolean,
	message: string,
	actual?: unknown,
	expected?: unknown,
): void {
	recordAssertion();
	if (!condition) raise(message, actual, expected);
}

/** Read a property off an unknown value without a cast (Reflect narrows). */
function prop(obj: unknown, key: PropertyKey): unknown {
	if (obj !== null && (typeof obj === "object" || typeof obj === "function")) {
		return Reflect.get(obj, key);
	}
	return undefined;
}

function stringify(v: unknown): string {
	if (typeof v === "string") return JSON.stringify(v);
	if (typeof v === "bigint") return `${v}n`;
	if (v === undefined) return "undefined";
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
}

function typeName(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

/** Length/size of strings, arrays, Map/Set, or array-likes; else undefined. */
function sizeOf(v: unknown): number | undefined {
	if (typeof v === "string" || Array.isArray(v)) return v.length;
	if (v instanceof Map || v instanceof Set) return v.size;
	const len = prop(v, "length");
	return typeof len === "number" ? len : undefined;
}

function isEmptyValue(v: unknown): boolean {
	const s = sizeOf(v);
	if (s !== undefined) return s === 0;
	if (v !== null && typeof v === "object") return Object.keys(v).length === 0;
	return false;
}

type ErrorMatcher = RegExp | string | (new (...args: never[]) => Error);

function matchesError(err: unknown, matcher?: ErrorMatcher): boolean {
	if (matcher === undefined) return true;
	if (typeof matcher === "string") {
		return err instanceof Error && err.message.includes(matcher);
	}
	if (matcher instanceof RegExp) {
		return err instanceof Error && matcher.test(err.message);
	}
	return err instanceof matcher;
}

/** Loose equality (chai `assert.equal` semantics). Isolated so the `==` is deliberate. */
function looseEqual(a: unknown, b: unknown): boolean {
	// biome-ignore lint/suspicious/noDoubleEquals: chai/@japa `assert.equal` is intentionally non-strict (`==`); `strictEqual` covers `===`.
	return a == b;
}

/** The chai-like assertion surface. Callable (`assert(value, msg)` = truthy). */
export interface Assert {
	(value: unknown, message?: string): void;

	equal(actual: unknown, expected: unknown, message?: string): void;
	notEqual(actual: unknown, expected: unknown, message?: string): void;
	strictEqual(actual: unknown, expected: unknown, message?: string): void;
	notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	notDeepEqual(actual: unknown, expected: unknown, message?: string): void;

	isTrue(value: unknown, message?: string): void;
	isFalse(value: unknown, message?: string): void;
	isOk(value: unknown, message?: string): void;
	isNotOk(value: unknown, message?: string): void;
	isNull(value: unknown, message?: string): void;
	isNotNull(value: unknown, message?: string): void;
	isUndefined(value: unknown, message?: string): void;
	isDefined(value: unknown, message?: string): void;
	exists(value: unknown, message?: string): void;
	notExists(value: unknown, message?: string): void;

	isAbove(value: number, above: number, message?: string): void;
	isBelow(value: number, below: number, message?: string): void;
	isAtLeast(value: number, atLeast: number, message?: string): void;
	isAtMost(value: number, atMost: number, message?: string): void;

	lengthOf(value: unknown, length: number, message?: string): void;
	isEmpty(value: unknown, message?: string): void;
	isNotEmpty(value: unknown, message?: string): void;

	include(haystack: unknown, needle: unknown, message?: string): void;
	notInclude(haystack: unknown, needle: unknown, message?: string): void;

	property(object: unknown, key: string, message?: string): void;
	notProperty(object: unknown, key: string, message?: string): void;
	propertyVal(
		object: unknown,
		key: string,
		value: unknown,
		message?: string,
	): void;

	instanceOf(
		value: unknown,
		ctor: new (...args: never[]) => object,
		message?: string,
	): void;
	notInstanceOf(
		value: unknown,
		ctor: new (...args: never[]) => object,
		message?: string,
	): void;
	typeOf(value: unknown, type: string, message?: string): void;
	isArray(value: unknown, message?: string): void;
	isObject(value: unknown, message?: string): void;
	isString(value: unknown, message?: string): void;
	isNumber(value: unknown, message?: string): void;
	isBoolean(value: unknown, message?: string): void;
	isFunction(value: unknown, message?: string): void;
	isNaN(value: unknown, message?: string): void;

	match(value: string, regex: RegExp, message?: string): void;
	notMatch(value: string, regex: RegExp, message?: string): void;
	oneOf(value: unknown, list: readonly unknown[], message?: string): void;

	/** Alias of `isOk` — value is truthy (@japa/assert). */
	ok(value: unknown, message?: string): void;
	/** Alias of `isNotOk` — value is falsy (@japa/assert). */
	notOk(value: unknown, message?: string): void;
	/** Alias of `isEmpty` (@japa/assert). */
	empty(value: unknown, message?: string): void;
	/** Alias of `isNotEmpty` (@japa/assert). */
	notEmpty(value: unknown, message?: string): void;
	/** Deep membership: array contains a deeply-equal element, or object contains the subset. */
	deepInclude(haystack: unknown, needle: unknown, message?: string): void;
	/** Negation of {@link deepInclude}. */
	notDeepInclude(haystack: unknown, needle: unknown, message?: string): void;
	/** Object owns ALL of `keys` (@japa/assert `properties`). */
	properties(object: unknown, keys: readonly string[], message?: string): void;
	/** Object is MISSING at least one of `keys` (@japa/assert `notAllProperties`). */
	notAllProperties(
		object: unknown,
		keys: readonly string[],
		message?: string,
	): void;
	/** Object's own keys are EXACTLY `keys` (@japa/assert `onlyProperties`). */
	onlyProperties(
		object: unknown,
		keys: readonly string[],
		message?: string,
	): void;
	/** Object owns NONE of `keys` (@japa/assert `notAnyProperties`). */
	notAnyProperties(
		object: unknown,
		keys: readonly string[],
		message?: string,
	): void;

	/** Negation helpers + numeric/object-state matchers (chai / @japa/assert). */
	isNotTrue(value: unknown, message?: string): void;
	isNotFalse(value: unknown, message?: string): void;
	isNotArray(value: unknown, message?: string): void;
	isNotObject(value: unknown, message?: string): void;
	isNotString(value: unknown, message?: string): void;
	isNotNumber(value: unknown, message?: string): void;
	isNotBoolean(value: unknown, message?: string): void;
	/** Value is a finite number (not NaN/±Infinity). */
	isFinite(value: unknown, message?: string): void;
	/** `|actual - expected| <= delta`. */
	closeTo(
		actual: number,
		expected: number,
		delta: number,
		message?: string,
	): void;
	isFrozen(value: unknown, message?: string): void;
	isNotFrozen(value: unknown, message?: string): void;
	isSealed(value: unknown, message?: string): void;
	isNotSealed(value: unknown, message?: string): void;
	/** Object's `key` does NOT deeply equal `value`. */
	notPropertyVal(
		object: unknown,
		key: string,
		value: unknown,
		message?: string,
	): void;
	/** Length/size is NOT `length`. */
	notLengthOf(value: unknown, length: number, message?: string): void;

	throws(fn: () => unknown, matcher?: ErrorMatcher, message?: string): void;
	doesNotThrow(fn: () => unknown, message?: string): void;
	rejects(
		fn: () => Promise<unknown>,
		matcher?: ErrorMatcher,
		message?: string,
	): Promise<void>;
	doesNotReject(fn: () => Promise<unknown>, message?: string): Promise<void>;

	/** Force a failure. */
	fail(message?: string): never;
	/** Declare the exact number of assertions this test must make (Japa parity). */
	plan(count: number): void;
}

/** Create the assertion surface. State-free — assertion counting reads the frame. */
export function createAssert(): Assert {
	const base = (value: unknown, message?: string): void => {
		ok(Boolean(value), message ?? `expected ${stringify(value)} to be truthy`);
	};

	const methods = {
		equal(actual: unknown, expected: unknown, message?: string): void {
			ok(
				looseEqual(actual, expected),
				message ?? `expected ${stringify(actual)} == ${stringify(expected)}`,
				actual,
				expected,
			);
		},
		notEqual(actual: unknown, expected: unknown, message?: string): void {
			ok(
				!looseEqual(actual, expected),
				message ?? `expected ${stringify(actual)} != ${stringify(expected)}`,
				actual,
				expected,
			);
		},
		strictEqual(actual: unknown, expected: unknown, message?: string): void {
			ok(
				actual === expected,
				message ?? `expected ${stringify(actual)} === ${stringify(expected)}`,
				actual,
				expected,
			);
		},
		notStrictEqual(actual: unknown, expected: unknown, message?: string): void {
			ok(
				actual !== expected,
				message ?? `expected ${stringify(actual)} !== ${stringify(expected)}`,
				actual,
				expected,
			);
		},
		deepEqual(actual: unknown, expected: unknown, message?: string): void {
			ok(
				equals(actual, expected),
				message ?? "expected deep equality",
				actual,
				expected,
			);
		},
		notDeepEqual(actual: unknown, expected: unknown, message?: string): void {
			ok(
				!equals(actual, expected),
				message ?? "expected deep inequality",
				actual,
				expected,
			);
		},
		isTrue(value: unknown, message?: string): void {
			ok(value === true, message ?? `expected ${stringify(value)} to be true`);
		},
		isFalse(value: unknown, message?: string): void {
			ok(
				value === false,
				message ?? `expected ${stringify(value)} to be false`,
			);
		},
		isOk(value: unknown, message?: string): void {
			ok(
				Boolean(value),
				message ?? `expected ${stringify(value)} to be truthy`,
			);
		},
		isNotOk(value: unknown, message?: string): void {
			ok(!value, message ?? `expected ${stringify(value)} to be falsy`);
		},
		isNull(value: unknown, message?: string): void {
			ok(value === null, message ?? `expected ${stringify(value)} to be null`);
		},
		isNotNull(value: unknown, message?: string): void {
			ok(value !== null, message ?? "expected value not to be null");
		},
		isUndefined(value: unknown, message?: string): void {
			ok(
				value === undefined,
				message ?? `expected ${stringify(value)} to be undefined`,
			);
		},
		isDefined(value: unknown, message?: string): void {
			ok(value !== undefined, message ?? "expected value to be defined");
		},
		exists(value: unknown, message?: string): void {
			ok(
				value !== null && value !== undefined,
				message ?? "expected value to exist",
			);
		},
		notExists(value: unknown, message?: string): void {
			ok(
				value === null || value === undefined,
				message ?? `expected ${stringify(value)} to be null or undefined`,
			);
		},
		isAbove(value: number, above: number, message?: string): void {
			ok(value > above, message ?? `expected ${value} > ${above}`);
		},
		isBelow(value: number, below: number, message?: string): void {
			ok(value < below, message ?? `expected ${value} < ${below}`);
		},
		isAtLeast(value: number, atLeast: number, message?: string): void {
			ok(value >= atLeast, message ?? `expected ${value} >= ${atLeast}`);
		},
		isAtMost(value: number, atMost: number, message?: string): void {
			ok(value <= atMost, message ?? `expected ${value} <= ${atMost}`);
		},
		lengthOf(value: unknown, length: number, message?: string): void {
			const s = sizeOf(value);
			ok(s === length, message ?? `expected length ${length}, got ${s}`);
		},
		isEmpty(value: unknown, message?: string): void {
			ok(
				isEmptyValue(value),
				message ?? `expected ${stringify(value)} to be empty`,
			);
		},
		isNotEmpty(value: unknown, message?: string): void {
			ok(!isEmptyValue(value), message ?? "expected value not to be empty");
		},
		include(haystack: unknown, needle: unknown, message?: string): void {
			let found = false;
			if (typeof haystack === "string" && typeof needle === "string")
				found = haystack.includes(needle);
			else if (Array.isArray(haystack))
				found = haystack.some((el) => equals(el, needle));
			else if (needle !== null && typeof needle === "object") {
				found = Object.entries(needle).every(([k, v]) =>
					equals(prop(haystack, k), v),
				);
			}
			ok(
				found,
				message ??
					`expected ${stringify(haystack)} to include ${stringify(needle)}`,
			);
		},
		notInclude(haystack: unknown, needle: unknown, message?: string): void {
			let found = false;
			if (typeof haystack === "string" && typeof needle === "string")
				found = haystack.includes(needle);
			else if (Array.isArray(haystack))
				found = haystack.some((el) => equals(el, needle));
			ok(
				!found,
				message ??
					`expected ${stringify(haystack)} not to include ${stringify(needle)}`,
			);
		},
		property(object: unknown, key: string, message?: string): void {
			ok(
				object !== null && typeof object === "object" && key in object,
				message ?? `expected object to have property ${stringify(key)}`,
			);
		},
		notProperty(object: unknown, key: string, message?: string): void {
			ok(
				!(object !== null && typeof object === "object" && key in object),
				message ?? `expected object not to have property ${stringify(key)}`,
			);
		},
		propertyVal(
			object: unknown,
			key: string,
			value: unknown,
			message?: string,
		): void {
			const has =
				object !== null && typeof object === "object" && key in object;
			const actual = has ? prop(object, key) : undefined;
			ok(
				has && equals(actual, value),
				message ??
					`expected property ${stringify(key)} to equal ${stringify(value)}`,
				actual,
				value,
			);
		},
		instanceOf(
			value: unknown,
			ctor: new (...args: never[]) => object,
			message?: string,
		): void {
			ok(
				value instanceof ctor,
				message ?? `expected value to be instance of ${ctor.name}`,
			);
		},
		notInstanceOf(
			value: unknown,
			ctor: new (...args: never[]) => object,
			message?: string,
		): void {
			ok(
				!(value instanceof ctor),
				message ?? `expected value not to be instance of ${ctor.name}`,
			);
		},
		typeOf(value: unknown, type: string, message?: string): void {
			ok(
				typeName(value) === type,
				message ?? `expected type ${type}, got ${typeName(value)}`,
			);
		},
		isArray(value: unknown, message?: string): void {
			ok(
				Array.isArray(value),
				message ?? `expected ${stringify(value)} to be an array`,
			);
		},
		isObject(value: unknown, message?: string): void {
			ok(
				value !== null && typeof value === "object" && !Array.isArray(value),
				message ?? "expected value to be an object",
			);
		},
		isString(value: unknown, message?: string): void {
			ok(typeof value === "string", message ?? "expected value to be a string");
		},
		isNumber(value: unknown, message?: string): void {
			ok(typeof value === "number", message ?? "expected value to be a number");
		},
		isBoolean(value: unknown, message?: string): void {
			ok(
				typeof value === "boolean",
				message ?? "expected value to be a boolean",
			);
		},
		isFunction(value: unknown, message?: string): void {
			ok(
				typeof value === "function",
				message ?? "expected value to be a function",
			);
		},
		isNaN(value: unknown, message?: string): void {
			ok(
				typeof value === "number" && Number.isNaN(value),
				message ?? "expected value to be NaN",
			);
		},
		match(value: string, regex: RegExp, message?: string): void {
			ok(
				regex.test(value),
				message ?? `expected ${stringify(value)} to match ${regex}`,
			);
		},
		notMatch(value: string, regex: RegExp, message?: string): void {
			ok(
				!regex.test(value),
				message ?? `expected ${stringify(value)} not to match ${regex}`,
			);
		},
		oneOf(value: unknown, list: readonly unknown[], message?: string): void {
			ok(
				list.some((el) => equals(el, value)),
				message ??
					`expected ${stringify(value)} to be one of ${stringify(list)}`,
			);
		},
		ok(value: unknown, message?: string): void {
			ok(
				Boolean(value),
				message ?? `expected ${stringify(value)} to be truthy`,
			);
		},
		notOk(value: unknown, message?: string): void {
			ok(!value, message ?? `expected ${stringify(value)} to be falsy`);
		},
		empty(value: unknown, message?: string): void {
			ok(
				isEmptyValue(value),
				message ?? `expected ${stringify(value)} to be empty`,
			);
		},
		notEmpty(value: unknown, message?: string): void {
			ok(!isEmptyValue(value), message ?? "expected value not to be empty");
		},
		deepInclude(haystack: unknown, needle: unknown, message?: string): void {
			let found = false;
			if (Array.isArray(haystack))
				found = haystack.some((el) => equals(el, needle));
			else if (needle !== null && typeof needle === "object") {
				found = Object.entries(needle).every(([k, v]) =>
					equals(prop(haystack, k), v),
				);
			}
			ok(
				found,
				message ??
					`expected ${stringify(haystack)} to deep-include ${stringify(needle)}`,
			);
		},
		notDeepInclude(haystack: unknown, needle: unknown, message?: string): void {
			let found = false;
			if (Array.isArray(haystack))
				found = haystack.some((el) => equals(el, needle));
			else if (needle !== null && typeof needle === "object") {
				found = Object.entries(needle).every(([k, v]) =>
					equals(prop(haystack, k), v),
				);
			}
			ok(
				!found,
				message ??
					`expected ${stringify(haystack)} not to deep-include ${stringify(needle)}`,
			);
		},
		properties(
			object: unknown,
			keys: readonly string[],
			message?: string,
		): void {
			const has =
				object !== null &&
				typeof object === "object" &&
				keys.every((k) => k in object);
			ok(
				has,
				message ?? `expected object to have properties ${stringify(keys)}`,
			);
		},
		notAllProperties(
			object: unknown,
			keys: readonly string[],
			message?: string,
		): void {
			const hasAll =
				object !== null &&
				typeof object === "object" &&
				keys.every((k) => k in object);
			ok(
				!hasAll,
				message ??
					`expected object to be missing at least one of ${stringify(keys)}`,
			);
		},
		onlyProperties(
			object: unknown,
			keys: readonly string[],
			message?: string,
		): void {
			const own =
				object !== null && typeof object === "object"
					? Object.keys(object)
					: [];
			const want = new Set(keys);
			const exact = own.length === want.size && own.every((k) => want.has(k));
			ok(
				exact,
				message ??
					`expected object keys to be exactly ${stringify(keys)}, got ${stringify(own)}`,
			);
		},
		notAnyProperties(
			object: unknown,
			keys: readonly string[],
			message?: string,
		): void {
			const hasAny =
				object !== null &&
				typeof object === "object" &&
				keys.some((k) => k in object);
			ok(
				!hasAny,
				message ?? `expected object to own none of ${stringify(keys)}`,
			);
		},
		isNotTrue(value: unknown, message?: string): void {
			ok(
				value !== true,
				message ?? `expected ${stringify(value)} not to be true`,
			);
		},
		isNotFalse(value: unknown, message?: string): void {
			ok(
				value !== false,
				message ?? `expected ${stringify(value)} not to be false`,
			);
		},
		isNotArray(value: unknown, message?: string): void {
			ok(!Array.isArray(value), message ?? "expected value not to be an array");
		},
		isNotObject(value: unknown, message?: string): void {
			ok(
				value === null || typeof value !== "object" || Array.isArray(value),
				message ?? "expected value not to be an object",
			);
		},
		isNotString(value: unknown, message?: string): void {
			ok(
				typeof value !== "string",
				message ?? "expected value not to be a string",
			);
		},
		isNotNumber(value: unknown, message?: string): void {
			ok(
				typeof value !== "number",
				message ?? "expected value not to be a number",
			);
		},
		isNotBoolean(value: unknown, message?: string): void {
			ok(
				typeof value !== "boolean",
				message ?? "expected value not to be a boolean",
			);
		},
		isFinite(value: unknown, message?: string): void {
			ok(
				typeof value === "number" && Number.isFinite(value),
				message ?? `expected ${stringify(value)} to be a finite number`,
			);
		},
		closeTo(
			actual: number,
			expected: number,
			delta: number,
			message?: string,
		): void {
			ok(
				Math.abs(actual - expected) <= delta,
				message ?? `expected ${actual} to be within ${delta} of ${expected}`,
			);
		},
		isFrozen(value: unknown, message?: string): void {
			ok(Object.isFrozen(value), message ?? "expected value to be frozen");
		},
		isNotFrozen(value: unknown, message?: string): void {
			ok(!Object.isFrozen(value), message ?? "expected value not to be frozen");
		},
		isSealed(value: unknown, message?: string): void {
			ok(Object.isSealed(value), message ?? "expected value to be sealed");
		},
		isNotSealed(value: unknown, message?: string): void {
			ok(!Object.isSealed(value), message ?? "expected value not to be sealed");
		},
		notPropertyVal(
			object: unknown,
			key: string,
			value: unknown,
			message?: string,
		): void {
			const has =
				object !== null && typeof object === "object" && key in object;
			const actual = has ? prop(object, key) : undefined;
			ok(
				!(has && equals(actual, value)),
				message ??
					`expected property ${stringify(key)} not to equal ${stringify(value)}`,
			);
		},
		notLengthOf(value: unknown, length: number, message?: string): void {
			ok(
				sizeOf(value) !== length,
				message ?? `expected length not to be ${length}`,
			);
		},
		throws(fn: () => unknown, matcher?: ErrorMatcher, message?: string): void {
			let thrown: unknown;
			let didThrow = false;
			try {
				fn();
			} catch (err) {
				didThrow = true;
				thrown = err;
			}
			ok(
				didThrow && matchesError(thrown, matcher),
				message ??
					`expected function to throw${matcher ? " matching error" : ""}`,
			);
		},
		doesNotThrow(fn: () => unknown, message?: string): void {
			let didThrow = false;
			try {
				fn();
			} catch {
				didThrow = true;
			}
			ok(!didThrow, message ?? "expected function not to throw");
		},
		async rejects(
			fn: () => Promise<unknown>,
			matcher?: ErrorMatcher,
			message?: string,
		): Promise<void> {
			let thrown: unknown;
			let didReject = false;
			try {
				await fn();
			} catch (err) {
				didReject = true;
				thrown = err;
			}
			ok(
				didReject && matchesError(thrown, matcher),
				message ??
					`expected promise to reject${matcher ? " matching error" : ""}`,
			);
		},
		async doesNotReject(
			fn: () => Promise<unknown>,
			message?: string,
		): Promise<void> {
			let didReject = false;
			try {
				await fn();
			} catch {
				didReject = true;
			}
			ok(!didReject, message ?? "expected promise not to reject");
		},
		fail(message?: string): never {
			recordAssertion();
			raise(message ?? "assert.fail()");
		},
		plan(count: number): void {
			setExpectedAssertions(count);
		},
	};

	const built: Assert = Object.assign(base, methods);
	return built;
}
