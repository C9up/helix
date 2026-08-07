/**
 * The `@japa/runner/core` stand-in.
 *
 * A plugin imports from that module and gets whatever the specifier resolved
 * to. Missing an export is not a degraded experience, it is an ImportError
 * before any test runs — so every name the real module exports has to be here,
 * even the ones helix cannot honour.
 */

import { describe, expect, it } from "vitest";
import {
	BaseReporter,
	Emitter,
	Group,
	JapaClassNotConstructibleError,
	Refiner,
	Runner,
	Suite,
	Test,
	TestContext,
} from "../../../src/japa/core.js";
import { TestContextRegistry } from "../../../src/runtime/context.js";

describe("@japa/runner/core shim", () => {
	it("exports every name the real module does", () => {
		// `@japa/runner/build/modules/core/main.d.ts` exports exactly these.
		for (const exported of [
			Emitter,
			Refiner,
			BaseReporter,
			TestContext,
			Test,
			Group,
			Suite,
			Runner,
		]) {
			expect(typeof exported).toBe("function");
		}
	});

	it("says which module an import resolved to", () => {
		// Parent and workers must agree; when they did not, this was the question
		// that took an afternoon.
		expect(Test.isHelixShim).toBe(true);
		expect(TestContext.isHelixShim).toBe(true);
	});

	it("Emitter is helix's own, so a plugin subscribes to the real run", () => {
		const emitter = new Emitter();
		const seen: string[] = [];
		emitter.on("runner:start", () => seen.push("start"));
		emitter.emit("runner:start", {});

		expect(seen).toEqual(["start"]);
	});

	it("Refiner collects what a plugin puts in it", () => {
		const refiner = new Refiner().add("tags", ["@a"]).add("tags", ["@b"]);
		refiner.matchAllTags();

		expect(refiner.filters.tags).toEqual(["@a", "@b"]);
		expect(refiner.filters.matchAll).toBe(true);
	});

	it("TestContext.getter forwards to helix's registry", () => {
		TestContext.getter("shimProbe", () => "value", true);
		expect(TestContextRegistry.has("shimProbe")).toBe(true);
		TestContextRegistry.clear("shimProbe");
	});

	it("refuses to construct what helix owns, with the reason", () => {
		// They exist so the import resolves and `instanceof` answers `false`,
		// which is the right answer: a helix group is not a Japa Group.
		for (const Klass of [BaseReporter, Group, Suite, Runner]) {
			expect(() => new Klass()).toThrow(JapaClassNotConstructibleError);
			expect(() => new Klass()).toThrow(/drives its own run/);
		}
	});
});
