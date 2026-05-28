/**
 * Self-test: lifecycle hooks (beforeEach / afterEach / beforeAll /
 * afterAll). Verifies ordering and per-test isolation.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "@c9up/helix";

// NOTE: tests in these describes assert exact log sequences that
// depend on tests running SEQUENTIALLY in source order. If/when the
// runtime adds `test.concurrent` / `--shuffle` / per-suite parallelism,
// these assertions will need to be reformulated (e.g. one test per
// scenario with isolated state). Today (`runtime/run.ts`'s sequential
// `for (const child of node.children)` loop) the order is deterministic.
describe("lifecycle — beforeEach/afterEach order in a flat suite", () => {
	const log: string[] = [];

	beforeEach(() => {
		log.push("before");
	});
	afterEach(() => {
		log.push("after");
	});

	test("first test sees its before hook", () => {
		log.push("test1");
		expect(log).toEqual(["before", "test1"]);
	});

	test("second test sees the previous after, then its own before", () => {
		log.push("test2");
		expect(log).toEqual(["before", "test1", "after", "before", "test2"]);
	});

	test("third test confirms two full before/after cycles preceded it", () => {
		log.push("test3");
		expect(log).toEqual([
			"before",
			"test1",
			"after",
			"before",
			"test2",
			"after",
			"before",
			"test3",
		]);
	});
});

describe("lifecycle — per-test state isolation", () => {
	let counter: number;

	beforeEach(() => {
		counter = 0;
	});

	test("first test: counter starts at 0, can be mutated", () => {
		expect(counter).toBe(0);
		counter += 5;
		expect(counter).toBe(5);
	});

	test("second test: counter has been re-initialised by beforeEach", () => {
		expect(counter).toBe(0);
	});
});

describe("lifecycle — beforeAll runs once before any test", () => {
	let setupCount = 0;
	let teardownCount = 0;

	beforeAll(() => {
		setupCount += 1;
	});
	afterAll(() => {
		teardownCount += 1;
	});

	test("first test: setup ran exactly once", () => {
		expect(setupCount).toBe(1);
		expect(teardownCount).toBe(0);
	});

	test("second test: setup still 1, teardown still 0 until suite ends", () => {
		expect(setupCount).toBe(1);
		expect(teardownCount).toBe(0);
	});
});

describe("lifecycle — nested describe inherits parent hooks", () => {
	const log: string[] = [];

	beforeEach(() => {
		log.push("outer-before");
	});

	describe("inner suite", () => {
		beforeEach(() => {
			log.push("inner-before");
		});

		test("hooks fire outer-before then inner-before", () => {
			expect(log).toEqual(["outer-before", "inner-before"]);
		});
	});
});
