/**
 * `suite.onTest` / `suite.onGroup` — Japa's `Suite` taps. Each method has to
 * land on the field the runtime actually reads, which is what these pin down.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SuiteNode, TestNode } from "../../../src/runtime/suite.js";
import {
	applyTaps,
	groupHandle,
	registerGroupTap,
	registerTestTap,
	resetTaps,
	setBail,
	tappedBail,
	testHandle,
} from "../../../src/runtime/suite-taps.js";

afterEach(() => {
	resetTaps();
});

function makeSuite(name: string, parent?: SuiteNode): SuiteNode {
	return {
		kind: "suite",
		name,
		mode: "run",
		parent,
		children: [],
		hooks: [],
	};
}

function makeTest(name: string, parent: SuiteNode): TestNode {
	const node: TestNode = {
		kind: "test",
		name,
		fn: () => {},
		mode: "run",
		parent,
	};
	parent.children.push(node);
	return node;
}

describe("testHandle", () => {
	it("maps every mutator onto the node the runtime reads", () => {
		const root = makeSuite("root");
		const node = makeTest("t", root);

		testHandle(node)
			.timeout(1234)
			.retry(3)
			.tags(["@a"])
			.waitForDone()
			.pin()
			.fails("expected to throw");

		expect(node.timeoutMs).toBe(1234);
		expect(node.retries).toBe(3);
		expect(node.tags).toEqual(["@a"]);
		expect(node.waitForDone).toBe(true);
		expect(node.pinned).toBe(true);
		expect(node.failing).toBe(true);
		expect(node.reason).toBe("expected to throw");
	});

	it("honours the tag strategies", () => {
		const root = makeSuite("root");
		const node = makeTest("t", root);
		node.tags = ["@declared"];

		testHandle(node).tags(["@appended"], "append");
		expect(node.tags).toEqual(["@declared", "@appended"]);

		testHandle(node).tags(["@first"], "prepend");
		expect(node.tags).toEqual(["@first", "@declared", "@appended"]);

		testHandle(node).tags(["@only"]);
		expect(node.tags).toEqual(["@only"]);
	});

	it("skips statically or lazily, as Japa does", () => {
		const root = makeSuite("root");
		const still = makeTest("still", root);
		const lazy = makeTest("lazy", root);

		testHandle(still).skip(true, "not on CI");
		expect(still.mode).toBe("skip");
		expect(still.reason).toBe("not on CI");

		const condition = (): boolean => true;
		testHandle(lazy).skip(condition);
		expect(lazy.mode).toBe("run");
		expect(lazy.skipCondition).toBe(condition);
	});

	it("disableTimeout and resetTimeout both land on the timeout", () => {
		const root = makeSuite("root");
		const node = makeTest("t", root);

		testHandle(node).timeout(500).disableTimeout();
		expect(node.timeoutMs).toBe(0);

		testHandle(node).resetTimeout(250);
		expect(node.timeoutMs).toBe(250);

		testHandle(node).resetTimeout();
		expect(node.timeoutMs).toBe(0);
	});

	it("appends setup and teardown hooks", () => {
		const root = makeSuite("root");
		const node = makeTest("t", root);
		const before = (): void => {};
		const after = (): void => {};

		testHandle(node).setup(before).teardown(after);

		expect(node.setups).toEqual([before]);
		expect(node.teardowns).toEqual([after]);
	});
});

describe("groupHandle", () => {
	it("registers group hooks under the right kind", () => {
		const group = makeSuite("grp");
		const all = (): void => {};
		const each = (): void => {};

		groupHandle(group).setup(all);
		groupHandle(group).each.setup(each);
		groupHandle(group).each.timeout(99);
		groupHandle(group).each.retry(2);

		expect(group.hooks).toEqual([
			{ type: "beforeAll", fn: all },
			{ type: "beforeEach", fn: each },
		]);
		expect(group.eachTimeout).toBe(99);
		expect(group.eachRetries).toBe(2);
	});

	it("tap reaches every test of the group", () => {
		const group = makeSuite("grp");
		const a = makeTest("a", group);
		const b = makeTest("b", group);

		groupHandle(group).tap((test) => test.retry(5));

		expect([a.retries, b.retries]).toEqual([5, 5]);
	});
});

describe("applyTaps", () => {
	it("visits every test and group, nested ones included", () => {
		const root = makeSuite("root");
		const top = makeTest("top", root);
		const group = makeSuite("grp", root);
		root.children.push(group);
		const nested = makeTest("nested", group);

		const seenTests: string[] = [];
		const seenGroups: string[] = [];
		registerTestTap((test) => {
			seenTests.push(test.title);
			test.tags(["@tapped"]);
		});
		registerGroupTap((g) => seenGroups.push(g.title));

		applyTaps(root);

		expect(seenTests).toEqual(["top", "nested"]);
		expect(seenGroups).toEqual(["grp"]);
		expect(top.tags).toEqual(["@tapped"]);
		expect(nested.tags).toEqual(["@tapped"]);
	});

	it("does nothing when nothing is registered", () => {
		const root = makeSuite("root");
		const node = makeTest("t", root);

		applyTaps(root);

		expect(node.tags).toBeUndefined();
	});
});

describe("bail", () => {
	it("is undefined until a tap asks for it", () => {
		expect(tappedBail()).toBeUndefined();
		setBail(true);
		expect(tappedBail()).toBe(true);
		setBail(false);
		expect(tappedBail()).toBe(false);
	});
});
