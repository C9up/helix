/**
 * `@c9up/helix` — unified testing toolkit for the Ream ecosystem.
 *
 * Mirrors Adonis's `@japa/*` + `test_utils` layout. Sub-barrels:
 *   - `@c9up/helix/bus`     — Pulsar bus assertions (emitted events, ack chains)
 *   - `@c9up/helix/http`    — fluent HTTP TestClient with assertions + auth
 *   - `@c9up/helix/db`      — factory, useTransaction, truncateAll, in-memory SQLite
 *   - `@c9up/helix/fixture` — named registry + trait dispatcher on top of Atlas factories
 *
 * This main barrel re-exports all under a single namespace so callers
 * can do `import { http, factory, Database, fixture } from "@c9up/helix"`.
 */

export * as bus from "./bus/index.js";
export * from "./container/index.js";
export * from "./db/index.js";
export * as fixture from "./fixtures/index.js";
export * from "./http/index.js";
export * as logger from "./logger/index.js";
export * as mail from "./mail/index.js";
export * as nova from "./nova/index.js";
export * as queue from "./queue/index.js";
export * as relay from "./relay/index.js";
export type {
	Assertion,
	FileResult,
	Hook,
	HookType,
	MatcherName,
	MatcherResult,
	Spy,
	SuiteResult,
	TestResult,
	Vi,
} from "./runtime/index.js";
export {
	AssertionError,
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	test,
	vi,
} from "./runtime/index.js";
export * as storage from "./storage/index.js";
export * as time from "./time/index.js";
