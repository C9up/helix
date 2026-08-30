/**
 * The `assert` surface, one method at a time.
 *
 * This is what a consumer writes their tests with, and an assertion that
 * cannot fail turns their green suite into a claim nobody checked. So every
 * method below is exercised BOTH ways: on a value it should accept, and on one
 * it must refuse.
 */
import { describe, expect as vExpect, it as vIt } from "vitest";
import { createAssert } from "../../../src/runtime/assert.js";

const assert = createAssert();

/** `[name, a call that must pass, a call that must throw]`. */
type Case = [string, () => void, () => void];

const cases: Case[] = [
	// ── equality ────────────────────────────────────────────
	["equal", () => assert.equal(1, "1"), () => assert.equal(1, 2)],
	["notEqual", () => assert.notEqual(1, 2), () => assert.notEqual(1, "1")],
	[
		"strictEqual",
		() => assert.strictEqual(1, 1),
		() => assert.strictEqual(1, "1"),
	],
	[
		"notStrictEqual",
		() => assert.notStrictEqual(1, "1"),
		() => assert.notStrictEqual(1, 1),
	],
	[
		"deepEqual",
		() => assert.deepEqual({ a: [1] }, { a: [1] }),
		() => assert.deepEqual({ a: [1] }, { a: [2] }),
	],
	[
		"notDeepEqual",
		() => assert.notDeepEqual({ a: 1 }, { a: 2 }),
		() => assert.notDeepEqual({ a: 1 }, { a: 1 }),
	],

	// ── truthiness ──────────────────────────────────────────
	["isTrue", () => assert.isTrue(true), () => assert.isTrue(1)],
	["isFalse", () => assert.isFalse(false), () => assert.isFalse(0)],
	["isNotTrue", () => assert.isNotTrue(1), () => assert.isNotTrue(true)],
	["isNotFalse", () => assert.isNotFalse(0), () => assert.isNotFalse(false)],
	["isOk", () => assert.isOk("x"), () => assert.isOk("")],
	["isNotOk", () => assert.isNotOk(""), () => assert.isNotOk("x")],
	["ok", () => assert.ok(1), () => assert.ok(0)],
	["notOk", () => assert.notOk(0), () => assert.notOk(1)],

	// ── presence ────────────────────────────────────────────
	["isNull", () => assert.isNull(null), () => assert.isNull(undefined)],
	["isNotNull", () => assert.isNotNull(0), () => assert.isNotNull(null)],
	[
		"isUndefined",
		() => assert.isUndefined(undefined),
		() => assert.isUndefined(null),
	],
	[
		"isDefined",
		() => assert.isDefined(null),
		() => assert.isDefined(undefined),
	],
	["exists", () => assert.exists(0), () => assert.exists(null)],
	["notExists", () => assert.notExists(null), () => assert.notExists(0)],

	// ── ordering ────────────────────────────────────────────
	["isAbove", () => assert.isAbove(2, 1), () => assert.isAbove(1, 1)],
	["isBelow", () => assert.isBelow(1, 2), () => assert.isBelow(1, 1)],
	["isAtLeast", () => assert.isAtLeast(1, 1), () => assert.isAtLeast(0, 1)],
	["isAtMost", () => assert.isAtMost(1, 1), () => assert.isAtMost(2, 1)],
	[
		"closeTo",
		() => assert.closeTo(1.05, 1, 0.1),
		() => assert.closeTo(1.5, 1, 0.1),
	],
	[
		"approximately",
		() => assert.approximately(1.05, 1, 0.1),
		() => assert.approximately(1.5, 1, 0.1),
	],

	// ── size ────────────────────────────────────────────────
	["lengthOf", () => assert.lengthOf([1, 2], 2), () => assert.lengthOf([1], 2)],
	[
		"notLengthOf",
		() => assert.notLengthOf([1], 2),
		() => assert.notLengthOf([1], 1),
	],
	["isEmpty", () => assert.isEmpty([]), () => assert.isEmpty([1])],
	["isNotEmpty", () => assert.isNotEmpty([1]), () => assert.isNotEmpty([])],
	["empty", () => assert.empty(""), () => assert.empty("x")],
	["notEmpty", () => assert.notEmpty("x"), () => assert.notEmpty("")],

	// ── membership ──────────────────────────────────────────
	["include", () => assert.include([1, 2], 2), () => assert.include([1], 2)],
	[
		"notInclude",
		() => assert.notInclude([1], 2),
		() => assert.notInclude([1], 1),
	],
	[
		"deepInclude",
		() => assert.deepInclude([{ a: 1 }], { a: 1 }),
		() => assert.deepInclude([{ a: 1 }], { a: 2 }),
	],
	[
		"notDeepInclude",
		() => assert.notDeepInclude([{ a: 1 }], { a: 2 }),
		() => assert.notDeepInclude([{ a: 1 }], { a: 1 }),
	],
	["oneOf", () => assert.oneOf(1, [1, 2]), () => assert.oneOf(3, [1, 2])],

	// ── properties ──────────────────────────────────────────
	[
		"property",
		() => assert.property({ a: 1 }, "a"),
		() => assert.property({}, "a"),
	],
	[
		"notProperty",
		() => assert.notProperty({}, "a"),
		() => assert.notProperty({ a: 1 }, "a"),
	],
	[
		"propertyVal",
		() => assert.propertyVal({ a: 1 }, "a", 1),
		() => assert.propertyVal({ a: 1 }, "a", 2),
	],
	[
		"notPropertyVal",
		() => assert.notPropertyVal({ a: 1 }, "a", 2),
		() => assert.notPropertyVal({ a: 1 }, "a", 1),
	],
	[
		"deepPropertyVal",
		() => assert.deepPropertyVal({ a: { b: 1 } }, "a", { b: 1 }),
		() => assert.deepPropertyVal({ a: { b: 1 } }, "a", { b: 2 }),
	],
	[
		"notDeepPropertyVal",
		() => assert.notDeepPropertyVal({ a: { b: 1 } }, "a", { b: 2 }),
		() => assert.notDeepPropertyVal({ a: { b: 1 } }, "a", { b: 1 }),
	],
	[
		"properties",
		() => assert.properties({ a: 1, b: 2 }, ["a", "b"]),
		() => assert.properties({ a: 1 }, ["a", "b"]),
	],
	[
		"notAllProperties",
		() => assert.notAllProperties({ a: 1 }, ["a", "b"]),
		() => assert.notAllProperties({ a: 1, b: 2 }, ["a", "b"]),
	],
	[
		"onlyProperties",
		() => assert.onlyProperties({ a: 1, b: 2 }, ["a", "b"]),
		() => assert.onlyProperties({ a: 1, b: 2, c: 3 }, ["a", "b"]),
	],
	[
		"anyProperties",
		() => assert.anyProperties({ a: 1 }, ["a", "z"]),
		() => assert.anyProperties({ a: 1 }, ["y", "z"]),
	],
	[
		"notAnyProperties",
		() => assert.notAnyProperties({ a: 1 }, ["y", "z"]),
		() => assert.notAnyProperties({ a: 1 }, ["a", "z"]),
	],

	// ── types ───────────────────────────────────────────────
	[
		"instanceOf",
		() => assert.instanceOf(new Error("x"), Error),
		() => assert.instanceOf({}, Error),
	],
	[
		"notInstanceOf",
		() => assert.notInstanceOf({}, Error),
		() => assert.notInstanceOf(new Error("x"), Error),
	],
	[
		"typeOf",
		() => assert.typeOf([], "array"),
		() => assert.typeOf([], "object"),
	],
	[
		"notTypeOf",
		() => assert.notTypeOf([], "object"),
		() => assert.notTypeOf([], "array"),
	],
	["isArray", () => assert.isArray([]), () => assert.isArray({})],
	["isNotArray", () => assert.isNotArray({}), () => assert.isNotArray([])],
	["isObject", () => assert.isObject({}), () => assert.isObject([])],
	["isNotObject", () => assert.isNotObject([]), () => assert.isNotObject({})],
	["isString", () => assert.isString("x"), () => assert.isString(1)],
	["isNotString", () => assert.isNotString(1), () => assert.isNotString("x")],
	["isNumber", () => assert.isNumber(1), () => assert.isNumber("1")],
	["isNotNumber", () => assert.isNotNumber("1"), () => assert.isNotNumber(1)],
	["isBoolean", () => assert.isBoolean(true), () => assert.isBoolean(1)],
	[
		"isNotBoolean",
		() => assert.isNotBoolean(1),
		() => assert.isNotBoolean(true),
	],
	[
		"isFunction",
		() => assert.isFunction(() => {}),
		() => assert.isFunction({}),
	],
	[
		"isNotFunction",
		() => assert.isNotFunction({}),
		() => assert.isNotFunction(() => {}),
	],
	["isNaN", () => assert.isNaN(Number.NaN), () => assert.isNaN(1)],
	["isNotNaN", () => assert.isNotNaN(1), () => assert.isNotNaN(Number.NaN)],
	[
		"isFinite",
		() => assert.isFinite(1),
		() => assert.isFinite(Number.POSITIVE_INFINITY),
	],

	// ── strings ─────────────────────────────────────────────
	["match", () => assert.match("abc", /b/), () => assert.match("abc", /z/)],
	[
		"notMatch",
		() => assert.notMatch("abc", /z/),
		() => assert.notMatch("abc", /b/),
	],

	// ── object state ────────────────────────────────────────
	[
		"isFrozen",
		() => assert.isFrozen(Object.freeze({})),
		() => assert.isFrozen({}),
	],
	[
		"isNotFrozen",
		() => assert.isNotFrozen({}),
		() => assert.isNotFrozen(Object.freeze({})),
	],
	["frozen", () => assert.frozen(Object.freeze({})), () => assert.frozen({})],
	[
		"notFrozen",
		() => assert.notFrozen({}),
		() => assert.notFrozen(Object.freeze({})),
	],
	[
		"isSealed",
		() => assert.isSealed(Object.seal({})),
		() => assert.isSealed({}),
	],
	[
		"isNotSealed",
		() => assert.isNotSealed({}),
		() => assert.isNotSealed(Object.seal({})),
	],
	["sealed", () => assert.sealed(Object.seal({})), () => assert.sealed({})],
	[
		"notSealed",
		() => assert.notSealed({}),
		() => assert.notSealed(Object.seal({})),
	],
];

describe("helix > every assert method accepts and refuses", () => {
	for (const [name, passes, fails] of cases) {
		vIt(`${name} accepts what it should`, () => {
			vExpect(passes).not.toThrow();
		});
		vIt(`${name} refuses what it should`, () => {
			vExpect(fails).toThrow();
		});
	}
});

describe("helix > comparing collections", () => {
	const pairs: Case[] = [
		[
			"includeMembers",
			() => assert.includeMembers([1, 2, 3], [2, 1]),
			() => assert.includeMembers([1, 2], [3]),
		],
		[
			"notIncludeMembers",
			() => assert.notIncludeMembers([1, 2], [3]),
			() => assert.notIncludeMembers([1, 2], [1]),
		],
		[
			"includeDeepMembers",
			() => assert.includeDeepMembers([{ a: 1 }, { b: 2 }], [{ a: 1 }]),
			() => assert.includeDeepMembers([{ a: 1 }], [{ b: 2 }]),
		],
		[
			"notIncludeDeepMembers",
			() => assert.notIncludeDeepMembers([{ a: 1 }], [{ b: 2 }]),
			() => assert.notIncludeDeepMembers([{ a: 1 }], [{ a: 1 }]),
		],
		[
			"includeOrderedMembers",
			() => assert.includeOrderedMembers([1, 2, 3], [1, 2]),
			() => assert.includeOrderedMembers([1, 2, 3], [2, 1]),
		],
		[
			"notIncludeOrderedMembers",
			() => assert.notIncludeOrderedMembers([1, 2, 3], [2, 1]),
			() => assert.notIncludeOrderedMembers([1, 2, 3], [1, 2]),
		],
		[
			"includeDeepOrderedMembers",
			() => assert.includeDeepOrderedMembers([{ a: 1 }, { b: 2 }], [{ a: 1 }]),
			() =>
				assert.includeDeepOrderedMembers(
					[{ a: 1 }, { b: 2 }],
					[{ b: 2 }, { a: 1 }],
				),
		],
		[
			"notIncludeDeepOrderedMembers",
			() => assert.notIncludeDeepOrderedMembers([{ a: 1 }], [{ b: 2 }]),
			() => assert.notIncludeDeepOrderedMembers([{ a: 1 }], [{ a: 1 }]),
		],
		[
			"sameMembers",
			() => assert.sameMembers([1, 2], [2, 1]),
			() => assert.sameMembers([1, 2], [1]),
		],
		[
			"notSameMembers",
			() => assert.notSameMembers([1, 2], [1]),
			() => assert.notSameMembers([1, 2], [2, 1]),
		],
		[
			"sameDeepMembers",
			() => assert.sameDeepMembers([{ a: 1 }], [{ a: 1 }]),
			() => assert.sameDeepMembers([{ a: 1 }], [{ a: 2 }]),
		],
		[
			"notSameDeepMembers",
			() => assert.notSameDeepMembers([{ a: 1 }], [{ a: 2 }]),
			() => assert.notSameDeepMembers([{ a: 1 }], [{ a: 1 }]),
		],
		[
			"sameOrderedMembers",
			() => assert.sameOrderedMembers([1, 2], [1, 2]),
			() => assert.sameOrderedMembers([1, 2], [2, 1]),
		],
		[
			"notSameOrderedMembers",
			() => assert.notSameOrderedMembers([1, 2], [2, 1]),
			() => assert.notSameOrderedMembers([1, 2], [1, 2]),
		],
		[
			"sameDeepOrderedMembers",
			() => assert.sameDeepOrderedMembers([{ a: 1 }], [{ a: 1 }]),
			() =>
				assert.sameDeepOrderedMembers(
					[{ a: 1 }, { b: 2 }],
					[{ b: 2 }, { a: 1 }],
				),
		],
		[
			"notSameDeepOrderedMembers",
			() => assert.notSameDeepOrderedMembers([{ a: 1 }], [{ a: 2 }]),
			() => assert.notSameDeepOrderedMembers([{ a: 1 }], [{ a: 1 }]),
		],
		[
			"containsSubset",
			() => assert.containsSubset({ a: 1, b: { c: 2 } }, { b: { c: 2 } }),
			() => assert.containsSubset({ a: 1 }, { b: 2 }),
		],
		[
			"containSubset",
			() => assert.containSubset({ a: 1 }, { a: 1 }),
			() => assert.containSubset({ a: 1 }, { a: 2 }),
		],
		[
			"doesNotContainSubset",
			() => assert.doesNotContainSubset({ a: 1 }, { b: 2 }),
			() => assert.doesNotContainSubset({ a: 1 }, { a: 1 }),
		],
		[
			"notContainsSubset",
			() => assert.notContainsSubset({ a: 1 }, { b: 2 }),
			() => assert.notContainsSubset({ a: 1 }, { a: 1 }),
		],
	];

	for (const [name, passes, fails] of pairs) {
		vIt(`${name} accepts what it should`, () => {
			vExpect(passes).not.toThrow();
		});
		vIt(`${name} refuses what it should`, () => {
			vExpect(fails).toThrow();
		});
	}

	vIt(
		"tells ordered from unordered, which is the whole point of the pair",
		() => {
			// Same members, different order: one family accepts it, the other must not.
			vExpect(() => assert.sameMembers([1, 2, 3], [3, 1, 2])).not.toThrow();
			vExpect(() => assert.sameOrderedMembers([1, 2, 3], [3, 1, 2])).toThrow();
		},
	);

	vIt("tells strict membership from deep membership", () => {
		vExpect(() => assert.sameDeepMembers([{ a: 1 }], [{ a: 1 }])).not.toThrow();
		// Two structurally equal objects are not the same reference.
		vExpect(() => assert.sameMembers([{ a: 1 }], [{ a: 1 }])).toThrow();
	});
});

describe("helix > what a function did", () => {
	vIt("throws accepts a thrower and refuses one that returns", () => {
		vExpect(() =>
			assert.throws(() => {
				throw new Error("boom");
			}),
		).not.toThrow();
		vExpect(() => assert.throws(() => 1)).toThrow();
	});

	vIt("throws narrows on the error, by message, pattern or class", () => {
		const boom = () => {
			throw new TypeError("boom happened");
		};

		vExpect(() => assert.throws(boom, "boom happened")).not.toThrow();
		vExpect(() => assert.throws(boom, /boom/)).not.toThrow();
		vExpect(() => assert.throws(boom, TypeError)).not.toThrow();
		// A matcher that does not fit must not be quietly ignored.
		vExpect(() => assert.throws(boom, /elsewhere/)).toThrow();
		vExpect(() => assert.throws(boom, RangeError)).toThrow();
	});

	vIt("doesNotThrow accepts a return and refuses a throw", () => {
		vExpect(() => assert.doesNotThrow(() => 1)).not.toThrow();
		vExpect(() =>
			assert.doesNotThrow(() => {
				throw new Error("boom");
			}),
		).toThrow();
	});

	vIt("doesNotThrows is the same under its plural spelling", () => {
		vExpect(() => assert.doesNotThrows(() => 1)).not.toThrow();
		vExpect(() =>
			assert.doesNotThrows(() => {
				throw new Error("boom");
			}),
		).toThrow();
	});

	vIt("rejects accepts a rejection and refuses a resolve", async () => {
		await vExpect(
			assert.rejects(() => Promise.reject(new Error("boom"))),
		).resolves.toBeUndefined();
		await vExpect(assert.rejects(() => Promise.resolve(1))).rejects.toThrow();
	});

	vIt("rejects narrows on the error too", async () => {
		const boom = () => Promise.reject(new TypeError("boom happened"));

		await vExpect(assert.rejects(boom, /boom/)).resolves.toBeUndefined();
		await vExpect(assert.rejects(boom, TypeError)).resolves.toBeUndefined();
		await vExpect(assert.rejects(boom, RangeError)).rejects.toThrow();
	});

	vIt("doesNotReject accepts a resolve and refuses a rejection", async () => {
		await vExpect(
			assert.doesNotReject(() => Promise.resolve(1)),
		).resolves.toBeUndefined();
		await vExpect(
			assert.doesNotReject(() => Promise.reject(new Error("boom"))),
		).rejects.toThrow();
	});

	vIt("doesNotRejects is the same under its plural spelling", async () => {
		await vExpect(
			assert.doesNotRejects(() => Promise.resolve(1)),
		).resolves.toBeUndefined();
		await vExpect(
			assert.doesNotRejects(() => Promise.reject(new Error("boom"))),
		).rejects.toThrow();
	});
});

describe("helix > failing on purpose", () => {
	vIt("fail() throws with the message it was given", () => {
		vExpect(() => assert.fail("nope")).toThrow(/nope/);
		vExpect(() => assert.fail()).toThrow(/assert\.fail\(\)/);
	});

	vIt(
		"fail() carries actual, expected and the operator in the long form",
		() => {
			try {
				assert.fail(1, 2, "one is not two", "==");
				vExpect.unreachable("fail() must throw");
			} catch (error) {
				const failure = error as {
					message: string;
					actual: unknown;
					expected: unknown;
					operator: unknown;
				};
				vExpect(failure.message).toBe("one is not two");
				vExpect(failure.actual).toBe(1);
				vExpect(failure.expected).toBe(2);
				vExpect(failure.operator).toBe("==");
			}
		},
	);

	vIt("the callable form asserts truthiness", () => {
		vExpect(() => assert("x")).not.toThrow();
		vExpect(() => assert("")).toThrow();
	});
});
