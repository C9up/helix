/**
 * `@c9up/helix` — the framework-agnostic test runtime for the Ream ecosystem.
 *
 * This barrel exposes the Vitest-compatible runtime (describe/test/expect/vi/
 * spies/lifecycle), the container facade, and time-travel — none of which import
 * an ecosystem package. It is fully agnostic: usable in any project.
 *
 * Capabilities ship as PLUGINS (the Japa/AdonisJS topology): each package's
 * `/testing` subpath exports plugins that extend the injected test context via
 * `configure({ plugins: [...] })` — `@c9up/ream/testing` (apiClient → `client`,
 * FakeBus), `@c9up/atlas/testing` (factory, useTransaction, db), `@c9up/rover/
 * testing` (FakeMail), `@c9up/bay/testing` (FakeQueue), `@c9up/spectrum/testing`
 * (FakeLogger), `@c9up/nova/testing` (FakeNova), `@c9up/relay/testing`
 * (FakeRelay), `@c9up/archive/testing` (FakeStorage). The plugins depend on
 * helix, never the other way round — the core stays agnostic.
 */

export * from "./container/index.js";
export type {
	Assert,
	Assertion,
	AsymmetricMatcher,
	CleanupFn,
	ConfigureOptions,
	DatasetHandle,
	DatasetSource,
	DoneFn,
	ExpectStatic,
	FileResult,
	Group,
	GroupInstance,
	Hook,
	HookFn,
	HookType,
	MatcherName,
	MatcherResult,
	Plugin,
	PluginApi,
	PluginContext,
	RunnerHook,
	Spy,
	SuiteResult,
	TapHandle,
	TapOptions,
	TestContext,
	TestHandle,
	TestInstance,
	TestOptions,
	TestResult,
	Vi,
} from "./runtime/index.js";
export {
	AssertionError,
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	buildTestContext,
	configure,
	createAssert,
	describe,
	drainRunnerTeardowns,
	expect,
	it,
	onTestFailed,
	onTestFinished,
	Test,
	TestContextRegistry,
	test,
	vi,
} from "./runtime/index.js";
export * as time from "./time/index.js";
