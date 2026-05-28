/**
 * `@c9up/helix/bus` — dual-surface bus testing barrel.
 *
 * Two coexisting surfaces:
 *
 *  1. **Real-bus observer helpers** (re-exported from
 *     `@c9up/pulsar/helix` — `collect`, `waitForEvent`, `waitForChain`,
 *     plus the legacy `(events, name, payload?)` form of
 *     `assertEmitted` / `assertNotEmitted`). Use these when the test
 *     boots the real Rust-backed PulsarBus and wants to assert on what
 *     flowed past.
 *
 *  2. **Fake-bus facade** (`fake`, `current`, `getEmitted`,
 *     `getRequests`, `reset`, plus the new `(name, predicate?)` form
 *     of `assertEmitted` / `assertNotEmitted`). Use these when the
 *     test replaces the bus entirely with `helix.bus.fake(FakeBus)`.
 *
 * **Name collision on `assertEmitted` / `assertNotEmitted`** — per the
 * ESM spec, explicit named re-exports always take priority over `export *`
 * for the same identifier (order-independent). The named re-exports from
 * `./fake.js` below therefore win for `import { assertEmitted } from
 * "@c9up/helix/bus"`, regardless of where they appear in this file.
 * The legacy arity-3 observer form remains reachable via
 * `import { assertEmitted } from "@c9up/pulsar/helix"`.
 */
export * from "@c9up/pulsar/helix";
export type {
	BusFakeCtor,
	BusFakeLike,
	BusFakeOptions,
} from "./fake.js";
export {
	assertEmitted,
	assertNotEmitted,
	current,
	fake,
	getEmitted,
	getRequests,
	reset,
} from "./fake.js";
