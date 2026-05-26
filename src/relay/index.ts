/**
 * `@c9up/helix/relay` — facade for in-memory relay fakes
 * (DI pattern, no `@c9up/relay` import).
 *
 *   import { FakeRelay } from "@c9up/relay/testing";
 *   import { relay, useContainer } from "@c9up/helix";
 *
 *   useContainer(container);
 *   relay.fake(FakeRelay);
 *   // ...
 *   relay.assertSent("notifications", { dataMatches: (d) => ... });
 */

export type {
	RelayFakeCtor,
	RelayFakeLike,
	RelayFakeOptions,
} from "./fake.js";
export {
	assertNotSent,
	assertSent,
	current,
	fake,
	getSent,
	reset,
} from "./fake.js";
