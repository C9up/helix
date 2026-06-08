import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runTestFile } from "../../../src/runtime/worker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, "../../fixtures/runtime/sample-file.ts");

describe("runTestFile — worker entry", () => {
	it("loads a file and returns a structured FileResult", async () => {
		const result = await runTestFile(fixturePath);
		expect(result.file).toBe(fixturePath);
		expect(result.totals.pass).toBe(1);
		expect(result.totals.fail).toBe(1);
		expect(result.totals.skip).toBe(1);
		expect(result.totals.todo).toBe(1);
		expect(result.tests.length).toBe(4);

		const failing = result.tests.find((t) => t.status === "fail");
		expect(failing?.error?.name).toBe("AssertionError");
		expect(failing?.error?.operator).toBe("toBe");
		expect(failing?.fullName).toContain("fixture > fails on purpose");
	});

	it("re-runs same file without module-cache leaking", async () => {
		const a = await runTestFile(fixturePath);
		const b = await runTestFile(fixturePath);
		// Both runs collect the same tests — cache-busting re-executes the body.
		expect(a.tests.length).toBe(b.tests.length);
		expect(a.totals).toEqual(b.totals);
		expect(a.totals.pass + a.totals.fail).toBeGreaterThan(0);
	});

	it("concurrent runs do not leak suite state across each other", async () => {
		const [a, b] = await Promise.all([
			runTestFile(fixturePath),
			runTestFile(fixturePath),
		]);
		// Both must see the full fixture — not one with all tests and the other empty.
		expect(a.tests.length).toBe(b.tests.length);
		expect(a.totals).toEqual(b.totals);
	});

	it("rejects non-absolute paths", async () => {
		await expect(runTestFile("relative/path.ts")).rejects.toThrow(
			/absolute path/,
		);
	});
});
