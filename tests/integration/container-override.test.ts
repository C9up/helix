/**
 * Integration tests for `helix.override` (Story 42-3, FR69).
 *
 * Covers value-based override, class/string/symbol tokens, manual
 * restore, and auto-restore through `withTestContext` (the runtime
 * lifecycle helix uses to wrap each test file).
 */

import { Container } from "@c9up/ream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearActiveContainer,
	override,
	overrideOn,
	useContainer,
} from "../../src/container/override.js";
import { withTestContext } from "../../src/runtime/test-context.js";

describe("container.override — token shapes", () => {
	let container: InstanceType<typeof Container>;

	beforeEach(() => {
		container = new Container();
	});

	afterEach(() => {
		container.restore();
	});

	it("string token: override returns the value", () => {
		container.singleton("mail", () => ({ send: () => "real" }));
		expect(container.resolve<{ send: () => string }>("mail").send()).toBe(
			"real",
		);

		container.override("mail", { send: () => "fake" });
		expect(container.resolve<{ send: () => string }>("mail").send()).toBe(
			"fake",
		);
	});

	it("class token: override replaces the auto-construct path", () => {
		class MailService {
			send(): string {
				return "real";
			}
		}
		const fake = { send: (): string => "fake" };
		container.override(MailService, fake);
		expect(container.resolve<MailService>(MailService).send()).toBe("fake");
	});

	it("symbol token (Symbol.for): override resolves to the value", () => {
		const MailToken = Symbol.for("helix-test/mail");
		container.singleton(MailToken, () => ({ kind: "real" }));
		expect(container.resolve<{ kind: string }>(MailToken).kind).toBe("real");

		container.override(MailToken, { kind: "fake" });
		expect(container.resolve<{ kind: string }>(MailToken).kind).toBe("fake");
	});

	it("unique Symbol(): rejected at registration", () => {
		const unique = Symbol("not-interned");
		expect(() => container.override(unique, "v")).toThrow(/Symbol\.for/);
	});

	it("restore(token) removes a single override", () => {
		container.singleton("a", () => "real-a");
		container.singleton("b", () => "real-b");
		container.override("a", "fake-a");
		container.override("b", "fake-b");

		container.restore("a");
		expect(container.resolve("a")).toBe("real-a");
		expect(container.resolve("b")).toBe("fake-b");
	});

	it("restore() with no args removes ALL overrides", () => {
		container.singleton("a", () => "real-a");
		container.singleton("b", () => "real-b");
		container.override("a", "fake-a");
		container.override("b", "fake-b");

		container.restore();
		expect(container.resolve("a")).toBe("real-a");
		expect(container.resolve("b")).toBe("real-b");
	});
});

describe("helix.override — facade auto-restore", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	it("override() throws when no active container is bound", async () => {
		clearActiveContainer();
		await withTestContext(async () => {
			expect(() => override("any", "value")).toThrow(/no active container/);
		});
	});

	it("override() registers cleanup on the active container", async () => {
		const container = new Container();
		container.singleton("svc", () => "real");
		useContainer(container);

		await withTestContext(async () => {
			override("svc", "fake");
			expect(container.resolve("svc")).toBe("fake");
		});

		// withTestContext drained the cleanup queue → original is back.
		expect(container.resolve("svc")).toBe("real");
	});

	it("overrideOn() targets a specific container instance", async () => {
		const c1 = new Container();
		const c2 = new Container();
		c1.singleton("svc", () => "c1-real");
		c2.singleton("svc", () => "c2-real");

		await withTestContext(async () => {
			overrideOn(c1, "svc", "c1-fake");
			expect(c1.resolve("svc")).toBe("c1-fake");
			expect(c2.resolve("svc")).toBe("c2-real");
		});

		expect(c1.resolve("svc")).toBe("c1-real");
		expect(c2.resolve("svc")).toBe("c2-real");
	});

	it("auto-restore unwinds in reverse insertion order", async () => {
		const container = new Container();
		const restoreOrder: string[] = [];
		// Spy on restore so we observe the cleanup order without a custom
		// container subclass.
		const realRestore = container.restore.bind(container);
		container.restore = ((token?: unknown) => {
			restoreOrder.push(String(token));
			return realRestore(token as never);
		}) as typeof container.restore;
		container.singleton("a", () => "real-a");
		container.singleton("b", () => "real-b");
		useContainer(container);

		await withTestContext(async () => {
			override("a", "fake-a");
			override("b", "fake-b");
		});

		expect(restoreOrder).toEqual(["b", "a"]);
	});

	it("override() outside a test frame throws (M1)", () => {
		const container = new Container();
		container.singleton("svc", () => "real");
		useContainer(container);
		// No `withTestContext` wrapping — direct call.
		expect(() => override("svc", "fake")).toThrow(
			/must be called inside a test/,
		);
	});

	it("useContainer auto-restores the previous active container at frame end (M3)", async () => {
		const c1 = new Container();
		const c2 = new Container();
		c1.singleton("svc", () => "c1-real");
		c2.singleton("svc", () => "c2-real");
		useContainer(c1);

		await withTestContext(async () => {
			useContainer(c2);
			// Inside the frame, override resolves on c2.
			override("svc", "c2-fake");
			expect(c2.resolve("svc")).toBe("c2-fake");
		});

		// Frame closed → activeContainer is back to c1, c2's override drained.
		expect(c2.resolve("svc")).toBe("c2-real");
		// Re-issue override on the (now-active) c1 to prove c1 survived.
		await withTestContext(async () => {
			override("svc", "c1-fake");
			expect(c1.resolve("svc")).toBe("c1-fake");
		});
		expect(c1.resolve("svc")).toBe("c1-real");
	});

	it("async cleanup is awaited before the frame returns (M4)", async () => {
		const container = new Container();
		container.singleton("svc", () => "real");
		useContainer(container);
		// Custom token whose restore is async — proves the cleanup queue
		// awaits each step rather than fire-and-forget.
		const restoreLog: string[] = [];
		const realRestore = container.restore.bind(container);
		container.restore = (async (token?: unknown) => {
			await new Promise((r) => setTimeout(r, 5));
			restoreLog.push(String(token));
			return realRestore(token as never);
		}) as unknown as typeof container.restore;

		await withTestContext(async () => {
			override("svc", "fake");
		});

		// If the cleanup wasn't awaited, restoreLog would still be empty.
		expect(restoreLog).toEqual(["svc"]);
	});
});
