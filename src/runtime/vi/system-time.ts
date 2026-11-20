/**
 * System-time control — pins `Date.now()` and `new Date()` to a fake
 * epoch. Each `ViContext` owns its own `SystemClock` instance; the Date
 * shim reads through to the registered clocks, so a pin lives in the
 * context that set it.
 *
 * `Date` is a singleton per realm, so the shim is global, but it exists
 * only while some registered clock holds an epoch: the first pin installs
 * it, and clearing the last pin (or ending the last pinned context) puts
 * the original `Date` back. Importing helix changes no global.
 *
 * The shim is a real subclass of `Date` behind a callable proxy, so it
 * behaves as `Date` while installed: `class X extends Date` keeps its
 * prototype, `new Date().constructor === Date`, `Date.length === 7`,
 * `Date()` returns the string form, and a date made before the pin is
 * still `instanceof Date`.
 */

const OriginalDate = globalThis.Date;
const originalNow = OriginalDate.now.bind(OriginalDate);

export interface SystemClock {
	/** Fake epoch in ms, or `null` if this context is on real time. */
	fakeEpoch: number | null;
}

export function createSystemClock(): SystemClock {
	return { fakeEpoch: null };
}

/** The clocks of the live contexts, in registration order. */
const clocks = new Set<SystemClock>();
let installedShim: object | null = null;

function resolveEpoch(): number | null {
	for (const clock of clocks) {
		if (clock.fakeEpoch !== null) return clock.fakeEpoch;
	}
	return null;
}

/** Install the shim when a registered clock is pinned, remove it when none is. */
function sync(): void {
	if (resolveEpoch() !== null) install();
	else restore();
}

/**
 * Register one context's clock with the Date shim. Returns an unregister
 * function; unregistering the last pinned clock uninstalls the shim.
 */
export function registerSystemClockContext(clock: SystemClock): () => void {
	clocks.add(clock);
	sync();
	return () => {
		clocks.delete(clock);
		sync();
	};
}

export function setFakeEpoch(clock: SystemClock, time: Date | number): void {
	let epoch: number;
	if (time instanceof OriginalDate) {
		epoch = time.getTime();
	} else if (typeof time === "number") {
		epoch = time;
	} else {
		throw new Error(
			`vi.setSystemTime: expected Date or number, got ${typeof time}`,
		);
	}
	if (!Number.isFinite(epoch)) {
		throw new Error(`vi.setSystemTime: expected a finite epoch, got ${epoch}`);
	}
	clock.fakeEpoch = epoch;
	sync();
}

export function clearFakeEpoch(clock: SystemClock): void {
	clock.fakeEpoch = null;
	sync();
}

/**
 * `OriginalDate` seen through the one construct signature the shim calls
 * `super` with — every `DateConstructor` overload is a case of it.
 */
const DateBase: new (...args: unknown[]) => Date = OriginalDate;
const ordinaryHasInstance = Function.prototype[Symbol.hasInstance];

function buildShim(): object {
	class DateShim extends DateBase {
		constructor(...args: unknown[]) {
			const epoch = resolveEpoch();
			// `super` honours `new.target`, so a subclass of the shim keeps its
			// own prototype.
			if (args.length === 0 && epoch !== null) super(epoch);
			else super(...args);
		}

		static now(): number {
			const epoch = resolveEpoch();
			return epoch !== null ? epoch : originalNow();
		}
	}
	// `Date(...)` without `new` returns the current time as a string; a
	// class cannot be called, so the proxy answers the call.
	const shim = new Proxy(DateShim, {
		apply(): string {
			const epoch = resolveEpoch();
			return new OriginalDate(
				epoch !== null ? epoch : originalNow(),
			).toString();
		},
	});
	// `Date` itself claims every date, the ones made before the pin included;
	// a subclass, which inherits this, claims only its own instances. The
	// receiver says which: it is the constructor on the right of `instanceof`.
	function hasInstance(this: unknown, value: unknown): boolean {
		if (this === shim || this === DateShim) {
			return value instanceof OriginalDate;
		}
		return ordinaryHasInstance.call(this, value);
	}
	Object.defineProperty(DateShim, Symbol.hasInstance, {
		value: hasInstance,
		configurable: true,
	});
	Object.defineProperty(DateShim, "name", {
		value: "Date",
		configurable: true,
	});
	Object.defineProperty(DateShim, "length", { value: 7, configurable: true });
	Object.defineProperty(DateShim.prototype, "constructor", {
		value: shim,
		writable: true,
		enumerable: false,
		configurable: true,
	});
	return shim;
}

function install(): void {
	if (installedShim !== null) return;
	installedShim = buildShim();
	Reflect.set(globalThis, "Date", installedShim);
}

function restore(): void {
	if (installedShim === null) return;
	// Only put the original back over our own shim: another tool may have
	// replaced `Date` since, and that replacement is not ours to remove.
	if (globalThis.Date === installedShim) {
		Reflect.set(globalThis, "Date", OriginalDate);
	}
	installedShim = null;
}

/** Get the original `Date.now` even after the shim is installed. */
export function getRealNow(): number {
	return originalNow();
}

/** Get the original `Date` constructor. */
export function getRealDate(): DateConstructor {
	return OriginalDate;
}
