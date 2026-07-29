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
