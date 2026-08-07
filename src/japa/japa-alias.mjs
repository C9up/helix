/**
 * Point `@japa/runner/core` at helix's shim, so an official Japa plugin
 * instruments helix instead of a Japa that is not running.
 *
 * A plugin does not talk to the runner through an interface — it imports the
 * classes and mutates them. Nothing helix does at runtime can change what that
 * import already resolved to; module resolution can, which is what this is.
 *
 * `--import` only IMPORTS a module, so the hook has to be REGISTERED rather
 * than merely exported — that is why this file and `japa-alias-hooks.mjs` are
 * separate.
 *
 *     node --import @c9up/helix/japa-alias …
 *
 * Registered once per process and switched with {@link setJapaAlias}, because
 * `register()` has no counterpart: a host running several times in one process
 * must be able to turn it back off.
 */

import { register } from "node:module";

/** One byte the hook thread reads on every resolution. Starts ON. */
const flag = new Int32Array(new SharedArrayBuffer(4));
Atomics.store(flag, 0, 1);

register("./japa-alias-hooks.mjs", import.meta.url, {
	data: { flag: flag.buffer },
});

/**
 * Turn the alias on or off for the rest of this process. A worker never calls
 * it — it is spawned for one run and the alias stays on; the parent turns it
 * off once it has finished importing the bootstrap.
 */
export function setJapaAlias(enabled) {
	Atomics.store(flag, 0, enabled ? 1 : 0);
}
