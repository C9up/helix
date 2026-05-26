/**
 * Integration tests for `helix.fixture` (Story 42.8).
 *
 * Most cases use a local stub `FactoryBuilder` so we don't need a
 * real Atlas DB. One block uses a fake `db` object that records
 * `execute()` calls — enough to prove the `useTransactional`
 * savepoint/rollback cycle without the Rust ream-db binary.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clear,
	create,
	createMany,
	currentDatabase,
	define,
	make,
	makeStubbed,
	names,
	useDatabase,
	useTransactional,
} from "../../src/fixtures/Fixture.js";
import { withTestContext } from "../../src/runtime/test-context.js";

// Stub builder — duck-types Atlas's `FactoryBuilder` minimally.
function stubBuilder(initial: Record<string, unknown>) {
	const data: Record<string, unknown> = { ...initial };
	const states = new Map<string, (d: Record<string, unknown>) => void>();
	let pendingTraits: string[] = [];
	let pendingOverrides: Record<string, unknown> = {};
	const resetPending = () => {
		pendingTraits = [];
		pendingOverrides = {};
	};
	const buildData = (): Record<string, unknown> => {
		const out = { ...data, ...pendingOverrides };
		for (const t of pendingTraits) {
			const fn = states.get(t);
			if (!fn) throw new Error(`stub: state '${t}' not registered`);
			fn(out);
		}
		return out;
	};
	const builder = {
		state(name: string, fn: (d: Record<string, unknown>) => void) {
			states.set(name, fn);
			return builder;
		},
		apply(...traits: string[]) {
			pendingTraits.push(...traits);
			return builder;
		},
		merge(overrides: Record<string, unknown>) {
			pendingOverrides = { ...pendingOverrides, ...overrides };
			return builder;
		},
		make() {
			const d = buildData();
			resetPending();
			return d;
		},
		makeMany(count: number) {
			const overrides = pendingOverrides;
			const traits = pendingTraits;
			const rows: Record<string, unknown>[] = [];
			for (let i = 0; i < count; i++) {
				pendingOverrides = overrides;
				pendingTraits = traits;
				rows.push(buildData());
			}
			resetPending();
			return rows;
		},
		makeStubbed() {
			const d = buildData();
			resetPending();
			return { __stubbed: true, ...d };
		},
		async create(_db: unknown) {
			const d = buildData();
			resetPending();
			return { __persisted: true, ...d };
		},
		async createMany(count: number, _db: unknown) {
			const rows = builder.makeMany(count);
			return rows.map((r) => ({ __persisted: true, ...r }));
		},
	};
	return builder;
}

const FAKE_DB = { id: "fake-db" };

beforeEach(() => clear());
afterEach(() => clear());

describe("fixture — define + registry", () => {
	it("registers a fixture by name", () => {
		define("user", () => stubBuilder({ name: "Default" }) as never);
		expect(names()).toEqual(["user"]);
	});

	it("re-defining overwrites the previous entry", () => {
		define("user", () => stubBuilder({ tag: "v1" }) as never);
		define("user", () => stubBuilder({ tag: "v2" }) as never);
		expect(make("user")).toEqual({ tag: "v2" });
	});

	it("rejects empty / non-string names", () => {
		expect(() => define("", () => stubBuilder({}) as never)).toThrow(
			/non-empty string/,
		);
		expect(() =>
			define(undefined as unknown as string, () => stubBuilder({}) as never),
		).toThrow(/non-empty string/);
	});

	it("clear empties the registry", () => {
		define("a", () => stubBuilder({}) as never);
		define("b", () => stubBuilder({}) as never);
		clear();
		expect(names()).toEqual([]);
	});

	it("unknown name throws with the registered list", () => {
		define("user", () => stubBuilder({}) as never);
		expect(() => make("post")).toThrow(/'post' is not defined/);
		expect(() => make("post")).toThrow(/Registered: \[user\]/);
	});

	it("unknown name with empty registry mentions '(none)'", () => {
		expect(() => make("anything")).toThrow(/Registered: \[\(none\)\]/);
	});
});

describe("fixture — arg parsing", () => {
	beforeEach(() => {
		define(
			"user",
			() =>
				stubBuilder({ role: "user" })
					.state("admin", (u) => {
						u.role = "admin";
					})
					.state("withOrders", (u) => {
						u.orders = ["o1"];
					}) as never,
		);
	});

	it("strings are trait names, applied in order", () => {
		const data = make("user", "admin", "withOrders");
		expect(data).toEqual({ role: "admin", orders: ["o1"] });
	});

	it("trailing object is overrides", () => {
		const data = make("user", { name: "Alice" });
		expect(data).toEqual({ role: "user", name: "Alice" });
	});

	it("traits + overrides combine", () => {
		const data = make("user", "admin", { name: "Alice" });
		expect(data).toEqual({ role: "admin", name: "Alice" });
	});

	it("rejects object before string", () => {
		expect(() => make("user", { name: "x" }, "admin")).toThrow(
			/trait names must come BEFORE/,
		);
	});

	it("rejects multiple objects", () => {
		expect(() => make("user", { a: 1 }, { b: 2 })).toThrow(
			/only one overrides object/,
		);
	});

	it("rejects non-string non-object args", () => {
		expect(() => make("user", 42 as unknown as string)).toThrow(
			/trait-name string or overrides object/,
		);
		expect(() => make("user", null as unknown as string)).toThrow(/got null/);
	});

	it("rejects arrays (would silently coerce to numeric-key overrides)", () => {
		expect(() => make("user", ["admin"] as unknown as string)).toThrow(
			/got array/,
		);
	});
});

describe("fixture — make / makeStubbed", () => {
	beforeEach(() => {
		define(
			"user",
			() =>
				stubBuilder({ role: "user", name: "Default" }).state("admin", (u) => {
					u.role = "admin";
				}) as never,
		);
	});

	it("make returns a plain data object", () => {
		expect(make("user")).toEqual({ role: "user", name: "Default" });
	});

	it("makeStubbed returns a stubbed entity", () => {
		expect(makeStubbed("user", "admin")).toEqual({
			__stubbed: true,
			role: "admin",
			name: "Default",
		});
	});
});

describe("fixture — useDatabase + create", () => {
	beforeEach(() => {
		define("user", () => stubBuilder({ role: "user" }) as never);
	});

	it("create requires a db", async () => {
		await expect(create("user")).rejects.toThrow(/no database connection/);
	});

	it("create uses the active db set by useDatabase", async () => {
		await withTestContext(async () => {
			useDatabase(FAKE_DB);
			expect(currentDatabase()).toBe(FAKE_DB);
			const u = (await create("user")) as { __persisted: boolean };
			expect(u.__persisted).toBe(true);
		});
	});

	it("create accepts last-arg { db } override", async () => {
		const u = (await create("user", { db: FAKE_DB })) as {
			__persisted: boolean;
		};
		expect(u.__persisted).toBe(true);
	});

	it("{ db, ...overrides } extracts db AND merges remaining keys as overrides", async () => {
		// Combined form: connection override + field overrides in one
		// trailing object. `db` is always extracted — the rest stays
		// as overrides. (Tradeoff: a user-domain field literally named
		// `db` is swallowed; documented in `splitWithDb`.)
		define(
			"user",
			() =>
				stubBuilder({ role: "user" }).state("admin", (u) => {
					u.role = "admin";
				}) as never,
		);
		const u = (await create("user", "admin", {
			db: FAKE_DB,
			name: "Alice",
		})) as { __persisted: boolean; role: string; name: string };
		expect(u.__persisted).toBe(true);
		expect(u.role).toBe("admin");
		expect(u.name).toBe("Alice");
	});

	it("traits + last-arg { db } combine", async () => {
		define(
			"user",
			() =>
				stubBuilder({ role: "user" }).state("admin", (u) => {
					u.role = "admin";
				}) as never,
		);
		const u = (await create("user", "admin", { db: FAKE_DB })) as {
			role: string;
		};
		expect(u.role).toBe("admin");
	});

	it("useDatabase auto-restores previous value at frame close", async () => {
		await withTestContext(async () => {
			useDatabase(FAKE_DB);
			expect(currentDatabase()).toBe(FAKE_DB);
		});
		expect(currentDatabase()).toBeNull();
	});
});

describe("fixture — createMany", () => {
	beforeEach(() => {
		define("user", () => stubBuilder({ role: "user" }) as never);
	});

	it("rejects count < 1", async () => {
		await expect(createMany("user", 0, { db: FAKE_DB })).rejects.toThrow(
			/positive integer/,
		);
		await expect(createMany("user", -3, { db: FAKE_DB })).rejects.toThrow(
			/positive integer/,
		);
	});

	it("rejects non-integer count", async () => {
		await expect(createMany("user", 2.5, { db: FAKE_DB })).rejects.toThrow(
			/positive integer/,
		);
	});

	it("creates N rows with traits + overrides", async () => {
		define(
			"user",
			() =>
				stubBuilder({ role: "user" }).state("admin", (u) => {
					u.role = "admin";
				}) as never,
		);
		const rows = (await createMany("user", 3, "admin", {
			db: FAKE_DB,
		})) as Array<{ role: string }>;
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => r.role === "admin")).toBe(true);
	});

	it("requires a db", async () => {
		await expect(createMany("user", 2)).rejects.toThrow(
			/no database connection/,
		);
	});
});

describe("fixture — useTransactional", () => {
	it("throws outside a test frame", async () => {
		await expect(useTransactional(FAKE_DB)).rejects.toThrow(/inside a test/);
	});

	it("opens a savepoint, sets activeDb, and rolls back at frame close", async () => {
		const calls: string[] = [];
		const fakeDb = {
			execute: async (sql: string) => {
				calls.push(sql);
			},
		};

		await withTestContext(async () => {
			await useTransactional(fakeDb);
			expect(calls).toEqual(["SAVEPOINT test_savepoint"]);
			expect(currentDatabase()).toBe(fakeDb);
		});

		// After frame close: rollback + release fired in cleanup,
		// activeDb restored to its previous value (undefined → null).
		expect(calls).toEqual([
			"SAVEPOINT test_savepoint",
			"ROLLBACK TO SAVEPOINT test_savepoint",
			"RELEASE SAVEPOINT test_savepoint",
		]);
		expect(currentDatabase()).toBeNull();
	});

	it("a savepoint failure does NOT pollute activeDb (C1)", async () => {
		const failingDb = {
			execute: async () => {
				throw new Error("connection lost");
			},
		};
		await withTestContext(async () => {
			await expect(useTransactional(failingDb)).rejects.toThrow(
				/connection lost/,
			);
			expect(currentDatabase()).toBeNull();
		});
	});
});
