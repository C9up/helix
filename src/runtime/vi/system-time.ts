/**
 * System-time control — pins `Date.now()` and `new Date()` to a fake
 * epoch. Each `ViContext` owns its own `SystemClock` instance; the Date
 * shim read-through to `context.fakeEpoch`, so concurrent test files
 * never share wall-clock state (AC 6 isolation).
 *
 * The shim is installed globally on first activation across ANY context
 * (Date is a singleton per realm), but the shim ALWAYS reads from the
 * currently-active context via the `readContext` resolver passed in. When
 * all contexts deactivate, the shim uninstalls.
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

/**
 * Register one context's interest in the Date shim. Returns an
 * unregister function.
 */
type ContextResolver = () => SystemClock | undefined;

const resolvers = new Set<ContextResolver>();
let installed = false;

function resolveEpoch(): number | null {
	for (const resolve of resolvers) {
		const ctx = resolve();
		if (ctx?.fakeEpoch !== null && ctx?.fakeEpoch !== undefined) {
			return ctx.fakeEpoch;
		}
	}
	return null;
}

export function registerSystemClockContext(
	resolver: ContextResolver,
): () => void {
	resolvers.add(resolver);
	install();
	return () => {
		resolvers.delete(resolver);
		if (resolvers.size === 0) restore();
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
}

export function clearFakeEpoch(clock: SystemClock): void {
	clock.fakeEpoch = null;
}

function buildShim(): object {
	const shim = function DateShim(this: unknown, ...args: unknown[]): unknown {
		const epoch = resolveEpoch();
		// Called without `new`: return a toString of the pinned (or real) time.
		if (!new.target) {
			return epoch !== null
				? new OriginalDate(epoch).toString()
				: new OriginalDate().toString();
		}
		if (args.length === 0 && epoch !== null) {
			return new OriginalDate(epoch);
		}
		return Reflect.construct(OriginalDate, args);
	};
	shim.prototype = OriginalDate.prototype;
	Object.defineProperty(shim, "name", { value: "Date", configurable: true });
	Reflect.set(shim, "now", () => {
		const epoch = resolveEpoch();
		return epoch !== null ? epoch : originalNow();
	});
	Reflect.set(shim, "parse", OriginalDate.parse.bind(OriginalDate));
	Reflect.set(shim, "UTC", OriginalDate.UTC.bind(OriginalDate));
	return shim;
}

function install(): void {
	if (installed) return;
	installed = true;
	Reflect.set(globalThis, "Date", buildShim());
}

function restore(): void {
	if (!installed) return;
	installed = false;
	Reflect.set(globalThis, "Date", OriginalDate);
}

/** Get the original `Date.now` even after the shim is installed. */
export function getRealNow(): number {
	return originalNow();
}

/** Get the original `Date` constructor. */
export function getRealDate(): DateConstructor {
	return OriginalDate;
}
