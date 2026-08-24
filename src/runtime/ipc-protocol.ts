/**
 * The tokens the pool and its workers use to frame results over stderr.
 *
 * One module because these are two halves of a PROTOCOL: the parent writes the
 * instruction, the child answers with framed lines, and both have to agree on
 * the exact strings. They used to be declared independently in `cli/pool.ts`,
 * `runtime/cli-worker.ts` and `runtime/worker.ts` — three copies of the same
 * literal across a process boundary, where a change on one side fails as a hung
 * run or a lost result rather than as a compile error.
 *
 * Imports nothing, so either side can reach it without dragging the other in.
 */

/** Prefix of every framed line a worker writes on stderr. */
export const FRAME_PREFIX = "__HELIX_RESULT__";

/**
 * The nonce a worker uses for errors it emits BEFORE receiving its instruction
 * (so before it knows the real one). The parent accepts it only for `error`
 * frames, so a fixture cannot spoof a result with it.
 */
export const PRE_HANDSHAKE_NONCE = "__helix_pre_handshake__";
