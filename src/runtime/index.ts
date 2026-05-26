/**
 * `@c9up/helix/runtime` — public surface of the Vitest-compatible test runtime.
 *
 * Test files can `import { describe, test, expect } from "@c9up/helix"` and
 * get the full DSL. The runtime is orchestrator-agnostic: a Node child
 * process, a Bun worker, or a Rust-spawned worker all load the same module.
 */

export type { AssertionErrorInit } from "./assertion-error.js";
export { AssertionError, isAssertionError } from "./assertion-error.js";
export type { EqualsOptions } from "./equals.js";
export { equals, partialEquals } from "./equals.js";
export type { Assertion } from "./expect.js";
export { expect } from "./expect.js";
export type { Hook, HookType } from "./lifecycle.js";
export {
	addHook,
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
} from "./lifecycle.js";
export type { MatcherName, MatcherResult, SpyLike } from "./matchers.js";
export { matchers } from "./matchers.js";
export type {
	FileResult,
	SerializedError,
	SuiteResult,
	TestResult,
} from "./run.js";
export { executeRoot } from "./run.js";
export type { RunMode, SuiteNode, TestFn, TestNode } from "./suite.js";
export {
	describe,
	getRoot,
	it,
	resetRoot,
	test,
} from "./suite.js";
export type { Vi } from "./vi/index.js";
export { vi, withViContext } from "./vi/index.js";
export type {
	CreateSpyOptions,
	MockCallResult,
	MockInternals,
	Spy,
} from "./vi/spy.js";
export type { SpyOnOptions } from "./vi/spyOn.js";
export type { RunFileOptions } from "./worker.js";
export { runTestFile } from "./worker.js";
