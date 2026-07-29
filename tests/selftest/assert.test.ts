/**
 * Self-test: the injected `ctx.assert` surface (@japa/assert parity).
 */

import { expect, test } from "@c9up/helix";

test("assert core matchers pass on valid input", ({ assert }) => {
	assert(true);
	assert.equal(1, "1"); // loose
	assert.strictEqual(2, 2);
	assert.notStrictEqual(2, 3);
	assert.deepEqual({ a: [1, 2] }, { a: [1, 2] });
	assert.isTrue(true);
	assert.isFalse(false);
	assert.isNull(null);
	assert.exists(0);
	assert.notExists(undefined);
	assert.isAbove(5, 3);
	assert.isAtMost(3, 3);
	assert.lengthOf([1, 2, 3], 3);
	assert.isEmpty([]);
	assert.isNotEmpty("x");
	assert.include([1, 2, 3], 2);
	assert.include({ a: 1, b: 2 }, { a: 1 });
	assert.property({ k: 1 }, "k");
	assert.propertyVal({ k: 1 }, "k", 1);
	assert.instanceOf(new Error("x"), Error);
	assert.typeOf([], "array");
	assert.isString("s");
	assert.match("hello", /ell/);
	assert.oneOf(2, [1, 2, 3]);
	assert.throws(() => {
		throw new TypeError("boom");
	}, TypeError);
	assert.doesNotThrow(() => 1);
});

test("assert @japa aliases + property-set matchers", ({ assert }) => {
	assert.ok(1);
	assert.notOk(0);
	assert.empty([]);
	assert.notEmpty([1]);
	assert.deepInclude([{ id: 1 }], { id: 1 });
	assert.notDeepInclude([{ id: 1 }], { id: 2 });
	assert.properties({ a: 1, b: 2, c: 3 }, ["a", "b"]);
	assert.notAllProperties({ a: 1 }, ["a", "z"]);
	assert.onlyProperties({ a: 1, b: 2 }, ["a", "b"]);
	assert.notAnyProperties({ a: 1 }, ["x", "y"]);
	expect(() => assert.onlyProperties({ a: 1, b: 2 }, ["a"])).toThrow();
	expect(() => assert.properties({ a: 1 }, ["a", "b"])).toThrow();
});

test("assert negation + numeric/object-state matchers", ({ assert }) => {
	assert.isNotTrue(1);
	assert.isNotFalse(0);
	assert.isNotArray({});
	assert.isNotString(1);
	assert.isFinite(42);
	assert.closeTo(1.0001, 1, 0.001);
	assert.isFrozen(Object.freeze({}));
	assert.isNotFrozen({});
	assert.isSealed(Object.seal({}));
	assert.notPropertyVal({ a: 1 }, "a", 2);
	assert.notLengthOf([1, 2], 3);
	expect(() => assert.isFinite(Number.POSITIVE_INFINITY)).toThrow();
	expect(() => assert.closeTo(1, 5, 0.1)).toThrow();
	expect(() => assert.isFrozen({})).toThrow();
});

test("assert members/subset/deep-property + fail overload", ({ assert }) => {
	assert.deepPropertyVal({ a: { x: 1 } }, "a", { x: 1 });
	assert.notDeepPropertyVal({ a: { x: 1 } }, "a", { x: 2 });
	assert.includeMembers([1, 2, 3], [3, 1]);
	assert.sameMembers([1, 2, 3], [3, 2, 1]);
	assert.containSubset({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } });
	assert.notTypeOf(1, "string");
	assert.isNotFunction(1);
	assert.isNotNaN(1);
	assert.frozen(Object.freeze({}));
	assert.notFrozen({});
	expect(() => assert.sameMembers([1, 2], [1, 2, 3])).toThrow();
	expect(() => assert.containSubset({ a: 1 }, { b: 2 })).toThrow();
	// fail overloads: message-only and actual/expected/operator.
	expect(() => assert.fail("boom")).toThrow(/boom/);
	expect(() => assert.fail(1, 2, "mismatch", "==")).toThrow(/mismatch/);
});

test("assert.rejects handles async throws", async ({ assert }) => {
	await assert.rejects(async () => {
		throw new Error("nope");
	}, "nope");
	await assert.doesNotReject(async () => 1);
});

test("assert failure throws an AssertionError", ({ assert }) => {
	expect(() => assert.equal(1, 2)).toThrow();
	expect(() => assert.isTrue(false)).toThrow();
});

test("assert.plan enforces the assertion count", ({ assert }) => {
	assert.plan(2);
	assert.isTrue(true);
	assert.equal(1, 1);
});
