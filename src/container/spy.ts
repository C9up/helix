/**
 * `helix.spy()` — Jest-like spy factory.
 *
 * Thin alias over `vi.fn()` so the documented one-liner from FR69 /
 * Story 42.3 reads:
 *
 *   const fakeMail = { send: spy() };
 *   override('mail', fakeMail);
 *   // ...
 *   expect(fakeMail.send).toHaveBeenCalledOnce();
 */

import { vi } from "../runtime/vi/index.js";
import type { AnyFn, Spy } from "../runtime/vi/spy.js";

/**
 * Wrap (don't bind) `vi.fn` so `spy` always reaches through to the
 * current `vi.fn` even if it gets replaced at runtime — and so the
 * captured reference can never go stale relative to the live `vi`
 * object. The cost over `export const spy = vi.fn` is one extra
 * function call per spawn.
 */
export function spy<Fn extends AnyFn>(implementation?: Fn): Spy<Fn> {
	return vi.fn(implementation);
}
