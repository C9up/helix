/**
 * Parity coverage for the `@japa/runner` + Vitest features added to the
 * runtime: retries, per-test timeout, `--grep`/`--tags` filtering,
 * `test.fails`, `onTestFinished`/`onTestFailed`, hook cleanup returns,
 * `test.each(fn)`, assertion counting, and the new matchers / asymmetric
 * matchers.
 */

import { describe, expect as vExpect, it as vIt } from "vitest";
import { expect } from "../../../src/runtime/expect.js";
import { matchers } from "../../../src/runtime/matchers.js";
import { executeRoot } from "../../../src/runtime/run.js";
import {
	afterEach,
	beforeEach,
	describe as hDescribe,
	resetRoot,
	test,
} from "../../../src/runtime/suite.js";
import {
	onTestFailed,
	onTestFinished,
} from "../../../src/runtime/test-context.js";

interface SpyStub {
	__helixIsSpy: true;
	calls: unknown[][];
	callCount: number;
}
function spyWith(calls: unknown[][]): SpyStub {
	return { __helixIsSpy: true, calls, callCount: calls.length };
}

describe("new matchers", () => {
	vIt("toStrictEqual distinguishes undefined keys and prototypes", () => {
		vExpect(matchers.toStrictEqual({ a: 1 }, { a: 1 }).pass).toBe(true);
		vExpect(matchers.toStrictEqual({ a: 1 }, { a: 1, b: undefined }).pass).toBe(
			false,
		);
		class Point {
			constructor(public x: number) {}
		}
		vExpect(matchers.toStrictEqual(new Point(1), { x: 1 }).pass).toBe(false);
	});

	vIt("toHaveProperty walks dot/bracket paths and checks value", () => {
		const obj = { a: { b: [{ c: 42 }] } };
		vExpect(matchers.toHaveProperty(obj, "a.b").pass).toBe(true);
		vExpect(matchers.toHaveProperty(obj, "a.b[0].c").pass).toBe(true);
		vExpect(matchers.toHaveProperty(obj, "a.b[0].c", 42).pass).toBe(true);
		vExpect(matchers.toHaveProperty(obj, "a.b[0].c", 99).pass).toBe(false);
		vExpect(matchers.toHaveProperty(obj, "a.x").pass).toBe(false);
	});

	vIt("toBeCloseTo respects the digits tolerance", () => {
		vExpect(matchers.toBeCloseTo(0.1 + 0.2, 0.3).pass).toBe(true);
		vExpect(matchers.toBeCloseTo(1.23, 1.2, 1).pass).toBe(true);
		vExpect(matchers.toBeCloseTo(1.23, 1.2, 2).pass).toBe(false);
	});

	vIt("toHaveBeenLastCalledWith / toHaveBeenNthCalledWith", () => {
		const spy = spyWith([["a"], ["b"], ["c"]]);
		vExpect(matchers.toHaveBeenLastCalledWith(spy, "c").pass).toBe(true);
		vExpect(matchers.toHaveBeenLastCalledWith(spy, "a").pass).toBe(false);
		vExpect(matchers.toHaveBeenNthCalledWith(spy, 1, "a").pass).toBe(true);
		vExpect(matchers.toHaveBeenNthCalledWith(spy, 2, "b").pass).toBe(true);
		vExpect(matchers.toHaveBeenNthCalledWith(spy, 4, "z").pass).toBe(false);
	});
});

describe("asymmetric matchers", () => {
	vIt("objectContaining / arrayContaining / stringContaining", () => {
		expect({ a: 1, b: 2, c: 3 }).toEqual(
			expect.objectContaining({ a: 1, c: 3 }),
		);
		expect([1, 2, 3]).toEqual(expect.arrayContaining([3, 1]));
		expect("hello world").toEqual(expect.stringContaining("lo wo"));
		expect("hello").toEqual(expect.stringMatching(/^he/));
	});

	vIt("any / anything match by type / presence", () => {
		expect(5).toEqual(expect.any(Number));
		expect("x").toEqual(expect.any(String));
		expect(new Date()).toEqual(expect.any(Date));
		expect(0).toEqual(expect.anything());
		vExpect(() => expect(null).toEqual(expect.anything())).toThrow();
	});

	vIt("compose inside deep structures and spy args", () => {
		expect({ user: { id: 7, name: "Ada" }, tags: ["a", "b"] }).toEqual({
			user: expect.objectContaining({ id: expect.any(Number) }),
			tags: expect.arrayContaining(["a"]),
		});
		const spy = spyWith([[{ id: 1, extra: true }]]);
		vExpect(
			matchers.toHaveBeenCalledWith(spy, expect.objectContaining({ id: 1 }))
				.pass,
		).toBe(true);
	});
});

describe("retries", () => {
	vIt("test.retry re-runs the cycle until it passes", async () => {
		const root = resetRoot();
		let attempts = 0;
		const cycle: string[] = [];
		hDescribe("flaky", () => {
			beforeEach(() => {
				cycle.push("before");
			});
			afterEach(() => {
				cycle.push("after");
			});
			test("eventually green", () => {
				attempts += 1;
				if (attempts < 3) throw new Error("not yet");
			}).retry(3);
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.pass).toBe(1);
		vExpect(attempts).toBe(3);
		// Each attempt re-runs beforeEach + afterEach.
		vExpect(cycle.filter((c) => c === "before").length).toBe(3);
		vExpect(cycle.filter((c) => c === "after").length).toBe(3);
	});

	vIt("executeRoot({ retries }) applies as the default", async () => {
		const root = resetRoot();
		let n = 0;
		test("flaky", () => {
			n += 1;
			if (n < 2) throw new Error("retry me");
		});
		const result = await executeRoot(root, "inline", { retries: 2 });
		vExpect(result.totals.pass).toBe(1);
	});

	vIt("gives up after exhausting retries", async () => {
		const root = resetRoot();
		test("always red", () => {
			throw new Error("boom");
		}).retry(2);
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.fail).toBe(1);
	});
});

describe("per-test timeout", () => {
	vIt("test.timeout fails a slow test", async () => {
		const root = resetRoot();
		test("slow", async () => {
			await new Promise((r) => setTimeout(r, 200));
		}).timeout(20);
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.fail).toBe(1);
		vExpect(result.tests[0].error?.message).toMatch(/timeout/);
	});

	vIt("options object timeout via 3rd arg", async () => {
		const root = resetRoot();
		test(
			"slow-opts",
			async () => {
				await new Promise((r) => setTimeout(r, 200));
			},
			{ timeout: 20 },
		);
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.fail).toBe(1);
	});

	vIt("disableTimeout overrides an ambient timeout", async () => {
		const root = resetRoot();
		test("no-limit", async () => {
			await new Promise((r) => setTimeout(r, 40));
		}).disableTimeout();
		const result = await executeRoot(root, "inline", { timeoutMs: 10 });
		vExpect(result.totals.pass).toBe(1);
	});
});

describe("grep + tags filtering", () => {
	vIt("grep skips non-matching tests", async () => {
		const root = resetRoot();
		test("alpha login", () => {});
		test("beta logout", () => {});
		const result = await executeRoot(root, "inline", { grep: "login" });
		vExpect(result.totals.pass).toBe(1);
		vExpect(result.totals.skip).toBe(1);
	});

	vIt("tags include / exclude", async () => {
		const root = resetRoot();
		test("fast one", () => {}).tags("@fast");
		test("slow one", () => {}).tags("@slow");
		const inc = await executeRoot(root, "inline", { tags: ["@slow"] });
		vExpect(inc.totals.pass).toBe(1);
		vExpect(inc.totals.skip).toBe(1);

		const root2 = resetRoot();
		test("fast two", () => {}).tags("@fast");
		test("slow two", () => {}).tags("@slow");
		const exc = await executeRoot(root2, "inline", { tags: ["!@slow"] });
		vExpect(exc.tests.find((t) => t.name === "fast two")?.status).toBe("pass");
		vExpect(exc.tests.find((t) => t.name === "slow two")?.status).toBe("skip");
	});
});

describe("test.fails", () => {
	vIt("passes when the body throws, fails when it passes", async () => {
		const root = resetRoot();
		test("expected broken", () => {
			throw new Error("still broken");
		}).fails();
		test("unexpectedly fixed", () => {}).fails();
		const result = await executeRoot(root, "inline");
		vExpect(
			result.tests.find((t) => t.name === "expected broken")?.status,
		).toBe("pass");
		vExpect(
			result.tests.find((t) => t.name === "unexpectedly fixed")?.status,
		).toBe("fail");
	});
});

describe("onTestFinished / onTestFailed", () => {
	vIt("onTestFinished always runs, onTestFailed only on failure", async () => {
		const root = resetRoot();
		const log: string[] = [];
		test("ok", () => {
			onTestFinished(() => log.push("finished:ok"));
			onTestFailed(() => log.push("failed:ok"));
		});
		test("ko", () => {
			onTestFinished(() => log.push("finished:ko"));
			onTestFailed(() => log.push("failed:ko"));
			throw new Error("nope");
		});
		await executeRoot(root, "inline");
		vExpect(log).toContain("finished:ok");
		vExpect(log).not.toContain("failed:ok");
		vExpect(log).toContain("finished:ko");
		vExpect(log).toContain("failed:ko");
	});
});

describe("hook cleanup returns", () => {
	vIt("a beforeEach returning a fn registers a test cleanup", async () => {
		const root = resetRoot();
		const log: string[] = [];
		hDescribe("s", () => {
			beforeEach(() => {
				log.push("setup");
				return () => {
					log.push("teardown");
				};
			});
			test("body", () => {
				log.push("body");
			});
		});
		await executeRoot(root, "inline");
		vExpect(log).toEqual(["setup", "body", "teardown"]);
	});
});

describe("assertion counting", () => {
	vIt("expect.assertions enforces an exact count", async () => {
		const root = resetRoot();
		test("exact ok", () => {
			expect.assertions(2);
			expect(1).toBe(1);
			expect(2).toBe(2);
		});
		test("exact wrong", () => {
			expect.assertions(2);
			expect(1).toBe(1);
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.tests.find((t) => t.name === "exact ok")?.status).toBe(
			"pass",
		);
		vExpect(result.tests.find((t) => t.name === "exact wrong")?.status).toBe(
			"fail",
		);
	});

	vIt("expect.hasAssertions fails when none ran", async () => {
		const root = resetRoot();
		test("has none", () => {
			expect.hasAssertions();
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.fail).toBe(1);
	});
});

describe("test.each with a function source", () => {
	vIt("resolves rows from a function at collection time", async () => {
		const root = resetRoot();
		test.each(() => [1, 2, 3])("n=%s is positive", (n) => {
			expect(n).toBeGreaterThan(0);
		});
		const result = await executeRoot(root, "inline");
		vExpect(result.totals.pass).toBe(3);
	});
});
