/**
 * `@c9up/helix/storage` — facade for in-memory storage fakes
 * (DI pattern, no `@c9up/archive` import).
 *
 *   import { FakeStorage } from "@c9up/archive/testing";
 *   import { storage, useContainer } from "@c9up/helix";
 *
 *   useContainer(container);
 *   storage.fake(FakeStorage);
 *   // ...
 *   storage.assertStored("uploads/avatar.png");
 */

export type {
	StorageFakeCtor,
	StorageFakeLike,
	StorageFakeOptions,
} from "./fake.js";
export {
	assertNotStored,
	assertStored,
	current,
	fake,
	getStored,
	reset,
} from "./fake.js";
