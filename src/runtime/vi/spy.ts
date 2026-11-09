/**
 * Spy core — a callable function that records every call and exposes a
 * Vitest-shape `.mock` surface. Wears the `__helixIsSpy` brand so the
 * matchers in `matchers.ts` (`toHaveBeenCalled*`) recognise it.
 */

/**
 * One call's outcome. `"incomplete"` is pushed synchronously at call entry and
 * replaced once the call returns or throws — as in Vitest, so
 * `mock.results.length === mock.calls.length` even for an in-flight call.
 */
export type MockCallResult<Return = unknown> =
	| { type: "incomplete"; value: undefined }
	| { type: "return"; value: Return }
	| { type: "throw"; value: unknown };

export interface MockInternals<
	Args extends readonly unknown[] = readonly unknown[],
	Return = unknown,
> {
	calls: Args[];
	results: MockCallResult<Return>[];
	/** The most recent call's arguments. Mirrors Vitest. */
	lastCall: Args | undefined;
}

/**
 * Anything callable, as a CONSTRAINT.
 *
 * `never` in the parameter position, because parameters are compared
 * contravariantly: `(...args: unknown[]) => unknown` accepts only a function
 * whose own parameters accept `unknown`, so `vi.fn((a: number, b: number) =>
 * a + b)` was rejected — every typed function was. `never` is assignable to
 * every parameter type, which is what makes this the constraint that admits
 * them all. Vitest reaches the same place with `any[]`.
 */
export type AnyFunction = (...args: never[]) => unknown;

/** Anything callable, as a VALUE — the default a bare `Spy` stands for. */
export type AnyFn = (...args: unknown[]) => unknown;

type CallSignature<Fn extends AnyFunction> = (
	...args: Parameters<Fn>
) => ReturnType<Fn>;

interface SpyMethods<Fn extends AnyFunction> {
	readonly __helixIsSpy: true;
	readonly mock: MockInternals<Parameters<Fn>, ReturnType<Fn>>;
	readonly calls: Parameters<Fn>[];
	readonly callCount: number;

	mockImplementation(fn: Impl<Fn>): Spy<Fn>;
	mockImplementationOnce(fn: Impl<Fn>): Spy<Fn>;
	mockReturnValue(value: ReturnType<Fn>): Spy<Fn>;
	mockReturnValueOnce(value: ReturnType<Fn>): Spy<Fn>;
	mockResolvedValue(value: Awaited<ReturnType<Fn>>): Spy<Fn>;
	mockResolvedValueOnce(value: Awaited<ReturnType<Fn>>): Spy<Fn>;
	mockRejectedValue(reason: unknown): Spy<Fn>;
	mockRejectedValueOnce(reason: unknown): Spy<Fn>;
	mockClear(): Spy<Fn>;
	mockReset(): Spy<Fn>;
	mockRestore(): Spy<Fn>;

	/** Internal: spyOn installs a restore callback here. Undefined for `vi.fn`. */
	__setRestore(fn: () => void): void;
	/** Internal: true iff `__setRestore` was called (= created by spyOn). */
	readonly __isSpyOn: boolean;
}

export type Spy<Fn extends AnyFunction = AnyFn> = CallSignature<Fn> &
	SpyMethods<Fn>;

type Impl<Fn extends AnyFunction> = (...args: Parameters<Fn>) => ReturnType<Fn>;

/**
 * An implementation as the spy stores it. It is only ever invoked through
 * `Reflect.apply` with the arguments the spy was called with, so its own
 * signature is not what keeps the call well-typed — the spy's is.
 */
type StoredImpl = AnyFunction;

export interface CreateSpyOptions<Fn extends AnyFunction> {
	name?: string;
	defaultImplementation?: Fn;
}

/**
 * Factory used by `vi.fn` and `vi.spyOn`. The returned function is both
 * callable (executing the current implementation) and an object carrying
 * `.mock`, the Helix brand, and the `mockFoo()` mutators.
 */
export function createSpy<Fn extends AnyFunction = AnyFn>(
	options: CreateSpyOptions<Fn> = {},
): Spy<Fn> {
	const onceQueue: StoredImpl[] = [];
	let currentImpl: StoredImpl | undefined = options.defaultImplementation;
	let restoreFn: (() => void) | undefined;

	const mock: MockInternals<Parameters<Fn>, ReturnType<Fn>> = {
		calls: [],
		results: [],
		lastCall: undefined,
	};

	const call: CallSignature<Fn> = function (
		this: unknown,
		...args: Parameters<Fn>
	): ReturnType<Fn> {
		mock.calls.push(args);
		mock.lastCall = args;
		// Push an incomplete result synchronously so `mock.results.length`
		// always matches `mock.calls.length` (Vitest parity).
		const index =
			mock.results.push({ type: "incomplete", value: undefined }) - 1;
		// No implementation: the call returns `undefined`, whatever the spy's
		// declared return type says — the same promise Vitest's `vi.fn<T>()`
		// makes, and one the type system cannot check.
		const impl = onceQueue.shift() ?? currentImpl ?? returnsNothing;
		try {
			const value: ReturnType<Fn> = Reflect.apply(impl, this, args);
			mock.results[index] = { type: "return", value };
			return value;
		} catch (err) {
			mock.results[index] = { type: "throw", value: err };
			throw err;
		}
	};

	// `calls` and `callCount` must be LIVE accessors. Defining them in an
	// object literal and passing through `Object.assign` would snapshot the
	// getter's current value (Object.assign invokes [[Get]] on the source).
	const methods: Omit<SpyMethods<Fn>, "calls" | "callCount" | "__isSpyOn"> = {
		__helixIsSpy: true,
		mock,
		mockImplementation(fn) {
			currentImpl = fn;
			return spy;
		},
		mockImplementationOnce(fn) {
			onceQueue.push(fn);
			return spy;
		},
		mockReturnValue(value) {
			currentImpl = () => value;
			return spy;
		},
		mockReturnValueOnce(value) {
			onceQueue.push(() => value);
			return spy;
		},
		mockResolvedValue(value) {
			currentImpl = () => Promise.resolve(value);
			return spy;
		},
		mockResolvedValueOnce(value) {
			onceQueue.push(() => Promise.resolve(value));
			return spy;
		},
		mockRejectedValue(reason) {
			currentImpl = () => Promise.reject(reason);
			return spy;
		},
		mockRejectedValueOnce(reason) {
			onceQueue.push(() => Promise.reject(reason));
			return spy;
		},
		mockClear() {
			mock.calls.length = 0;
			mock.results.length = 0;
			mock.lastCall = undefined;
			return spy;
		},
		mockReset() {
			spy.mockClear();
			onceQueue.length = 0;
			// On a `vi.fn` (no `restoreFn`) Vitest clears the implementation
			// entirely. On a `spyOn` spy, restoring to the call-through
			// `defaultImplementation` is the right behaviour.
			currentImpl = restoreFn ? options.defaultImplementation : undefined;
			return spy;
		},
		mockRestore() {
			// Atomic order: swap `restoreFn` out of the closure BEFORE calling
			// it, so a re-entrant `mockRestore` during the user's restore hook
			// doesn't double-fire. If the hook throws, the spy is considered
			// restored (best we can do) and the error propagates.
			const hook = restoreFn;
			restoreFn = undefined;
			spy.mockReset();
			hook?.();
			return spy;
		},
		__setRestore(fn) {
			restoreFn = fn;
			isSpyOn = true;
		},
	};

	// Sticky flag: once a spy is created via spyOn (`__setRestore` called),
	// it stays "spyOn-flavoured" even after `mockRestore()` clears
	// `restoreFn`. This matters for `restoreAllMocks` which must distinguish
	// pass-through spies from bare `vi.fn` spies independently of their
	// restoration state.
	let isSpyOn = false;

	const withMethods = Object.assign(call, methods);
	Object.defineProperties(withMethods, {
		calls: {
			configurable: true,
			enumerable: false,
			get() {
				return mock.calls;
			},
		},
		callCount: {
			configurable: true,
			enumerable: false,
			get() {
				return mock.calls.length;
			},
		},
		__isSpyOn: {
			configurable: true,
			enumerable: false,
			get() {
				return isSpyOn;
			},
		},
	});
	if (!hasLiveAccessors(withMethods)) {
		throw new Error("helix: spy accessors were not installed");
	}
	const spy = withMethods;
	Object.defineProperty(spy, "name", {
		value: options.name ?? "spy",
		configurable: true,
	});
	return spy;
}

function returnsNothing(): undefined {
	return undefined;
}

/**
 * Whether the live `calls` / `callCount` / `__isSpyOn` accessors are in place —
 * they are defined with `Object.defineProperties`, which the type system does
 * not follow, so the spy's full type is established by checking them.
 */
function hasLiveAccessors<Fn extends AnyFunction>(
	value: CallSignature<Fn> &
		Omit<SpyMethods<Fn>, "calls" | "callCount" | "__isSpyOn">,
): value is Spy<Fn> {
	return (
		Reflect.has(value, "calls") &&
		Reflect.has(value, "callCount") &&
		Reflect.has(value, "__isSpyOn")
	);
}

export function isSpy(value: unknown): value is Spy {
	if (!value || (typeof value !== "function" && typeof value !== "object")) {
		return false;
	}
	return Reflect.get(value, "__helixIsSpy") === true;
}
