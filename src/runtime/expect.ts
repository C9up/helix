/**
 * `expect(value)` engine — chainable assertion API compatible with Vitest.
 *
 * Supports:
 *   - All matchers in `./matchers.ts`
 *   - `.not.<matcher>()` — inverts pass/fail
 *   - `.resolves.<matcher>()` / `.rejects.<matcher>()` — async awaits on received
 *   - All four combinations: `.resolves.not`, `.rejects.not`, `.not.resolves`, `.not.rejects`
 */

import { AssertionError } from "./assertion-error.js";
import { type MatcherName, matchers } from "./matchers.js";

type MatcherArgs<Name extends MatcherName> = (typeof matchers)[Name] extends (
	received: unknown,
	...args: infer A
) => unknown
	? A
	: never;

type SyncChain = {
	[K in MatcherName]: (...args: MatcherArgs<K>) => void;
};

type AsyncChain = {
	[K in MatcherName]: (...args: MatcherArgs<K>) => Promise<void>;
};

export type Assertion = SyncChain & {
	not: SyncChain & {
		resolves: AsyncChain;
		rejects: AsyncChain;
	};
	resolves: AsyncChain & { not: AsyncChain };
	rejects: AsyncChain & { not: AsyncChain };
};

interface EvalContext {
	received: unknown;
	negate: boolean;
}

type MatcherInvoker = (
	received: unknown,
	...rest: unknown[]
) => {
	pass: boolean;
	message(): string;
};

function evaluate(ctx: EvalContext, name: MatcherName, args: unknown[]): void {
	const matcher = matchers[name] as MatcherInvoker;
	let result: { pass: boolean; message(): string };
	try {
		result = matcher(ctx.received, ...args);
	} catch (err) {
		// A matcher threw unexpectedly (e.g. a user-supplied constructor with
		// a throwing `Symbol.hasInstance`). Surface it as a normal assertion
		// failure so reporters can render it uniformly.
		const why = err instanceof Error ? err.message : String(err);
		throw new AssertionError({
			message: `matcher ${name} threw: ${why}`,
			actual: ctx.received,
			expected: args.length === 1 ? args[0] : args,
			operator: ctx.negate ? `not.${name}` : name,
		});
	}
	const pass = ctx.negate ? !result.pass : result.pass;
	if (pass) return;
	const prefix = ctx.negate ? "expected NOT: " : "";
	throw new AssertionError({
		message: `${prefix}${result.message()}`,
		actual: ctx.received,
		expected: args,
		operator: ctx.negate ? `not.${name}` : name,
	});
}

const matcherNames = Object.keys(matchers) as MatcherName[];

function buildSync(received: unknown, negate: boolean): SyncChain {
	const api = {} as SyncChain;
	for (const name of matcherNames) {
		const fn = (...args: unknown[]) =>
			evaluate({ received, negate }, name, args);
		Reflect.set(api, name, fn);
	}
	return api;
}

type PromiseMode = "resolves" | "rejects";

function buildAsync(
	received: unknown,
	mode: PromiseMode,
	negate: boolean,
): AsyncChain {
	const api = {} as AsyncChain;
	for (const name of matcherNames) {
		const fn = async (...args: unknown[]) => {
			if (
				!received ||
				typeof (received as { then?: unknown }).then !== "function"
			) {
				throw new AssertionError({
					message: `expected a Promise (for .${mode}), got ${typeof received}`,
					operator: `${mode}.${name}`,
				});
			}
			let resolved: unknown;
			let rejected: unknown;
			let didReject = false;
			try {
				resolved = await (received as PromiseLike<unknown>);
			} catch (err) {
				rejected = err;
				didReject = true;
			}
			if (mode === "resolves") {
				if (didReject) {
					throw new AssertionError({
						message: `expected promise to resolve, but it rejected with ${String(rejected)}`,
						operator: `resolves.${name}`,
					});
				}
				evaluate({ received: resolved, negate }, name, args);
				return;
			}
			if (!didReject) {
				throw new AssertionError({
					message: `expected promise to reject, but it resolved with ${String(resolved)}`,
					operator: `rejects.${name}`,
				});
			}
			// `.rejects.toThrow(...)` feeds the rejection into toThrow's
			// function-scoped contract by wrapping it in a rethrowing thunk.
			const target =
				name === "toThrow"
					? () => {
							throw rejected;
						}
					: rejected;
			evaluate({ received: target, negate }, name, args);
		};
		Reflect.set(api, name, fn);
	}
	return api;
}

export function expect(received: unknown): Assertion {
	const base = buildSync(received, false);

	// `.not` returns a chain that negates every matcher. It also exposes
	// `.resolves` / `.rejects` so `expect(p).not.resolves.toBe(x)` works, matching
	// Vitest's full surface.
	const notSync = Object.assign(buildSync(received, true), {
		resolves: buildAsync(received, "resolves", true),
		rejects: buildAsync(received, "rejects", true),
	});

	const resolves = Object.assign(buildAsync(received, "resolves", false), {
		not: buildAsync(received, "resolves", true),
	});
	const rejects = Object.assign(buildAsync(received, "rejects", false), {
		not: buildAsync(received, "rejects", true),
	});

	return Object.assign(base, {
		not: notSync,
		resolves,
		rejects,
	});
}
