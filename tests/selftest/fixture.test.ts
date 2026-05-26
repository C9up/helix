/**
 * Self-test: `helix.fixture` end-to-end through the helix runtime.
 *
 * Verifies the namespace export from the main barrel and proves
 * `useDatabase` auto-restores between tests via the per-test
 * `withTestContext` frame (sequential A/B pattern).
 */

import { describe, expect, fixture, test } from "@c9up/helix";

interface StubBuilder {
	state(name: string, fn: (d: Record<string, unknown>) => void): StubBuilder;
	apply(...names: string[]): StubBuilder;
	merge(o: Record<string, unknown>): StubBuilder;
	make(): Record<string, unknown>;
	makeMany(c: number): Record<string, unknown>[];
	makeStubbed(): unknown;
	create(db: unknown): Promise<unknown>;
	createMany(c: number, db: unknown): Promise<unknown[]>;
}

function stub(initial: Record<string, unknown>): StubBuilder {
	const data = { ...initial };
	const states = new Map<string, (d: Record<string, unknown>) => void>();
	let traits: string[] = [];
	let overrides: Record<string, unknown> = {};
	const build = () => {
		const out = { ...data, ...overrides };
		for (const t of traits) states.get(t)?.(out);
		return out;
	};
	const reset = () => {
		traits = [];
		overrides = {};
	};
	const b: StubBuilder = {
		state(n, fn) {
			states.set(n, fn);
			return b;
		},
		apply(...n) {
			traits.push(...n);
			return b;
		},
		merge(o) {
			overrides = { ...overrides, ...o };
			return b;
		},
		make() {
			const d = build();
			reset();
			return d;
		},
		makeMany(c) {
			const t = traits;
			const o = overrides;
			const rows: Record<string, unknown>[] = [];
			for (let i = 0; i < c; i++) {
				traits = t;
				overrides = o;
				rows.push(build());
			}
			reset();
			return rows;
		},
		makeStubbed() {
			const d = build();
			reset();
			return { __stubbed: true, ...d };
		},
		async create() {
			const d = build();
			reset();
			return { __persisted: true, ...d };
		},
		async createMany(c) {
			const rows = b.makeMany(c);
			return rows.map((r) => ({ __persisted: true, ...r }));
		},
	};
	return b;
}

describe("helix.fixture — end-to-end", () => {
	test("define + create work under the helix runtime", async () => {
		fixture.clear();
		fixture.define(
			"user",
			() =>
				stub({ role: "user" }).state("admin", (u) => {
					u.role = "admin";
				}) as never,
		);
		fixture.useDatabase({ id: "fake" });
		const u = (await fixture.create("user", "admin")) as {
			__persisted: boolean;
			role: string;
		};
		expect(u.__persisted).toBe(true);
		expect(u.role).toBe("admin");
		fixture.clear();
	});
});

describe("helix.fixture — auto-restore between tests", () => {
	test("test A sets useDatabase and never clears it", () => {
		fixture.useDatabase({ id: "from-A" });
		expect(fixture.currentDatabase()).toEqual({ id: "from-A" });
	});

	test("test B sees no active db (auto-cleared after test A)", () => {
		expect(fixture.currentDatabase()).toBeNull();
	});
});
