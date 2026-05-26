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

	// Boxed primitives — unwrap so `new Number(1)` vs `new Number(2)` differ properly.
	if (objA instanceof Number && objB instanceof Number) {
		return Object.is(objA.valueOf(), objB.valueOf());
	}
	if (objA instanceof String && objB instanceof String) {
		return Object.is(objA.valueOf(), objB.valueOf());
	}
	if (objA instanceof Boolean && objB instanceof Boolean) {
		return Object.is(objA.valueOf(), objB.valueOf());
	}
	if (
		objA instanceof Number ||
		objA instanceof String ||
		objA instanceof Boolean ||
		objB instanceof Number ||
		objB instanceof String ||
		objB instanceof Boolean
	) {
		return false;
	}

	// Strict: differing prototypes → not equal (plain `{}` vs class instance).
	if (opts.strict) {
		if (Object.getPrototypeOf(objA) !== Object.getPrototypeOf(objB)) {
			return false;
		}
	}

	// Dates.
	if (objA instanceof Date || objB instanceof Date) {
		return (
			objA instanceof Date &&
			objB instanceof Date &&
			objA.getTime() === objB.getTime()
		);
	}

	// RegExps.
	if (objA instanceof RegExp || objB instanceof RegExp) {
		return (
			objA instanceof RegExp &&
			objB instanceof RegExp &&
			objA.source === objB.source &&
			objA.flags === objB.flags
		);
	}

	// Error instances — compare name + message + own enumerable keys. The
	// built-in fields are non-enumerable so plain-keys comparison alone would
	// report any two Errors as equal.
	if (objA instanceof Error || objB instanceof Error) {
		if (!(objA instanceof Error && objB instanceof Error)) return false;
		if (objA.name !== objB.name) return false;
		if (objA.message !== objB.message) return false;
		return compareOwnKeys(objA, objB, opts, seen);
	}

	// DataView — compare by byteLength + getUint8 byte-for-byte.
	if (objA instanceof DataView || objB instanceof DataView) {
		if (!(objA instanceof DataView && objB instanceof DataView)) return false;
		if (objA.byteLength !== objB.byteLength) return false;
		for (let i = 0; i < objA.byteLength; i += 1) {
			if (objA.getUint8(i) !== objB.getUint8(i)) return false;
		}
		return true;
	}

	// Buffer — shortcut via Buffer.equals when both are Buffers.
	if (
		typeof Buffer !== "undefined" &&
		Buffer.isBuffer(objA) &&
		Buffer.isBuffer(objB)
	) {
		return objA.equals(objB);
	}

	// Typed arrays (Uint8Array, Int16Array, Float64Array, BigInt64Array, …).
	// Require matching constructor so Uint8Array !== Int8Array even when values coincide.
	const viewA = asNumericTypedArray(objA);
	const viewB = asNumericTypedArray(objB);
	if (viewA || viewB) {
		if (!viewA || !viewB) return false;
		if (objA.constructor !== objB.constructor) return false;
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

	// Arrays.
	if (Array.isArray(objA) || Array.isArray(objB)) {
		if (!(Array.isArray(objA) && Array.isArray(objB))) return false;
		if (objA.length !== objB.length) return false;
		for (let i = 0; i < objA.length; i += 1) {
			if (!eq(objA[i], objB[i], opts, seen)) return false;
		}
		return true;
	}

	// Maps — structural key comparison supporting object keys.
	if (objA instanceof Map || objB instanceof Map) {
		if (!(objA instanceof Map && objB instanceof Map)) return false;
		if (objA.size !== objB.size) return false;
		for (const [kA, vA] of objA) {
			// Fast path: identity/primitive key hit.
			if (objB.has(kA) && eq(vA, objB.get(kA), opts, seen)) continue;
			// Structural search across remaining entries.
			let matched = false;
			for (const [kB, vB] of objB) {
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
	if (objA instanceof Set || objB instanceof Set) {
		if (!(objA instanceof Set && objB instanceof Set)) return false;
		if (objA.size !== objB.size) return false;
		for (const v of objA) {
			let found = false;
			for (const w of objB) {
				if (eq(v, w, opts, new WeakMap())) {
					found = true;
					break;
				}
			}
			if (!found) return false;
		}
		return true;
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

	const objE = expected as object;
	if (typeof actual !== "object" || actual === null) return false;
	const objA = actual as object;

	if (seenPair(seen, objA, objE)) return true;
	markSeen(seen, objA, objE);

	// Types with no "partial" semantics — fall through to full equality.
	if (
		objE instanceof Date ||
		objE instanceof RegExp ||
		objE instanceof Error ||
		objE instanceof Map ||
		objE instanceof Set ||
		objE instanceof DataView ||
		(typeof Buffer !== "undefined" && Buffer.isBuffer(objE)) ||
		(ArrayBuffer.isView(objE) && !(objE instanceof DataView))
	) {
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
