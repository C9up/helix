/**
 * Watch-mode public types. Kept in their own file so `bin/helix.js` and
 * `run.ts` can import without pulling in the watcher implementation.
 */

export interface WatchOptions {
	enabled: boolean;
	/** Debounce window in ms — events within the window collapse to one
	 *  re-run. Default 200, range [1, 5_000]. */
	debounceMs?: number;
	/** Override the watcher's include globs. Defaults to `coverage.include`
	 *  when set, otherwise the watch defaults (`src/**`, `tests/**`,
	 *  `test/**`). */
	include?: string[];
	/** Override the watcher's exclude globs. Defaults to `coverage.exclude`
	 *  when set, otherwise the watch defaults (`node_modules/**`,
	 *  `.helix-coverage/**`, etc.). */
	exclude?: string[];
	/** Optional `AbortSignal` to drive shutdown without a real SIGINT —
	 *  primarily a test seam. */
	signal?: AbortSignal;
}
