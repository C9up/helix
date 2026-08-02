/**
 * Golden test — helix's `assert` vs the REAL `@japa/assert`.
 *
 * Two checks, both against the installed package rather than the docs:
 *   1. SURFACE — every public assertion `@japa/assert` exposes exists on ours.
 *      A future Japa release adding an assertion turns this red instead of
 *      silently widening the gap.
 *   2. SEMANTICS — for a battery of inputs, both implementations must agree on
 *      pass/fail. Names alone prove nothing: `sameMembers` compares with `===`
 *      while `sameDeepMembers` compares structurally, and helix used to get
 *      that wrong.
 */

import { Assert } from "@japa/assert";
import { describe, expect, it } from "vitest";
import {
	createAssert,
	type Assert as HelixAssert,
} from "../../src/runtime/assert.js";

/**
 * Members of the Japa Assert class that are NOT user-facing assertions:
 * plumbing, re-exported chai internals, and the assertion-planning API helix
 * spells differently.
 */
const NOT_ASSERTIONS = new Set([
	"Assertion",
	"AssertionError",
	"assert",
	"evaluate",
	"incrementAssertionsCount",
]);

/**
 * Intrinsic function properties. Helix's `assert` is itself callable
 * (`assert(value)`), so its own property list carries these — and reading
 * `caller`/`arguments` off a strict-mode function throws.
 */
const FUNCTION_INTRINSICS = new Set([
	"length",
	"name",
	"prototype",
	"caller",
	"arguments",
	"callee",
]);

/** Every function name reachable on an instance, own + prototype chain. */
function methodNames(target: object): Set<string> {
	const names = new Set<string>();
	for (
		let o: object | null = target;
		o !== null && o !== Object.prototype && o !== Function.prototype;
		o = Object.getPrototypeOf(o)
	) {
		for (const key of Object.getOwnPropertyNames(o)) {
			if (key === "constructor" || FUNCTION_INTRINSICS.has(key)) continue;
			if (typeof Reflect.get(o, key, target) === "function") names.add(key);
		}
	}
	return names;
}

/** Did the assertion pass? (An assertion signals failure by throwing.) */
function passes(run: () => void): boolean {
	try {
		run();
		return true;
	} catch {
		return false;
	}
}

/** One semantics case: the method to call and the arguments to call it with. */
interface Case {
	method: keyof HelixAssert & string;
	args: unknown[];
}

const CASES: Case[] = [
	// Plain members compare with `===`, so equal-looking objects do NOT match.
	{
		method: "sameMembers",
		args: [
			[1, 2, 3],
			[3, 2, 1],
		],
	},
	{ method: "sameMembers", args: [[{ x: 1 }], [{ x: 1 }]] },
	{
		method: "sameMembers",
		args: [
			[1, 2],
			[1, 2, 3],
		],
	},
	{
		method: "notSameMembers",
		args: [
			[1, 2],
			[2, 1],
		],
	},
	{
		method: "notSameMembers",
		args: [
			[1, 2],
			[1, 3],
		],
	},
	{ method: "sameDeepMembers", args: [[{ x: 1 }], [{ x: 1 }]] },
	{ method: "sameDeepMembers", args: [[{ x: 1 }], [{ x: 2 }]] },
	{ method: "notSameDeepMembers", args: [[{ x: 1 }], [{ x: 2 }]] },
	// Ordered variants respect position.
	{
		method: "sameOrderedMembers",
		args: [
			[1, 2, 3],
			[1, 2, 3],
		],
	},
	{
		method: "sameOrderedMembers",
		args: [
			[1, 3, 2],
			[1, 2, 3],
		],
	},
	{
		method: "notSameOrderedMembers",
		args: [
			[1, 3, 2],
			[1, 2, 3],
		],
	},
	{
		method: "sameDeepOrderedMembers",
		args: [
			[{ a: 1 }, { b: 2 }],
			[{ a: 1 }, { b: 2 }],
		],
	},
	{ method: "notSameDeepOrderedMembers", args: [[{ a: 1 }], [{ b: 2 }]] },
	// Inclusion: subset must have a distinct match for each of its members.
	{
		method: "includeMembers",
		args: [
			[1, 2, 4, 5],
			[1, 2],
		],
	},
	{ method: "includeMembers", args: [[{ x: 1 }, 2], [{ x: 1 }]] },
	{
		method: "includeMembers",
		args: [
			[1, 2],
			[1, 3],
		],
	},
	{
		method: "notIncludeMembers",
		args: [
			[1, 2, 4, 5],
			[1, 3],
		],
	},
	{ method: "includeDeepMembers", args: [[{ x: 1 }, 2], [{ x: 1 }]] },
	{ method: "notIncludeDeepMembers", args: [[{ x: 1 }], [{ x: 2 }]] },
	// Ordered inclusion is a PREFIX rule, not a subsequence rule.
	{
		method: "includeOrderedMembers",
		args: [
			[1, 2, 3],
			[1, 2],
		],
	},
	{
		method: "includeOrderedMembers",
		args: [
			[1, 2, 3],
			[2, 3],
		],
	},
	{
		method: "notIncludeOrderedMembers",
		args: [
			[1, 2, 3],
			[2, 3],
		],
	},
	{
		method: "includeDeepOrderedMembers",
		args: [[{ a: 1 }, { b: 2 }], [{ a: 1 }]],
	},
	{
		method: "notIncludeDeepOrderedMembers",
		args: [[{ a: 1 }, { b: 2 }], [{ b: 2 }]],
	},
	// Subsets.
	{ method: "containsSubset", args: [{ id: 1, name: "x" }, { id: 1 }] },
	{ method: "containsSubset", args: [{ id: 1 }, { email: "a@b.c" }] },
	{ method: "containsSubset", args: [[{ id: 1 }, { id: 2 }], [{ id: 1 }]] },
	{ method: "doesNotContainSubset", args: [{ id: 1 }, { email: "a@b.c" }] },
	{ method: "notContainsSubset", args: [{ id: 1 }, { email: "a@b.c" }] },
	// Properties + numeric + object state.
	{ method: "anyProperties", args: [{ a: 1, b: 2 }, ["a", "zz"]] },
	{ method: "anyProperties", args: [{ a: 1 }, ["zz"]] },
	{ method: "approximately", args: [10.5, 10, 1] },
	{ method: "approximately", args: [10.5, 10, 0.1] },
	{ method: "sealed", args: [Object.seal({})] },
	{ method: "sealed", args: [{}] },
	{ method: "notSealed", args: [{}] },
];

describe("assert — helix vs @japa/assert", () => {
	it("exposes every public assertion @japa/assert has", () => {
		const japa = [...methodNames(new Assert())].filter(
			(name) => !NOT_ASSERTIONS.has(name),
		);
		const ours = methodNames(createAssert());
		const missing = japa.filter((name) => !ours.has(name)).sort();

		expect(missing).toEqual([]);
	});

	for (const { method, args } of CASES) {
		it(`${method}(${JSON.stringify(args)}) agrees with @japa/assert`, () => {
			const japa = new Assert();
			const ours = createAssert();
			const japaMethod = Reflect.get(japa, method);
			const ourMethod = Reflect.get(ours, method);
			if (typeof japaMethod !== "function" || typeof ourMethod !== "function") {
				throw new Error(`"${method}" is not callable on both implementations`);
			}

			const japaPassed = passes(() => japaMethod.apply(japa, args));
			const ourPassed = passes(() => ourMethod.apply(ours, args));

			expect(ourPassed).toBe(japaPassed);
		});
	}
});
