import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Import barrels so the coverage tool sees them as executed, not just
// statically parsed.
import * as helixMain from "../../../src/index.js";
import * as runtimeBarrel from "../../../src/runtime/index.js";
import * as lifecycleBarrel from "../../../src/runtime/lifecycle.js";
import { matchers } from "../../../src/runtime/matchers.js";
import { executeRoot } from "../../../src/runtime/run.js";
import { resetRoot, test } from "../../../src/runtime/suite.js";
import { vi } from "../../../src/runtime/vi/index.js";
import { runTestFile } from "../../../src/runtime/worker.js";

describe("matchers.toThrow — advanced expected forms", () => {
	class MyErr extends Error {
		constructor(msg: string) {
			super(msg);
			this.name = "MyErr";
		}
	}

	it("matches by Error constructor", () => {
		const r = matchers.toThrow(() => {
			throw new MyErr("boom");
		}, MyErr);
		expect(r.pass).toBe(true);
	});

	it("fails when constructor does not match", () => {
		const r = matchers.toThrow(() => {
			throw new TypeError("nope");
		}, MyErr);
		expect(r.pass).toBe(false);
		expect(r.message()).toContain("MyErr");
	});

	it("matches by Error instance (same proto + message)", () => {
		const expected = new MyErr("exact");
		const r = matchers.toThrow(() => {
			throw new MyErr("exact");
		}, expected);
		expect(r.pass).toBe(true);
	});

	it("fails on Error instance when messages differ", () => {
		const r = matchers.toThrow(() => {
			throw new MyErr("other");
		}, new MyErr("exact"));
		expect(r.pass).toBe(false);
	});

	it("rejects non-function received", () => {
		const r = matchers.toThrow(123);
		expect(r.pass).toBe(false);
		expect(r.message()).toContain("function");
	});

	it("throws-a-non-Error value still matched by string", () => {
		const r = matchers.toThrow(() => {
			throw "plain string";
		}, "plain");
		expect(r.pass).toBe(true);
	});

	it("reprExpected covers all expected shapes via message", () => {
		class MyE extends Error {}
		// String.
		expect(
			matchers
				.toThrow(() => {
					throw new Error("actual");
				}, "no-match")
				.message(),
		).toContain('"no-match"');
		// RegExp.
		expect(
			matchers
				.toThrow(() => {
					throw new Error("actual");
				}, /no-match/)
				.message(),
		).toContain("/no-match/");
		// Error instance.
		expect(
			matchers
				.toThrow(() => {
					throw new Error("actual");
				}, new MyE("different"))
				.message(),
		).toContain('MyE("different")');
		// Constructor name.
		expect(
			matchers
				.toThrow(() => {
					throw new Error("actual");
				}, MyE)
				.message(),
		).toContain("MyE");
	});

	it("matchThrownError with non-Error received + string expected", () => {
		const r = matchers.toThrow(() => {
			throw 42;
		}, "42");
		expect(r.pass).toBe(true);
	});

	it("matchThrownError with Error instance differing prototypes", () => {
		class A extends Error {}
		class B extends Error {}
		const r = matchers.toThrow(() => {
			throw new A("same");
		}, new B("same"));
		expect(r.pass).toBe(false);
	});

	it("toContain default fall-through for non-string/array/Set returns false", () => {
		expect(matchers.toContain({ a: 1 }, 1).pass).toBe(false);
		expect(matchers.toContain(new Map([["k", 1]]), "k").pass).toBe(false);
	});

	it("toBeGreaterThan bigint vs number (mixed) uses Number coercion", () => {
		expect(matchers.toBeGreaterThan(5, 3n).pass).toBe(true);
		expect(matchers.toBeGreaterThanOrEqual(3n, 3).pass).toBe(true);
	});

	it("toBeNull/toBeDefined error messages reachable", () => {
		expect(matchers.toBeNull(42).message()).toContain("null");
		expect(matchers.toBeDefined(undefined).message()).toContain("defined");
	});
});

describe("equals — strict mode edge paths", () => {
	it("strict mode distinguishes class instances from plain objects", async () => {
		const { equals } = await import("../../../src/runtime/equals.js");
		class Foo {
			x = 1;
		}
		expect(equals(new Foo(), { x: 1 })).toBe(true);
		expect(equals(new Foo(), { x: 1 }, { strict: true })).toBe(false);
	});

	it("strict mode cares about key counts", async () => {
		const { equals } = await import("../../../src/runtime/equals.js");
		expect(equals({ a: 1 }, { a: 1, b: 2 }, { strict: true })).toBe(false);
	});

	it("partialEquals delegates to equals for Date/RegExp/Error", async () => {
		const { partialEquals } = await import("../../../src/runtime/equals.js");
		expect(partialEquals(new Date(42), new Date(42))).toBe(true);
		expect(partialEquals(/foo/g, /foo/g)).toBe(true);
		expect(partialEquals(new Error("x"), new Error("x"))).toBe(true);
	});
});

describe("fake-timers — edge branches", () => {
	it("clearTimeout with a plain numeric id", () => {
		vi.useFakeTimers();
		const handle = setTimeout(() => {}, 1000);
		// The handle IS a Timer; pass its numeric id explicitly.
		const rawId = Reflect.get(handle, "id") as number;
		clearTimeout(rawId);
		expect(vi.getTimerCount()).toBe(0);
		vi.useRealTimers();
	});

	it("clearInterval / clearImmediate aliases drop timers", () => {
		vi.useFakeTimers();
		const a = setInterval(() => {}, 10);
		const b = setImmediate(() => {});
		clearInterval(a);
		clearImmediate(b);
		expect(vi.getTimerCount()).toBe(0);
		vi.useRealTimers();
	});

	it("setInterval with 0 is bumped to 1ms", () => {
		vi.useFakeTimers();
		let count = 0;
		const id = setInterval(() => {
			count += 1;
		}, 0);
		vi.advanceTimersByTime(3);
		expect(count).toBe(3);
		clearInterval(id);
		vi.useRealTimers();
	});
});

describe("suite.interpolateEach — object row paths", () => {
	it("expands $field and $#", async () => {
		const root = resetRoot();
		test.each([
			{ a: 1, b: 2 },
			{ a: 10, b: 20 },
		])("row $# — $a + $b", () => {});
		const result = await executeRoot(root, "inline");
		expect(result.tests[0].name).toBe("row 0 — 1 + 2");
		expect(result.tests[1].name).toBe("row 1 — 10 + 20");
	});

	it("expands nested $field.subfield", async () => {
		const root = resetRoot();
		test.each([{ user: { name: "ada" } }])("greet $user.name", () => {});
		const result = await executeRoot(root, "inline");
		expect(result.tests[0].name).toBe("greet ada");
	});

	it("missing field renders as literal 'undefined'", async () => {
		const root = resetRoot();
		test.each([{ a: 1 }])("has $nope", () => {});
		const result = await executeRoot(root, "inline");
		expect(result.tests[0].name).toBe("has undefined");
	});

	it("object field whose value is an object stringifies as JSON", async () => {
		const root = resetRoot();
		test.each([{ user: { id: 1 } }])("row $user", () => {});
		const result = await executeRoot(root, "inline");
		expect(result.tests[0].name).toBe('row {"id":1}');
	});

	it("array row supports %j / %o / %%", async () => {
		const root = resetRoot();
		test.each([[{ n: 1 }]])("obj=%j done %%", () => {});
		const result = await executeRoot(root, "inline");
		expect(result.tests[0].name).toBe('obj={"n":1} done %');
	});

	it("array row with circular object uses String() fallback", async () => {
		const root = resetRoot();
		type Cyc = { self?: Cyc };
		const cyc: Cyc = {};
		cyc.self = cyc;
		test.each([[cyc]])("cyc=%o", () => {});
		const result = await executeRoot(root, "inline");
		expect(result.tests[0].name).toContain("[object Object]");
	});
});

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, "../../fixtures/runtime/sample-file.ts");

const unserialisableFixture = path.resolve(
	here,
	"../../fixtures/runtime/unserialisable-failures.ts",
);

describe("worker.safeValue — sanitize unserialisable AssertionError values", () => {
	it("every branch (BigInt, symbol, function, circular, Map, Set, Date, RegExp, Error) survives JSON.stringify", async () => {
		const result = await runTestFile(unserialisableFixture);
		expect(result.totals.fail).toBe(9);
		// The whole result must round-trip through JSON without exceptions.
		const serialised = JSON.stringify(result);
		expect(serialised).toBeTypeOf("string");
		// Spot-check a few normalised forms.
		expect(serialised).toContain('"__type":"Map"');
		expect(serialised).toContain('"__type":"Set"');
		expect(serialised).toContain('"__type":"Date"');
		expect(serialised).toContain('"__type":"RegExp"');
		expect(serialised).toContain('"__type":"Error"');
		expect(serialised).toContain("[Circular]");
		// BigInt normalised to `<n>n` string form.
		expect(serialised).toMatch(/"1n"|"2n"/);
	});

	it("plain FileResult also survives (smoke)", async () => {
		const result = await runTestFile(fixturePath);
		expect(() => JSON.stringify(result)).not.toThrow();
	});

	it("runTestFile rejects relative paths", async () => {
		await expect(runTestFile("foo/bar.ts")).rejects.toThrow(/absolute/);
	});
});

describe("run.executeRoot — root-level hook failures", () => {
	it("root beforeAll failure aborts children and still runs afterAll", async () => {
		const root = resetRoot();
		const { afterAll, beforeAll } = await import(
			"../../../src/runtime/suite.js"
		);
		beforeAll(() => {
			throw new Error("root setup fail");
		});
		let afterAllRan = false;
		afterAll(() => {
			afterAllRan = true;
		});
		test("never", () => {});
		const result = await executeRoot(root, "inline");
		// beforeAll synthetic fail entry.
		expect(result.totals.fail).toBeGreaterThanOrEqual(1);
		expect(
			result.tests.some((t) => t.name === "beforeAll" && t.status === "fail"),
		).toBe(true);
		// afterAll ALWAYS runs per the patch.
		expect(afterAllRan).toBe(true);
	});

	it("root afterAll failure surfaces as a synthetic test fail", async () => {
		const root = resetRoot();
		const { afterAll } = await import("../../../src/runtime/suite.js");
		afterAll(() => {
			throw new Error("root teardown fail");
		});
		test("ok", () => {});
		const result = await executeRoot(root, "inline");
		expect(
			result.tests.some((t) => t.name === "afterAll" && t.status === "fail"),
		).toBe(true);
	});
});

describe("barrels re-export the expected surface", () => {
	it("main barrel exposes vi + describe + expect + AssertionError", () => {
		expect(typeof helixMain.describe).toBe("function");
		expect(typeof helixMain.expect).toBe("function");
		expect(typeof helixMain.vi).toBe("object");
		expect(helixMain.AssertionError).toBeDefined();
	});

	it("runtime barrel re-exports the full runtime surface", () => {
		expect(typeof runtimeBarrel.runTestFile).toBe("function");
		expect(typeof runtimeBarrel.executeRoot).toBe("function");
		expect(typeof runtimeBarrel.withViContext).toBe("function");
	});

	it("lifecycle barrel exposes the 4 hooks", () => {
		expect(typeof lifecycleBarrel.beforeAll).toBe("function");
		expect(typeof lifecycleBarrel.afterAll).toBe("function");
		expect(typeof lifecycleBarrel.beforeEach).toBe("function");
		expect(typeof lifecycleBarrel.afterEach).toBe("function");
	});
});

describe("spy one-shot queue (additional branches)", () => {
	it("mockResolvedValueOnce queues a resolved Promise", async () => {
		const spy = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce("a")
			.mockResolvedValueOnce("b");
		await expect(spy()).resolves.toBe("a");
		await expect(spy()).resolves.toBe("b");
		// After the queue drains, the default impl is unset → synchronous undefined.
		expect(spy()).toBeUndefined();
	});

	it("mockRejectedValueOnce queues a rejection", async () => {
		const spy = vi.fn<() => Promise<never>>();
		spy.mockRejectedValueOnce(new Error("once"));
		await expect(spy()).rejects.toThrow("once");
		// After one-shot consumed, the default impl is unset → synchronous undefined.
		expect(spy()).toBeUndefined();
	});

	it("mockImplementationOnce overrides, then falls back", () => {
		const spy = vi.fn((n: number) => n * 2);
		spy.mockImplementationOnce(() => 99);
		expect(spy(1)).toBe(99);
		expect(spy(1)).toBe(2);
	});
});

describe("vi.spyOn accessor setter", () => {
	it("spies on a setter via { accessor: 'set' }", () => {
		const obj = {
			_n: 0,
			set n(v: number) {
				this._n = v;
			},
			get n(): number {
				return this._n;
			},
		};
		const spy = vi.spyOn(obj, "n", { accessor: "set" });
		obj.n = 42;
		expect(spy.mock.calls).toEqual([[42]]);
		expect(obj._n).toBe(42);
		spy.mockRestore();
		obj.n = 7;
		expect(obj._n).toBe(7);
		// After restore, spy no longer records.
		expect(spy.mock.calls.length).toBe(0);
	});

	it("rejects accessor mode on a property with no setter", () => {
		const obj = {
			get ro(): number {
				return 1;
			},
		};
		expect(() => vi.spyOn(obj, "ro", { accessor: "set" })).toThrow(/no setter/);
	});
});
