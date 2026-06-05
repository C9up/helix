/**
 * Public re-exports for lifecycle hooks.
 *
 * The actual registration lives in `./suite.ts` (hooks are attached to the
 * currently-active suite on the collection stack). This module exists as a
 * stable import path for reporters/plugins that want hooks without the full
 * DSL surface.
 */

export type { Hook, HookType } from "./suite.js";
export {
	addHook,
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
} from "./suite.js";
