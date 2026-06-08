/**
 * `@c9up/helix` — the framework-agnostic test runtime for the Ream ecosystem.
 *
 * This barrel exposes the Vitest-compatible runtime (describe/test/expect/vi/
 * spies/lifecycle), the container facade, and time-travel — none of which import
 * an ecosystem package. It is fully agnostic: usable in any project.
 *
 * Per-package test fakes/helpers live in EACH package's own `/testing` subpath
 * (a package owns its test surface, not helix): `@c9up/ream/testing`
 * (TestClient, FakeBus, assertEmitted), `@c9up/atlas/testing` (factory,
 * useTransaction), `@c9up/rover/testing` (FakeMail), `@c9up/bay/testing`
 * (FakeQueue), `@c9up/spectrum/testing` (FakeLogger), `@c9up/nova/testing`
 * (FakeNova), `@c9up/relay/testing` (FakeRelay), `@c9up/archive/testing`
 * (FakeStorage). Install a package → you get its testing surface.
 */

export * from "./container/index.js";
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
export * as time from "./time/index.js";
