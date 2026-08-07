/**
 * `japa-alias.mjs` registers the resolve hook on import and exposes the switch
 * that turns it back off — `node:module.register()` has no counterpart, so a
 * host running several times in one process needs one.
 */
export declare function setJapaAlias(enabled: boolean): void;
