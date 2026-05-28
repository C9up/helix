/**
 * `@c9up/helix/queue` — facade for in-memory queue-driver fakes.
 *
 * Helix is agnostic — no `@c9up/bay` import. The caller passes the
 * `FakeQueue` class to `queue.fake(...)` at runtime; helix
 * duck-types its surface (`QueueFakeLike`) and orchestrates the
 * lifecycle.
 *
 *   import { FakeQueue } from "@c9up/bay/testing";
 *   import { queue, useContainer } from "@c9up/helix";
 *
 *   useContainer(container);
 *   queue.fake(FakeQueue);
 *   // ...
 *   queue.assertPushed("send-email");
 */

export type { QueueFakeCtor, QueueFakeLike, QueueFakeOptions } from "./fake.js";
export {
	assertNotPushed,
	assertPushed,
	current,
	fake,
	getPushed,
	reset,
} from "./fake.js";
