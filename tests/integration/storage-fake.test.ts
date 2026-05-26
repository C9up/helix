/**
 * Integration tests for `helix.storage.fake` (Story 42.7).
 *
 * Helix is agnostic — no `@c9up/archive` import. Local
 * `StubFakeStorage` proves the duck-typed contract.
 */

import { Container } from "@c9up/ream";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearActiveContainer,
	useContainer,
} from "../../src/container/override.js";
import { withTestContext } from "../../src/runtime/test-context.js";
import type { StorageFakeLike } from "../../src/storage/fake.js";
import {
	assertNotStored,
	assertStored,
	current,
	fake,
	getStored,
	reset,
} from "../../src/storage/fake.js";

interface StubObject {
	path: string;
	content: string;
}
class StubFakeStorage implements StorageFakeLike {
	store = new Map<string, string>();
	async put(filePath: string, content: unknown): Promise<unknown> {
		this.store.set(filePath, String(content));
		return undefined;
	}
	getStored(): StubObject[] {
		return Array.from(this.store, ([path, content]) => ({ path, content }));
	}
	reset(): void {
		this.store.clear();
	}
	assertStored(path: string): void {
		if (!this.store.has(path)) {
			throw new Error(`assertStored failed: ${path}`);
		}
	}
	assertNotStored(path: string): void {
		if (this.store.has(path)) {
			throw new Error(`assertNotStored failed: ${path}`);
		}
	}
}

describe("storage.fake — instance + binding", () => {
	afterEach(() => clearActiveContainer());

	it("returns a fresh instance", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeStorage, { bind: false });
			expect(f).toBeInstanceOf(StubFakeStorage);
		});
	});

	it("auto-binds to active container as 'storage'", async () => {
		const c = new Container();
		c.singleton("storage", () => ({ real: true }));
		useContainer(c);
		await withTestContext(async () => {
			const f = fake(StubFakeStorage);
			expect(c.resolve("storage")).toBe(f);
		});
	});

	it("throws outside test frame", () => {
		expect(() => fake(StubFakeStorage, { bind: false })).toThrow(
			/inside a test/,
		);
	});

	it("failed bind does NOT pollute activeFake (C1)", async () => {
		await withTestContext(async () => {
			expect(() => fake(StubFakeStorage)).toThrow(/no active container/);
			expect(current()).toBeNull();
		});
	});
});

describe("storage.fake — forwarders", () => {
	afterEach(() => clearActiveContainer());

	it("assertStored / assertNotStored / getStored forward correctly", async () => {
		await withTestContext(async () => {
			const f = fake(StubFakeStorage, { bind: false });
			await f.put("uploads/a.txt", "alpha");
			expect(() => assertStored("uploads/a.txt")).not.toThrow();
			expect(() => assertNotStored("uploads/b.txt")).not.toThrow();
			expect(() => assertStored("missing.txt")).toThrow(/assertStored failed/);
			expect(getStored()).toHaveLength(1);
		});
	});

	it("reset is idempotent", () => {
		expect(() => reset()).not.toThrow();
	});

	it("forwarders throw when no active fake", () => {
		expect(() => assertStored("a")).toThrow(/no active fake/);
		expect(() => getStored()).toThrow(/no active fake/);
	});
});

describe("storage.fake — auto-restore", () => {
	afterEach(() => clearActiveContainer());

	it("frame close clears activeFake + restores container", async () => {
		const c = new Container();
		const real = { tag: "real" };
		c.singleton("storage", () => real);
		useContainer(c);

		await withTestContext(async () => {
			const f = fake(StubFakeStorage);
			expect(current()).toBe(f);
		});

		expect(current()).toBeNull();
		expect(c.resolve("storage")).toBe(real);
	});

	it("double-fake within the same frame swaps cleanly", async () => {
		const c = new Container();
		c.singleton("storage", () => ({ real: true }));
		useContainer(c);

		await withTestContext(async () => {
			const first = fake(StubFakeStorage);
			await first.put("a.txt", "alpha");
			const second = fake(StubFakeStorage);
			expect(current()).toBe(second);
			expect(c.resolve("storage")).toBe(second);
			expect(second.getStored()).toHaveLength(0);
		});
	});
});
