import { describe as vDescribe, expect as vExpect, it as vIt } from "vitest";
import { expect } from "../../../src/runtime/expect.js";
import { executeRoot } from "../../../src/runtime/run.js";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	getRoot,
	it,
	resetRoot,
	test,
} from "../../../src/runtime/suite.js";

vDescribe("suite + run — nested DSL", () => {
	vIt("runs a flat test", async () => {
		const root = resetRoot();
		test("adds", () => {
			expect(1 + 1).toBe(2);
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.pass).toBe(1);
		vExpect(result.totals.fail).toBe(0);
	});

	vIt("records failures with AssertionError serialization", async () => {
		const root = resetRoot();
		test("bad", () => {
			expect(1).toBe(2);
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.fail).toBe(1);
		vExpect(result.tests[0].error?.name).toBe("AssertionError");
		vExpect(result.tests[0].error?.operator).toBe("toBe");
	});

	vIt("nests describe and runs hooks in order", async () => {
		const root = resetRoot();
		const events: string[] = [];
		describe("outer", () => {
			beforeAll(() => {
				events.push("outer:beforeAll");
			});
			afterAll(() => {
				events.push("outer:afterAll");
			});
			beforeEach(() => {
				events.push("outer:beforeEach");
			});
			afterEach(() => {
				events.push("outer:afterEach");
			});

			describe("inner", () => {
				beforeAll(() => {
					events.push("inner:beforeAll");
				});
				beforeEach(() => {
					events.push("inner:beforeEach");
				});
				afterEach(() => {
					events.push("inner:afterEach");
				});
				afterAll(() => {
					events.push("inner:afterAll");
				});
				it("t1", () => {
					events.push("t1");
				});
				it("t2", () => {
					events.push("t2");
				});
			});
		});
		await executeRoot(root, "inline");
		vExpect(events).toEqual([
			"outer:beforeAll",
			"inner:beforeAll",
			"outer:beforeEach",
			"inner:beforeEach",
			"t1",
			"inner:afterEach",
			"outer:afterEach",
			"outer:beforeEach",
			"inner:beforeEach",
			"t2",
			"inner:afterEach",
			"outer:afterEach",
			"inner:afterAll",
			"outer:afterAll",
		]);
	});

	vIt("test.each expands rows with %s / %d", async () => {
		const root = resetRoot();
		test.each([
			[1, 2, 3],
			[2, 3, 5],
		])("%d + %d = %d", ([a, b, c]) => {
			expect(a + b).toBe(c);
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.tests.length).toBe(2);
		vExpect(result.tests[0].name).toBe("1 + 2 = 3");
		vExpect(result.tests[1].name).toBe("2 + 3 = 5");
		vExpect(result.totals.pass).toBe(2);
	});

	vIt("test.only downgrades siblings to skip", async () => {
		const root = resetRoot();
		describe("grp", () => {
			test("a", () => {
				// should be skipped
				throw new Error("should not run");
			});
			test.only("b", () => {
				expect(1).toBe(1);
			});
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.pass).toBe(1);
		vExpect(result.totals.skip).toBe(1);
		vExpect(result.totals.fail).toBe(0);
	});

	vIt("describe.only filters siblings to skip", async () => {
		const root = resetRoot();
		describe("a", () => {
			test("a1", () => {
				throw new Error("should not run");
			});
		});
		describe.only("b", () => {
			test("b1", () => {
				expect(1).toBe(1);
			});
			test("b2", () => {
				expect(2).toBe(2);
			});
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.pass).toBe(2);
		vExpect(result.totals.fail).toBe(0);
		// a.a1 was skipped.
		vExpect(result.totals.skip).toBe(1);
	});

	vIt("test.todo marks without failing", async () => {
		const root = resetRoot();
		test.todo("pending idea");
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.todo).toBe(1);
	});

	vIt(
		"beforeAll failure fails all tests in the suite AND nested suites",
		async () => {
			const root = resetRoot();
			describe("g", () => {
				beforeAll(() => {
					throw new Error("setup fail");
				});
				it("t1", () => {});
				describe("inner", () => {
					it("t2", () => {});
					it("t3", () => {});
				});
			});
			const result = await executeRoot(root, "inline");
			vExpect(result.totals.fail).toBe(3);
			for (const t of result.tests) {
				vExpect(t.error?.message).toBe("setup fail");
			}
		},
	);

	vIt("afterAll failure counts as a fail in totals", async () => {
		const root = resetRoot();
		describe("g", () => {
			afterAll(() => {
				throw new Error("teardown fail");
			});
			it("passes", () => {});
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.pass).toBe(1);
		vExpect(result.totals.fail).toBe(1);
	});

	vIt("afterEach errors are combined with test errors", async () => {
		const root = resetRoot();
		describe("g", () => {
			afterEach(() => {
				throw new Error("cleanup fail");
			});
			it("bad", () => {
				throw new Error("body fail");
			});
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.fail).toBe(1);
		vExpect(result.tests[0].error?.message).toContain("body fail");
		vExpect(result.tests[0].error?.message).toContain("cleanup fail");
	});

	vIt("root-level beforeAll/afterAll execute once", async () => {
		const root = resetRoot();
		const events: string[] = [];
		beforeAll(() => {
			events.push("root-before");
		});
		afterAll(() => {
			events.push("root-after");
		});
		test("a", () => {
			events.push("t");
		});
		await executeRoot(root, "inline");
		vExpect(events).toEqual(["root-before", "t", "root-after"]);
	});

	vIt("async describe body throws synchronously at collection", () => {
		resetRoot();
		vExpect(() => {
			// Async body returns a Promise — DSL rejects it loudly.
			describe("bad", (async () => {
				// Empty async body — even with no awaits, still a Promise.
			}) as () => void);
		}).toThrow(/async describe is not supported/i);
	});

	vIt("test.each supports %% as a literal percent sign", async () => {
		const root = resetRoot();
		test.each([[50]])("value=%d%%", () => {});
		const result = await executeRoot(root, "inline");
		vExpect(result.tests[0].name).toBe("value=50%");
	});

	vIt("test timeout surfaces as a fail", async () => {
		const root = resetRoot();
		test("hangs", () => new Promise<void>(() => {}));
		const result = await executeRoot(root, "inline", { timeoutMs: 50 });
		vExpect(result.totals.fail).toBe(1);
		vExpect(result.tests[0].error?.message).toMatch(/timeout/);
	});

	vIt("beforeAll failure fails flat tests (legacy case)", async () => {
		const root = resetRoot();
		describe("g", () => {
			beforeAll(() => {
				throw new Error("setup fail");
			});
			it("t1", () => {});
			it("t2", () => {});
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.fail).toBe(2);
		vExpect(result.tests[0].error?.message).toBe("setup fail");
	});

	vIt("getRoot returns the current root", () => {
		const r = resetRoot();
		vExpect(getRoot()).toBe(r);
	});
});
