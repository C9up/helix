/**
 * Spy core — a callable function that records every call and exposes a
 * Vitest-shape `.mock` surface. Wears the `__helixIsSpy` brand so the
 * matchers in `matchers.ts` (`toHaveBeenCalled*`) recognise it.
 */

export interface MockCallResult<Return = unknown> {
	/** `"incomplete"` is pushed synchronously at call entry and patched when the call resolves — matches Vitest so `mock.results.length === mock.calls.length` even for in-flight async. */
	type: "return" | "throw" | "incomplete";
	value: Return;
}

export interface MockInternals<
	Args extends readonly unknown[] = readonly unknown[],
	Return = unknown,
> {
	calls: Args[];
	results: MockCallResult<Return>[];
	/** The most recent call's arguments. Mirrors Vitest. */
	lastCall: Args | undefined;
}

export type AnyFn = (...args: unknown[]) => unknown;

type CallSignature<Fn extends AnyFn> = (
	...args: Parameters<Fn>
) => ReturnType<Fn>;

interface SpyMethods<Fn extends AnyFn> {
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

export type Spy<Fn extends AnyFn = AnyFn> = CallSignature<Fn> & SpyMethods<Fn>;

type Impl<Fn extends AnyFn> = (...args: Parameters<Fn>) => ReturnType<Fn>;

export interface CreateSpyOptions<Fn extends AnyFn> {
	name?: string;
	defaultImplementation?: Fn;
}

/**
 * Factory used by `vi.fn` and `vi.spyOn`. The returned function is both
 * callable (executing the current implementation) and an object carrying
 * `.mock`, the Helix brand, and the `mockFoo()` mutators.
 */
export function createSpy<Fn extends AnyFn = AnyFn>(
	options: CreateSpyOptions<Fn> = {},
): Spy<Fn> {
	const onceQueue: Array<Impl<Fn> | Fn> = [];
	let currentImpl: Fn | Impl<Fn> | undefined = options.defaultImplementation;
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
		const result: MockCallResult<ReturnType<Fn>> = {
			type: "incomplete",
			value: undefined as ReturnType<Fn>,
		};
		mock.results.push(result);
		const impl = onceQueue.shift() ?? currentImpl;
		if (!impl) {
			result.type = "return";
			return undefined as ReturnType<Fn>;
		}
		try {
			const value: ReturnType<Fn> = (impl as Impl<Fn>).apply(this, args);
			result.type = "return";
			result.value = value;
			return value;
		} catch (err) {
			result.type = "throw";
			result.value = err as ReturnType<Fn>;
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
			currentImpl = () => Promise.resolve(value) as ReturnType<Fn>;
			return spy;
		},
		mockResolvedValueOnce(value) {
			onceQueue.push(() => Promise.resolve(value) as ReturnType<Fn>);
			return spy;
		},
		mockRejectedValue(reason) {
			currentImpl = () => Promise.reject(reason) as ReturnType<Fn>;
			return spy;
		},
		mockRejectedValueOnce(reason) {
			onceQueue.push(() => Promise.reject(reason) as ReturnType<Fn>);
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
	const spy = withMethods as Spy<Fn>;
	Object.defineProperty(spy, "name", {
		value: options.name ?? "spy",
		configurable: true,
	});
	return spy;
}

export function isSpy(value: unknown): value is Spy {
	if (!value || (typeof value !== "function" && typeof value !== "object")) {
		return false;
	}
	return (value as { __helixIsSpy?: unknown }).__helixIsSpy === true;
}
