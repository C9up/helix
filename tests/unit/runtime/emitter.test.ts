/**
 * The runner emitter — the helix `Emitter` surface plugins and reporters
 * subscribe to.
 */

import { describe, expect, it } from "vitest";
import { Emitter, type TestEndNode } from "../../../src/runtime/emitter.js";

function endNode(title: string, hasError = false): TestEndNode {
	return {
		title: { original: title, expanded: title },
		tags: [],
		timeout: 0,
		isPinned: false,
		meta: {},
		duration: 1,
		hasError,
		errors: [],
	};
}

describe("Emitter", () => {
	it("delivers a payload to every listener of that event", () => {
		const emitter = new Emitter();
		const seen: string[] = [];
		emitter.on("test:end", (p) => seen.push(`a:${p.title.expanded}`));
		emitter.on("test:end", (p) => seen.push(`b:${p.title.expanded}`));
		emitter.on("group:start", () => seen.push("group"));

		emitter.emit("test:end", endNode("one"));

		expect(seen).toEqual(["a:one", "b:one"]);
	});

	it("once() fires a single time", () => {
		const emitter = new Emitter();
		let calls = 0;
		emitter.once("test:end", () => {
			calls += 1;
		});

		emitter.emit("test:end", endNode("one"));
		emitter.emit("test:end", endNode("two"));

		expect(calls).toBe(1);
	});

	it("off() removes the listener it was given", () => {
		const emitter = new Emitter();
		const seen: string[] = [];
		const handler = (p: TestEndNode): void => {
			seen.push(p.title.expanded);
		};
		emitter.on("test:end", handler);
		emitter.emit("test:end", endNode("kept"));
		emitter.off("test:end", handler);
		emitter.emit("test:end", endNode("dropped"));

		expect(seen).toEqual(["kept"]);
	});

	it("clear() drops every listener", () => {
		const emitter = new Emitter();
		let calls = 0;
		emitter.on("test:end", () => {
			calls += 1;
		});
		emitter.clear();
		emitter.emit("test:end", endNode("one"));

		expect(calls).toBe(0);
	});

	it("isolates a throwing listener from the others", () => {
		const emitter = new Emitter();
		const seen: string[] = [];
		emitter.on("test:end", () => {
			throw new Error("bad listener");
		});
		emitter.on("test:end", (p) => seen.push(p.title.expanded));

		expect(() => emitter.emit("test:end", endNode("one"))).not.toThrow();
		expect(seen).toEqual(["one"]);
	});
});
