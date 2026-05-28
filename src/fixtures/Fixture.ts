/**
 * `helix.fixture` — named registry + trait dispatcher on top of
 * Atlas's `factory(Entity, defaults)` builder.
 *
 *     fixture.define('user', () =>
 *       factory(User, () => ({ email: ..., name: ... }))
 *         .state('admin', (u) => { u.role = 'admin' })
 *         .state('withOrders', (u) => { u.orders = [...] })
 *     )
 *
 *     // Composition: traits as positional strings, overrides as
 *     // a single trailing object.
 *     const admin = await fixture.create('user', 'admin', { name: 'Alice' })
 *     const drafted = fixture.makeStubbed('user', 'admin')
 *
 * Only Atlas is imported (helix already depends on it via `db/`).
 * Keeps the agnostic rule applied to provider-side fakes (mail,
 * queue, logger, storage, relay) — Atlas's `factory` is a
 * data-construction primitive, not a transport.
 */

import { type FactoryBuilder, useTransaction } from "@c9up/atlas/testing";
import { inTestContext, registerTestCleanup } from "../runtime/test-context.js";

// `FactoryBuilder` is generic in the entity type but the registry
// erases that — the caller's `define(...)` callback retains the
// concrete type at the call site. `unknown` here just means
// "we don't know which entity", not "anything goes".
type AnyBuilder = FactoryBuilder<never>;
type FixtureBuilderFn = () => AnyBuilder;

const registry = new Map<string, FixtureBuilderFn>();

/**
 * Register a named fixture. Re-defining a name overwrites — useful
 * for dev-time iteration where the same `define` call may run
 * twice. Empty / non-string names throw because they would silently
 * shadow other fixtures via `Map` coercion.
 */
export function define(name: string, fn: FixtureBuilderFn): void {
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("helix.fixture.define: name must be a non-empty string.");
	}
	registry.set(name, fn);
}

/** Wipe the entire registry. Idempotent. */
export function clear(): void {
	registry.clear();
}

/** Snapshot of registered names. */
export function names(): string[] {
	return Array.from(registry.keys());
}

function resolve(name: string): AnyBuilder {
	const fn = registry.get(name);
	if (!fn) {
		const known = Array.from(registry.keys()).join(", ") || "(none)";
		throw new Error(
			`helix.fixture: '${name}' is not defined. Registered: [${known}]. Call helix.fixture.define('${name}', ...) first.`,
		);
	}
	return fn();
}

interface ParsedArgs {
	traits: string[];
	overrides: Record<string, unknown>;
}

function parseArgs(args: unknown[]): ParsedArgs {
	const traits: string[] = [];
	let overrides: Record<string, unknown> = {};
	let sawObject = false;
	for (const a of args) {
		if (typeof a === "string") {
			if (sawObject) {
				throw new Error(
					"helix.fixture: trait names must come BEFORE the overrides object.",
				);
			}
			traits.push(a);
		} else if (Array.isArray(a)) {
			// Arrays would silently coerce to `{0: ..., 1: ...}` overrides
			// otherwise — almost never what the caller meant. Reject loudly.
			throw new Error(
				"helix.fixture: argument must be a trait-name string or overrides object, got array. Pass trait names as separate positional arguments instead.",
			);
		} else if (a && typeof a === "object") {
			if (sawObject) {
				throw new Error(
					"helix.fixture: only one overrides object is allowed per call.",
				);
			}
			overrides = a as Record<string, unknown>;
			sawObject = true;
		} else {
			throw new Error(
				`helix.fixture: argument must be a trait-name string or overrides object, got ${a === null ? "null" : typeof a}.`,
			);
		}
	}
	return { traits, overrides };
}

interface ParsedArgsWithDb extends ParsedArgs {
	db: unknown | undefined;
}

/**
 * Same as `parseArgs` but extracts a `db` field from the
 * overrides bag — letting callers combine a connection override
 * with field overrides in a single trailing object:
 *
 *     fixture.create('user', 'admin', { db: myDb, name: 'Alice' })
 *
 * Tradeoff: a user-domain field literally named `db` cannot be
 * passed via overrides — it would be swallowed as the connection.
 * That collision is rare (entity columns are usually camelCase
 * domain nouns); when it happens, set the connection via
 * `useDatabase(db)` and rename the field for the override.
 */
function splitWithDb(args: unknown[]): ParsedArgsWithDb {
	const { traits, overrides } = parseArgs(args);
	if ("db" in overrides) {
		const { db, ...rest } = overrides;
		return { traits, overrides: rest, db };
	}
	return { traits, overrides, db: undefined };
}

function applyAndMerge(
	builder: AnyBuilder,
	traits: string[],
	overrides: Record<string, unknown>,
): void {
	if (traits.length) builder.apply(...traits);
	if (Object.keys(overrides).length) builder.merge(overrides);
}

/** Build a data object without persisting. */
export function make(
	name: string,
	...args: unknown[]
): Record<string, unknown> {
	const { traits, overrides } = parseArgs(args);
	const builder = resolve(name);
	applyAndMerge(builder, traits, overrides);
	return builder.make();
}

/** Build an entity instance without persisting. */
export function makeStubbed<T = unknown>(name: string, ...args: unknown[]): T {
	const { traits, overrides } = parseArgs(args);
	const builder = resolve(name);
	applyAndMerge(builder, traits, overrides);
	return builder.makeStubbed() as unknown as T;
}

let activeDb: unknown | undefined;

/**
 * Set the default DB for `create*`. If called inside a test frame,
 * the previous `activeDb` is auto-restored at frame close. Outside
 * a test frame the assignment is permanent until the next call.
 */
export function useDatabase(db: unknown): void {
	const previous = activeDb;
	activeDb = db;
	registerTestCleanup(() => {
		activeDb = previous;
	});
}

/** Return the currently active DB connection (or `null`). Test
 *  helper. */
export function currentDatabase(): unknown {
	return activeDb ?? null;
}

function requireDb(verb: string, override: unknown): unknown {
	const conn = override ?? activeDb;
	if (!conn) {
		throw new Error(
			`helix.fixture.${verb}: no database connection. Pass a \`db\` key in the trailing overrides object (e.g. \`{ db: myDb, name: 'Alice' }\`) or call helix.fixture.useDatabase(db) first.`,
		);
	}
	return conn;
}

/** Persist + return a single entity. */
export async function create<T = unknown>(
	name: string,
	...args: unknown[]
): Promise<T> {
	const { traits, overrides, db } = splitWithDb(args);
	const conn = requireDb("create", db);
	const builder = resolve(name);
	applyAndMerge(builder, traits, overrides);
	const result = await builder.create(conn as never);
	return result as unknown as T;
}

/** Same as `create` × N. */
export async function createMany<T = unknown>(
	name: string,
	count: number,
	...args: unknown[]
): Promise<T[]> {
	if (!Number.isInteger(count) || count < 1) {
		throw new Error(
			`helix.fixture.createMany: count must be a positive integer, got ${count}.`,
		);
	}
	const { traits, overrides, db } = splitWithDb(args);
	const conn = requireDb("createMany", db);
	const builder = resolve(name);
	applyAndMerge(builder, traits, overrides);
	const result = await builder.createMany(count, conn as never);
	return result as unknown as T[];
}

/**
 * Open an Atlas savepoint via `useTransaction(db)` and queue the
 * rollback as test cleanup. Sets `activeDb = db` so subsequent
 * `create()` calls hit the same connection (also auto-restored).
 *
 * Throws outside a test frame — the rollback would never fire and
 * the transaction would leak across tests.
 *
 * Order is: open savepoint FIRST (can throw on a stale connection),
 * mutate `activeDb` SECOND, register cleanup THIRD — so any throw
 * from `useTransaction` leaves no half-initialised state.
 */
export async function useTransactional(db: unknown): Promise<void> {
	if (!inTestContext()) {
		throw new Error(
			"helix.fixture.useTransactional: must be called inside a test (no active test frame). The savepoint rollback would never fire — use Atlas's useTransaction() directly with manual cleanup if that is what you want.",
		);
	}
	const rollback = await useTransaction(db as never);
	const previous = activeDb;
	activeDb = db;
	registerTestCleanup(async () => {
		try {
			await rollback();
		} finally {
			activeDb = previous;
		}
	});
}
