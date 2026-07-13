/**
 * Self-test: `helix.override` end-to-end through the helix runtime.
 *
 * Auto-restore is verified by two sequential tests sharing the same
 * container — the second test reads the binding and asserts the
 * override from test 1 was undone. This is the strongest signal that
 * `withViContext`'s finally drains the override queue (since each
 * helix file runs through that wrapper per `runTestFile`).
 */

import {
	afterEach,
	clearActiveContainer,
	describe,
	expect,
	override,
	overrideOn,
	spy,
	test,
	useContainer,
} from "@c9up/helix";
// Helix is framework-agnostic — its self-tests must NOT depend on @c9up/ream.
// This minimal structural container implements exactly the `HelixContainer`
// override seam (singleton / resolve / override / restore) that the runtime
// drives, so the self-test proves helix's own behaviour without a host binding.
class Container {
	readonly #bindings = new Map<unknown, () => unknown>();
	readonly #overrides = new Map<unknown, unknown>();
	singleton(token: unknown, factory: () => unknown): void {
		this.#bindings.set(token, factory);
	}
	resolve<T = unknown>(token: unknown): T {
		if (this.#overrides.has(token)) return this.#overrides.get(token) as T;
		const factory = this.#bindings.get(token);
		if (!factory) throw new Error(`Container: no binding for ${String(token)}`);
		return factory() as T;
	}
	override(token: unknown, value: unknown): void {
		this.#overrides.set(token, value);
	}
	restore(token: unknown): void {
		this.#overrides.delete(token);
	}
}

// `useContainer` auto-restores the previous active container at the end
// of each test (via the per-test `withTestContext` frame). The explicit
// `clearActiveContainer` in `afterEach` is a belt-and-braces — if a test
// throws before `useContainer` runs, or someone introduces a code path
// that bypasses the frame, the next test still starts with no leakage.
describe("helix.override — value injection", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	test("override() with a string token injects a value", () => {
		const container = new Container();
		container.singleton("svc", () => "real");
		useContainer(container);

		override("svc", "fake");
		expect(container.resolve("svc")).toBe("fake");
	});

	test("override() with a class token injects a stub instance", () => {
		class MailService {
			send(): string {
				return "real";
			}
		}
		const container = new Container();
		const fake = { send: () => "fake" };
		useContainer(container);

		override(MailService, fake);
		expect(container.resolve<MailService>(MailService).send()).toBe("fake");
	});

	test("override() with a Symbol.for token injects a value", () => {
		const Token = Symbol.for("helix-self/svc");
		const container = new Container();
		container.singleton(Token, () => ({ kind: "real" }));
		useContainer(container);

		override(Token, { kind: "fake" });
		expect(container.resolve<{ kind: string }>(Token).kind).toBe("fake");
	});
});

describe("helix.spy() — alias of vi.fn()", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	test("spy() returns a fresh mock with full Vitest API", () => {
		const fakeMail = { send: spy() };
		fakeMail.send("hi");
		fakeMail.send("there");
		expect(fakeMail.send).toHaveBeenCalledTimes(2);
		expect(fakeMail.send).toHaveBeenCalledWith("there");
	});

	test("spy + override compose for the FR69 one-liner", () => {
		const container = new Container();
		container.singleton("mail", () => ({ send: () => "real" }));
		const fakeMail = { send: spy(() => "stubbed") };
		useContainer(container);

		override("mail", fakeMail);
		const got = container.resolve<{ send: () => string }>("mail").send();
		expect(got).toBe("stubbed");
		expect(fakeMail.send).toHaveBeenCalledOnce();
	});
});

// Two sequential tests sharing the SAME container instance to prove
// auto-restore runs between tests. We use a module-scoped container
// captured by both tests.
const sharedContainer = new Container();
sharedContainer.singleton("shared", () => "real-shared");

describe("helix.override — auto-restore between tests", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	test("test A registers an override that should NOT survive", () => {
		useContainer(sharedContainer);
		override("shared", "fake-from-A");
		expect(sharedContainer.resolve("shared")).toBe("fake-from-A");
	});

	test("test B sees the original value (auto-restored after test A)", () => {
		expect(sharedContainer.resolve("shared")).toBe("real-shared");
	});
});

describe("helix.overrideOn — specific container instance", () => {
	afterEach(() => {
		clearActiveContainer();
	});

	test("overrideOn targets the explicit container, not the active one", () => {
		const c1 = new Container();
		const c2 = new Container();
		c1.singleton("svc", () => "c1-real");
		c2.singleton("svc", () => "c2-real");
		useContainer(c1);

		overrideOn(c2, "svc", "c2-fake");
		expect(c1.resolve("svc")).toBe("c1-real");
		expect(c2.resolve("svc")).toBe("c2-fake");
	});
});
