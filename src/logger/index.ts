/**
 * `@c9up/helix/logger` — facade for in-memory logger fakes (DI
 * pattern, no `@c9up/spectrum` import).
 *
 *   import { FakeLogger } from "@c9up/spectrum/testing";
 *   import { logger, useContainer } from "@c9up/helix";
 *
 *   useContainer(container);
 *   logger.fake(FakeLogger);
 *   // ...
 *   logger.assertLogged("error", { containing: "boom" });
 */

export type {
	LoggerFakeCtor,
	LoggerFakeLike,
	LoggerFakeOptions,
} from "./fake.js";
export {
	assertLogged,
	assertNotLogged,
	current,
	fake,
	getLogged,
	reset,
} from "./fake.js";
