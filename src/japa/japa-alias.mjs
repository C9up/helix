/**
 * Point `@japa/runner/core` at helix's shim, so an official Japa plugin
 * instruments helix instead of a Japa that is not running.
 *
 * A plugin does not talk to the runner through an interface — it imports the
 * classes and mutates them. Nothing helix does at runtime can change what that
 * import already resolved to; module resolution can, which is what this is.
 *
 * `--import` only IMPORTS a module, so the hook has to be registered rather
 * than merely exported — that is the whole reason this file and
 * `japa-alias-hooks.mjs` are separate.
 *
 *     node --import @c9up/helix/japa-alias …
 */

import { register } from "node:module";

register("./japa-alias-hooks.mjs", import.meta.url);
