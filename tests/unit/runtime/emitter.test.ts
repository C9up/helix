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

describe("Emitter > a listener that fails asynchronously", () => {
	it("is isolated like a synchronous one, and does not end the run", async () => {
		// `EventHandler` returns `void`, and TypeScript accepts an async function
		// for a `void` return — so a reporter written as `async (payload) => …`
		// type-checks and its rejection walked past the try/catch, which only
		// ever saw a synchronous throw. In a test runner that means one reporter
		// awaiting something that fails takes down the run it reports on.
		const errors: unknown[] = [];
		const originalError = console.error;
		const rejections: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			rejections.push(reason);
		};
		console.error = (...args: unknown[]): void => {
			errors.push(args);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const emitter = new Emitter();
			const seen: string[] = [];
			emitter.on("runner:start", async () => {
				seen.push("first");
				throw new Error("the reporter blew up");
			});
			emitter.on("runner:start", () => {
				seen.push("second");
			});

			emitter.emit("runner:start", {});
			await new Promise((resolve) => setTimeout(resolve, 15));

			// Listeners still run in order, and the failure is reported.
			expect(seen).toEqual(["first", "second"]);
			expect(rejections).toEqual([]);
			expect(JSON.stringify(errors)).toContain("listener failed");
		} finally {
			console.error = originalError;
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
