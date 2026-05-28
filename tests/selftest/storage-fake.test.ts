/**
 * Self-test: `helix.storage.fake` end-to-end through the helix
 * runtime. Helix is agnostic — no `@c9up/archive` import.
 */

import {
	afterEach,
	clearActiveContainer,
	describe,
	expect,
	storage,
	test,
	useContainer,
} from "@c9up/helix";
import { Container } from "@c9up/ream";

class StubFakeStorage {
	store = new Map<string, string>();
	async put(filePath: string, content: unknown): Promise<unknown> {
		this.store.set(filePath, String(content));
		return undefined;
	}
	getStored(): unknown[] {
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

describe("helix.storage.fake — end-to-end", () => {
	afterEach(() => clearActiveContainer());

	test("fake + assertStored works under the helix runtime", async () => {
		const c = new Container();
		c.singleton("storage", () => ({ real: true }));
		useContainer(c);
		const f = storage.fake(StubFakeStorage);
		await f.put("uploads/a.txt", "alpha");
		storage.assertStored("uploads/a.txt");
		expect(storage.getStored()).toHaveLength(1);
	});
});

describe("helix.storage — auto-clear between tests", () => {
	test("test A registers a fake and never clears it", () => {
		const c = new Container();
		c.singleton("storage", () => ({ real: true }));
		useContainer(c);
		storage.fake(StubFakeStorage);
		expect(storage.current()).not.toBeNull();
	});

	test("test B sees no active fake (auto-cleared after test A)", () => {
		expect(storage.current()).toBeNull();
	});
});
