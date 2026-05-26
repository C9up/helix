/**
 * Integration tests for `helix.logger.fake` (Story 42.7).
 *
 * Helix is agnostic — no `@c9up/spectrum` import. Local
 * `StubFakeLogger` proves the duck-typed `LoggerFakeLike`
 * contract is sufficient.
 */

import { Container } from "@c9up/ream";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearActiveContainer,
	useContainer,
} from "../../src/container/override.js";
import type { LoggerFakeLike } from "../../src/logger/fake.js";
import {
	assertLogged,
	assertNotLogged,
	current,
	fake,
	getLogged,
	reset,
} from "../../src/logger/fake.js";
import { withTestContext } from "../../src/runtime/test-context.js";

interface StubEntry {
	level: string;
	message: string;
}
class StubFakeLogger implements LoggerFakeLike {
	captured: StubEntry[] = [];
	write(entry: unknown): void {
		this.captured.push(entry as StubEntry);
	}
	getLogged(): StubEntry[] {
		return this.captured.slice();
	}
	reset(): void {
		this.captured = [];
	}
	assertLogged(level: string): void {
		if (!this.captured.some((e) => e.level === level)) {
			throw new Error(`assertLogged failed: ${level}`);
		}
	}
	assertNotLogged(level: string): void {
		if (this.captured.some((e) => e.level === level)) {
			throw new Error(`assertNotLogged failed: ${level}`);
		}
	}
}

describe("logger.fake — instance + binding", () => {
	afterEach(() => clearActiveContainer());

	it("returns a fresh instance", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeLogger, { bind: false });
			expect(f).toBeInstanceOf(StubFakeLogger);
		});
	});

	it("auto-binds to active container as 'logger'", async () => {
		const c = new Container();
		c.singleton("logger", () => ({ real: true }));
		useContainer(c);
		await withTestContext(async () => {
			const f = fake(StubFakeLogger);
			expect(c.resolve("logger")).toBe(f);
		});
		expect((c.resolve("logger") as { real?: boolean }).real).toBe(true);
	});

	it("throws outside test frame", () => {
		expect(() => fake(StubFakeLogger, { bind: false })).toThrow(
			/inside a test/,
		);
	});

	it("failed bind does NOT pollute activeFake (C1)", async () => {
		await withTestContext(async () => {
			expect(() => fake(StubFakeLogger)).toThrow(/no active container/);
			expect(current()).toBeNull();
		});
		expect(current()).toBeNull();
	});
});

describe("logger.fake — forwarders", () => {
	afterEach(() => clearActiveContainer());

	it("assertLogged / assertNotLogged forward correctly", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeLogger, { bind: false });
			f.write({ level: "error", message: "boom" });
			expect(() => assertLogged("error")).not.toThrow();
			expect(() => assertNotLogged("info")).not.toThrow();
			expect(() => assertLogged("info")).toThrow(/assertLogged failed/);
		});
	});

	it("getLogged returns the captured array", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeLogger, { bind: false });
			f.write({ level: "info", message: "a" });
			expect(getLogged()).toHaveLength(1);
		});
	});

	it("reset is idempotent (no-op when no active fake)", () => {
		expect(() => reset()).not.toThrow();
	});

	it("forwarders throw when no active fake", () => {
		expect(() => assertLogged("info")).toThrow(/no active fake/);
		expect(() => getLogged()).toThrow(/no active fake/);
	});
});

describe("logger.fake — auto-restore", () => {
	afterEach(() => clearActiveContainer());

	it("frame close clears activeFake AND restores container", async () => {
		const c = new Container();
		const real = { tag: "real" };
		c.singleton("logger", () => real);
		useContainer(c);

		await withTestContext(async () => {
			const f = fake(StubFakeLogger);
			expect(current()).toBe(f);
		});

		expect(current()).toBeNull();
		expect(c.resolve("logger")).toBe(real);
	});

	it("double-fake within the same frame swaps cleanly", async () => {
		const c = new Container();
		c.singleton("logger", () => ({ real: true }));
		useContainer(c);

		await withTestContext(async () => {
			const first = fake(StubFakeLogger);
			first.write({ level: "info", message: "first" });
			const second = fake(StubFakeLogger);
			expect(current()).toBe(second);
			expect(c.resolve("logger")).toBe(second);
			expect(second.getLogged()).toHaveLength(0);
		});
	});
});
