/**
 * `@c9up/helix/nova` — facade for in-memory Web Push fakes.
 *
 * Helix is agnostic — no `@c9up/nova` import. The caller passes
 * the `FakeNova` class to `nova.fake(...)` at runtime; helix
 * duck-types its surface (`NovaFakeLike`) and orchestrates the
 * lifecycle.
 *
 *   import { FakeNova } from "@c9up/nova/testing";
 *   import { nova, useContainer } from "@c9up/helix";
 *
 *   useContainer(container);
 *   nova.fake(FakeNova);
 *   // ...
 *   nova.assertPushed({ userId: "user-A", title: "Welcome" });
 */

export type { NovaFakeCtor, NovaFakeLike, NovaFakeOptions } from "./fake.js";
export {
	assertNotPushed,
	assertPushed,
	current,
	fake,
	getPushed,
	reset,
} from "./fake.js";
