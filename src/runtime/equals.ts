/**
 * Deep structural equality — Vitest-compatible semantics.
 *
 * Handles: primitives (Object.is for NaN; ±0 treated equal in non-strict toEqual),
 * Date, RegExp, Map, Set, Array, Buffer, typed arrays, DataView, boxed primitives
 * (Number/String/Boolean), Error instances, circular refs, Symbol-keyed props.
 * Ignores prototypes for plain objects (matches Jest/Vitest `toEqual`).
 *
 * `toStrictEqual` semantics (checks prototype + undefined-vs-missing keys)
 * are supported via the `strict` option.
 */

export interface EqualsOptions {
	/** `toStrictEqual` semantics — prototypes matched, undefined keys distinguished from missing. */
	strict?: boolean;
}

type Seen = WeakMap<object, WeakSet<object>>;

export function equals(
	a: unknown,
	b: unknown,
	options: EqualsOptions = {},
): boolean {
	return eq(a, b, options, new WeakMap());
}

/**
 * Record a pair as "in progress" in BOTH directions so a later visit to the
 * mirrored pair (b,a) is detected as a cycle too.
 */
function markSeen(seen: Seen, a: object, b: object): void {
	let setA = seen.get(a);
	if (!setA) {
		setA = new WeakSet();
		seen.set(a, setA);
	}
	setA.add(b);
	let setB = seen.get(b);
	if (!setB) {
		setB = new WeakSet();
		seen.set(b, setB);
	}
	setB.add(a);
}

function seenPair(seen: Seen, a: object, b: object): boolean {
	return seen.get(a)?.has(b) ?? false;
}

/**
 * A structural comparator for one object "kind". Returns `true`/`false` when it
 * recognises the pair as its kind (and decides equality), or `undefined` to
 * mean "not my kind — let the next comparator try". This keeps `eq` a flat
 * dispatch loop instead of a 150-line `instanceof` ladder.
 */
type Comparator = (
	a: object,
	b: object,
	opts: EqualsOptions,
	seen: Seen,
) => boolean | undefined;

function isBoxedPrimitive(v: object): boolean {
	return v instanceof Number || v instanceof String || v instanceof Boolean;
}

// Boxed primitives — unwrap so `new Number(1)` vs `new Number(2)` differ
// properly; a box compared against anything not the same box type is unequal.
function compareBoxed(a: object, b: object): boolean | undefined {
	if (a instanceof Number && b instanceof Number)
		return Object.is(a.valueOf(), b.valueOf());
	if (a instanceof String && b instanceof String)
		return Object.is(a.valueOf(), b.valueOf());
	if (a instanceof Boolean && b instanceof Boolean)
		return Object.is(a.valueOf(), b.valueOf());
	if (isBoxedPrimitive(a) || isBoxedPrimitive(b)) return false;
	return undefined;
}

function compareDate(a: object, b: object): boolean | undefined {
	if (!(a instanceof Date) && !(b instanceof Date)) return undefined;
	return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
}

function compareRegExp(a: object, b: object): boolean | undefined {
	if (!(a instanceof RegExp) && !(b instanceof RegExp)) return undefined;
	return (
		a instanceof RegExp &&
		b instanceof RegExp &&
		a.source === b.source &&
		a.flags === b.flags
	);
}

// Error instances — compare name + message + own enumerable keys. The built-in
// fields are non-enumerable so plain-keys comparison alone would report any two
// Errors as equal.
function compareError(
	a: object,
	b: object,
	opts: EqualsOptions,
	seen: Seen,
): boolean | undefined {
	if (!(a instanceof Error) && !(b instanceof Error)) return undefined;
	if (!(a instanceof Error && b instanceof Error)) return false;
	if (a.name !== b.name) return false;
	if (a.message !== b.message) return false;
	return compareOwnKeys(a, b, opts, seen);
}

// DataView — compare by byteLength + getUint8 byte-for-byte.
function compareDataView(a: object, b: object): boolean | undefined {
	if (!(a instanceof DataView) && !(b instanceof DataView)) return undefined;
	if (!(a instanceof DataView && b instanceof DataView)) return false;
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i += 1) {
		if (a.getUint8(i) !== b.getUint8(i)) return false;
	}
	return true;
}

// Buffer — shortcut via Buffer.equals when both are Buffers. When only one is a
// Buffer, return `undefined` so the typed-array comparator handles it (a Buffer
// is a Uint8Array): a constructor mismatch there yields the correct inequality.
function compareBuffer(a: object, b: object): boolean | undefined {
	if (typeof Buffer === "undefined") return undefined;
	if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
	return undefined;
}

// Typed arrays (Uint8Array, Int16Array, Float64Array, BigInt64Array, …).
// Require matching constructor so Uint8Array !== Int8Array even when values coincide.
function compareTypedArray(
	a: object,
	b: object,
	opts: EqualsOptions,
): boolean | undefined {
	const viewA = asNumericTypedArray(a);
	const viewB = asNumericTypedArray(b);
	if (!viewA && !viewB) return undefined;
	if (!viewA || !viewB) return false;
	if (a.constructor !== b.constructor) return false;
	if (viewA.length !== viewB.length) return false;
	for (let i = 0; i < viewA.length; i += 1) {
		const av = viewA[i];
		const bv = viewB[i];
		// Object.is so NaN === NaN inside Float32/64Array.
		if (Object.is(av, bv)) continue;
		if (opts.strict) return false;
		if (av !== bv) return false; // non-strict: ±0 already caught by `===`.
	}
	return true;
}

function compareArray(
	a: object,
	b: object,
	opts: EqualsOptions,
	seen: Seen,
): boolean | undefined {
	if (!Array.isArray(a) && !Array.isArray(b)) return undefined;
	if (!(Array.isArray(a) && Array.isArray(b))) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (!eq(a[i], b[i], opts, seen)) return false;
	}
	return true;
}

// Maps — structural key comparison supporting object keys.
function compareMap(
	a: object,
	b: object,
	opts: EqualsOptions,
	seen: Seen,
): boolean | undefined {
	if (!(a instanceof Map) && !(b instanceof Map)) return undefined;
	if (!(a instanceof Map && b instanceof Map)) return false;
	if (a.size !== b.size) return false;
	for (const [kA, vA] of a) {
		// Fast path: identity/primitive key hit.
		if (b.has(kA) && eq(vA, b.get(kA), opts, seen)) continue;
		// Structural search across remaining entries.
		let matched = false;
		for (const [kB, vB] of b) {
			if (eq(kA, kB, opts, seen) && eq(vA, vB, opts, seen)) {
				matched = true;
				break;
			}
		}
		if (!matched) return false;
	}
	return true;
}

// Sets — deep structural. Use a fresh WeakMap per inner comparison so an
// earlier failed candidate does not poison the next one via cycle cache.
function compareSet(
	a: object,
	b: object,
	opts: EqualsOptions,
): boolean | undefined {
	if (!(a instanceof Set) && !(b instanceof Set)) return undefined;
	if (!(a instanceof Set && b instanceof Set)) return false;
	if (a.size !== b.size) return false;
	for (const v of a) {
		let found = false;
		for (const w of b) {
			if (eq(v, w, opts, new WeakMap())) {
				found = true;
				break;
			}
		}
		if (!found) return false;
	}
	return true;
}

// Order matters — mirrors the original `instanceof` ladder. Buffer sits before
// typed arrays so the both-Buffer fast path wins before the generic view check.
const STRUCTURAL_COMPARATORS: readonly Comparator[] = [
	compareDate,
	compareRegExp,
	compareError,
	compareDataView,
	compareBuffer,
	compareTypedArray,
	compareArray,
	compareMap,
	compareSet,
];

function eq(a: unknown, b: unknown, opts: EqualsOptions, seen: Seen): boolean {
	// Identity / NaN (Object.is). In non-strict mode, ±0 are also equal.
	if (Object.is(a, b)) return true;
	if (!opts.strict && a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;

	const objA = a as object;
	const objB = b as object;

	if (seenPair(seen, objA, objB)) return true;
	markSeen(seen, objA, objB);

	const boxed = compareBoxed(objA, objB);
	if (boxed !== undefined) return boxed;

	// Strict: differing prototypes → not equal (plain `{}` vs class instance).
	if (
		opts.strict &&
		Object.getPrototypeOf(objA) !== Object.getPrototypeOf(objB)
	) {
		return false;
	}

	for (const compare of STRUCTURAL_COMPARATORS) {
		const result = compare(objA, objB, opts, seen);
		if (result !== undefined) return result;
	}

	return compareOwnKeys(objA, objB, opts, seen);
}

function getProp(obj: object, key: PropertyKey): unknown {
	return Reflect.get(obj, key);
}

type NumericTypedArray =
	| Int8Array
	| Uint8Array
	| Uint8ClampedArray
	| Int16Array
	| Uint16Array
	| Int32Array
	| Uint32Array
	| Float32Array
	| Float64Array
	| BigInt64Array
	| BigUint64Array;

function asNumericTypedArray(v: object): NumericTypedArray | undefined {
	if (
		v instanceof Int8Array ||
		v instanceof Uint8Array ||
		v instanceof Uint8ClampedArray ||
		v instanceof Int16Array ||
		v instanceof Uint16Array ||
		v instanceof Int32Array ||
		v instanceof Uint32Array ||
		v instanceof Float32Array ||
		v instanceof Float64Array ||
		v instanceof BigInt64Array ||
		v instanceof BigUint64Array
	) {
		return v;
	}
	return undefined;
}

function compareOwnKeys(
	objA: object,
	objB: object,
	opts: EqualsOptions,
	seen: Seen,
): boolean {
	const keysA = ownEnumerableKeys(objA);
	const keysB = ownEnumerableKeys(objB);

	if (opts.strict) {
		if (keysA.length !== keysB.length) return false;
		for (const k of keysA) {
			if (!Object.prototype.propertyIsEnumerable.call(objB, k)) return false;
			if (!eq(getProp(objA, k), getProp(objB, k), opts, seen)) return false;
		}
		return true;
	}

	// Non-strict: undefined value ≡ missing key.
	const union = new Set<string | symbol>([...keysA, ...keysB]);
	for (const k of union) {
		const va = getProp(objA, k);
		const vb = getProp(objB, k);
		if (va === undefined && vb === undefined) continue;
		if (!eq(va, vb, opts, seen)) return false;
	}
	return true;
}

function ownEnumerableKeys(obj: object): Array<string | symbol> {
	const strings = Object.keys(obj);
	const symbols = Object.getOwnPropertySymbols(obj).filter((s) =>
		Object.prototype.propertyIsEnumerable.call(obj, s),
	);
	return [...strings, ...symbols];
}

/**
 * Partial match — every key/element in `expected` must match in `actual`.
 * Extra keys in `actual` are allowed for plain objects.
 * Arrays must have the same length (Vitest v1+ semantics, not Jest).
 * Date / RegExp / Error / Map / Set / TypedArray / Buffer / DataView delegate
 * to `equals` — "partial" is ill-defined for them.
 */
export function partialEquals(actual: unknown, expected: unknown): boolean {
	return partial(actual, expected, new WeakMap());
}

function partial(actual: unknown, expected: unknown, seen: Seen): boolean {
	if (Object.is(actual, expected)) return true;
	if (expected === null || expected === undefined) {
		return actual === expected;
	}
	if (typeof expected !== "object") {
		return equals(actual, expected);
	}
	if (typeof actual !== "object" || actual === null) return false;

	// Both narrowed to object by the guards above — no cast needed.
	const objE: object = expected;
	const objA: object = actual;

	if (seenPair(seen, objA, objE)) return true;
	markSeen(seen, objA, objE);

	// Types with no "partial" semantics — fall through to full equality.
	if (lacksPartialSemantics(objE)) {
		return equals(actual, expected);
	}

	if (Array.isArray(expected)) {
		if (!Array.isArray(actual)) return false;
		if (actual.length !== expected.length) return false;
		for (let i = 0; i < expected.length; i += 1) {
			if (!partial(actual[i], expected[i], seen)) return false;
		}
		return true;
	}

	for (const key of ownEnumerableKeys(objE)) {
		if (!partial(getProp(objA, key), getProp(objE, key), seen)) return false;
	}
	return true;
}

/** Object kinds for which "partial" is ill-defined → fall back to full equals. */
function lacksPartialSemantics(value: object): boolean {
	return (
		value instanceof Date ||
		value instanceof RegExp ||
		value instanceof Error ||
		value instanceof Map ||
		value instanceof Set ||
		value instanceof DataView ||
		(typeof Buffer !== "undefined" && Buffer.isBuffer(value)) ||
		(ArrayBuffer.isView(value) && !(value instanceof DataView))
	);
}
