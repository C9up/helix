/**
 * `vi.spyOn(obj, key)` — replaces `obj[key]` with a spy that calls through
 * to the original. `spy.mockRestore()` puts the original back.
 *
 * Supports:
 *   - data properties whose value is a function (most methods);
 *   - accessor properties (`get` / `set`);
 *   - methods inherited via the prototype chain (the spy is installed as an
 *     own property on the target, and `mockRestore()` deletes the own
 *     property so inheritance resumes).
 *
 * `this` binding: the spy's default implementation uses a `function` form
 * (not arrow) so the caller's receiver is forwarded to the original. This
 * is essential when spying on a prototype method that depends on `this`.
 *
 * Double-spy detection: throws if the property is already a Helix spy, to
 * avoid the subtle double-counting bug where the inner spy's `calls` is
 * incremented by pass-through from the outer one.
 */

import { type AnyFn, createSpy, isSpy, type Spy } from "./spy.js";

type AccessorKind = "get" | "set";

export interface SpyOnOptions {
	/** For accessor properties, which side to spy on. Default: `"get"`. */
	accessor?: AccessorKind;
}

function findDescriptor(
	obj: object,
	key: PropertyKey,
): { descriptor: PropertyDescriptor; onPrototype: boolean } {
	let cursor: object | null = obj;
	while (cursor !== null) {
		const desc = Object.getOwnPropertyDescriptor(cursor, key);
		if (desc) {
			return { descriptor: desc, onPrototype: cursor !== obj };
		}
		cursor = Object.getPrototypeOf(cursor);
	}
	throw new Error(
		`vi.spyOn: property "${String(key)}" does not exist on the target`,
	);
}

function buildRestore(
	obj: object,
	key: PropertyKey,
	ownDescBefore: PropertyDescriptor | undefined,
	onPrototype: boolean,
): () => void {
	return () => {
		if (onPrototype && !ownDescBefore) {
			Reflect.deleteProperty(obj, key);
			return;
		}
		if (ownDescBefore) {
			Object.defineProperty(obj, key, ownDescBefore);
		}
	};
}

export function spyOn<Obj extends object, Key extends keyof Obj>(
	obj: Obj,
	key: Key,
	options: SpyOnOptions = {},
): Spy {
	const label = String(key);
	const { descriptor, onPrototype } = findDescriptor(obj, key);
	const ownDescBefore = Object.getOwnPropertyDescriptor(obj, key);

	// Double-spy guard: refuse to spy on an already-spied value.
	if (descriptor.value !== undefined && isSpy(descriptor.value)) {
		throw new Error(
			`vi.spyOn: "${label}" is already a spy. Call mockRestore() before spying again.`,
		);
	}

	const restore = buildRestore(obj, key, ownDescBefore, onPrototype);

	if (descriptor.get || descriptor.set) {
		const kind: AccessorKind = options.accessor ?? "get";
		const originalGet = descriptor.get;
		const originalSet = descriptor.set;
		if (kind === "get") {
			if (!originalGet) {
				throw new Error(
					`vi.spyOn: "${label}" has no getter (pass { accessor: "set" } to spy on the setter)`,
				);
			}
			// Use `function` so the shim + spy forward the caller's `this`.
			const spy = createSpy({
				name: label,
				defaultImplementation: function (this: unknown) {
					return originalGet.call(this);
				},
			});
			Object.defineProperty(obj, key, {
				configurable: true,
				enumerable: descriptor.enumerable ?? true,
				get(this: unknown): unknown {
					return spy.call(this);
				},
				set: originalSet,
			});
			spy.__setRestore(restore);
			return spy;
		}
		if (!originalSet) {
			throw new Error(`vi.spyOn: "${label}" has no setter`);
		}
		const spy = createSpy<(v: unknown) => void>({
			name: label,
			defaultImplementation: function (this: unknown, v: unknown) {
				originalSet.call(this, v);
			},
		});
		Object.defineProperty(obj, key, {
			configurable: true,
			enumerable: descriptor.enumerable ?? true,
			get: originalGet,
			set(this: unknown, v: unknown) {
				spy.call(this, v);
			},
		});
		spy.__setRestore(restore);
		return spy;
	}

	const originalValue = descriptor.value;
	if (typeof originalValue !== "function") {
		throw new Error(
			`vi.spyOn: "${label}" is not a function (got ${typeof originalValue}). Pass { accessor } for accessors.`,
		);
	}
	const originalFn = originalValue as AnyFn;
	const spy = createSpy({
		name: label,
		defaultImplementation: function (this: unknown, ...args: unknown[]) {
			// `this` is the call-site receiver (e.g. the class instance); the
			// original method is forwarded its real receiver. Fixes the bug
			// where `spyOn(Proto, 'method')` used to hard-bind `this = Proto`.
			return originalFn.apply(this, args);
		},
	});
	Object.defineProperty(obj, key, {
		configurable: true,
		enumerable: descriptor.enumerable ?? true,
		writable: descriptor.writable ?? true,
		value: spy,
	});
	spy.__setRestore(restore);
	return spy;
}
