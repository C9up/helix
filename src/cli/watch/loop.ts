/**
 * Watch-mode run loop: runs `runOnce` once on startup, installs the
 * watcher, and re-invokes `runOnce` whenever a coalesced change burst
 * fires. Re-runs are serialised — at most one queued follow-up while a
 * run is in flight; further bursts during that window are dropped (the
 * queued run will pick up the latest disk state).
 *
 * On SIGINT (or an aborted external `AbortSignal`), the loop closes
 * the watcher, waits for any in-flight run, and resolves with the
 * LAST `RunOutcome` (with `exitCode: 0`, since a failing run during
 * interactive watch should not poison the exit status — failures
 * already surface as test output).
 */

import type { RunOutcome } from "../run.js";
import { createWatcher, type WatcherHandle } from "./watcher.js";

export interface RunWatchOptions {
	root: string;
	include: string[];
	exclude: string[];
	debounceMs: number;
	/** Optional external abort. When triggered, behaves like SIGINT.
	 *  Lets tests drive shutdown without `process.emit("SIGINT")` (which
	 *  collides with vitest's own signal handlers). */
	signal?: AbortSignal;
}

const BANNER_WAITING = "[helix] watching for changes… (Ctrl-C to exit)";
const BANNER_RERUN = "[helix] change detected, re-running…";

function fallbackOutcome(): RunOutcome {
	return {
		summary: {
			totals: { pass: 0, fail: 0, skip: 0, todo: 0, fileErrors: 0 },
			files: [],
			fileErrors: [],
			durationMs: 0,
		},
		exitCode: 0,
	};
}

export async function runWatch(
	opts: RunWatchOptions,
	runOnce: () => Promise<RunOutcome>,
): Promise<RunOutcome> {
	// Initialise upfront so the final return never reads `undefined`,
	// even if `runOnce` throws and the catch path's fallback construction
	// itself throws (defence-in-depth against a brittle cast).
	let lastOutcome: RunOutcome = fallbackOutcome();
	let inFlight: Promise<void> | undefined;
	let queued = false;
	let closing = false;
	let watcher: WatcherHandle | undefined;
	let resolveSettled: () => void;
	const settled = new Promise<void>((resolve) => {
		resolveSettled = resolve;
	});

	function beginShutdown(): void {
		if (closing) return;
		closing = true;
		void (async () => {
			if (watcher) await watcher.close();
			if (inFlight) await inFlight;
			resolveSettled();
		})();
	}

	const onSigint = (): void => beginShutdown();
	const onAbort = (): void => beginShutdown();
	process.on("SIGINT", onSigint);
	if (opts.signal) {
		if (opts.signal.aborted) {
			closing = true;
		} else {
			opts.signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	function trigger(): void {
		if (closing) return;
		if (inFlight) {
			queued = true;
			return;
		}
		process.stdout.write(`${BANNER_RERUN}\n`);
		inFlight = (async () => {
			try {
				lastOutcome = await runOnce();
			} catch (err) {
				process.stderr.write(
					`helix-watch: run failed: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			} finally {
				inFlight = undefined;
				if (!closing) {
					process.stdout.write(`${BANNER_WAITING}\n`);
				}
				if (queued && !closing) {
					queued = false;
					trigger();
				}
			}
		})();
	}

	// Initial run — drive it through the same in-flight machinery so a
	// SIGINT/abort arriving during the first run is handled exactly like
	// one arriving during a re-run (handler awaits `inFlight`, then
	// resolves).
	inFlight = (async () => {
		try {
			lastOutcome = await runOnce();
		} catch (err) {
			process.stderr.write(
				`helix-watch: run failed: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		} finally {
			inFlight = undefined;
		}
	})();
	await inFlight;

	if (closing) {
		process.off("SIGINT", onSigint);
		opts.signal?.removeEventListener("abort", onAbort);
		return { ...lastOutcome, exitCode: 0 };
	}

	process.stdout.write(`${BANNER_WAITING}\n`);

	let watcherFatalError: Error | undefined;
	watcher = createWatcher({
		root: opts.root,
		include: opts.include,
		exclude: opts.exclude,
		debounceMs: opts.debounceMs,
		onChange: () => trigger(),
		onError: (err) => {
			watcherFatalError = err;
			beginShutdown();
		},
	});

	await settled;

	process.off("SIGINT", onSigint);
	opts.signal?.removeEventListener("abort", onAbort);

	if (watcherFatalError) {
		process.stderr.write(
			`helix-watch: watcher error — ${watcherFatalError.message}\n`,
		);
	}

	return { ...lastOutcome, exitCode: 0 };
}
