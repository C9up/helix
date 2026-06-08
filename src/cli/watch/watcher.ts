/**
 * Recursive file watcher for `helix test --watch`. Wraps Node's
 * `fs.watch(root, { recursive: true })` with a glob filter (reusing the
 * coverage glob translator) and a single-timer debounce that coalesces
 * burst events into one `onChange` call.
 *
 * The shape (`createWatcher` returning a `{ close }` handle) is the
 * abstraction a future Rust `notify`-NAPI implementation slots into
 * without touching the loop.
 */

import { type FSWatcher, watch as fsWatch, realpathSync } from "node:fs";
import path from "node:path";
import { compileGlobs, matchesAnyGlob } from "../coverage/glob.js";

export interface CreateWatcherOptions {
	root: string;
	include: string[];
	exclude: string[];
	debounceMs: number;
	onChange: (paths: Set<string>) => void;
	/** Surfaces `FSWatcher` errors (recursive unsupported, EMFILE, etc.)
	 *  so the loop can stop instead of waiting forever on a dead handle. */
	onError?: (err: Error) => void;
}

export interface WatcherHandle {
	close(): Promise<void>;
}

const DEBOUNCE_MIN = 1;
const DEBOUNCE_MAX = 5_000;

function tryRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

export function createWatcher(opts: CreateWatcherOptions): WatcherHandle {
	if (
		opts.debounceMs < DEBOUNCE_MIN ||
		opts.debounceMs > DEBOUNCE_MAX ||
		!Number.isFinite(opts.debounceMs)
	) {
		throw new Error(
			`createWatcher: debounceMs must be in [${DEBOUNCE_MIN}, ${DEBOUNCE_MAX}], got ${opts.debounceMs}`,
		);
	}
	if (opts.include.length === 0) {
		throw new Error(
			"createWatcher: include must be non-empty (an empty include matches nothing — silent watcher).",
		);
	}

	const include = compileGlobs(opts.include);
	const exclude = compileGlobs(opts.exclude);
	// Realpath the root so events delivered with the canonical path
	// (macOS `/tmp` → `/private/tmp`, Docker bind-mounts, pnpm worktree
	// symlinks) don't get filtered out as "outside root". Mirrors what
	// `coverage/filter.ts` does for the same reason.
	const root = tryRealpath(path.resolve(opts.root));

	const pending = new Set<string>();
	let timer: NodeJS.Timeout | undefined;
	let closed = false;

	function flush(): void {
		timer = undefined;
		if (closed) return;
		if (pending.size === 0) return;
		const batch = new Set(pending);
		pending.clear();
		opts.onChange(batch);
	}

	function arm(): void {
		if (timer) clearTimeout(timer);
		timer = setTimeout(flush, opts.debounceMs);
	}

	function shouldNotify(filename: string | null): string | undefined {
		if (!filename) return undefined;
		const abs = path.resolve(root, filename);
		const rel = path.relative(root, abs).split(path.sep).join("/");
		if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
			return undefined;
		}
		if (matchesAnyGlob(exclude, rel)) return undefined;
		if (!matchesAnyGlob(include, rel)) return undefined;
		return abs;
	}

	let watcher: FSWatcher;
	try {
		watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
			if (closed) return;
			const abs = shouldNotify(typeof filename === "string" ? filename : null);
			if (!abs) return;
			pending.add(abs);
			arm();
		});
	} catch (err) {
		throw new Error(
			`createWatcher: fs.watch failed on ${root}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	// On `'error'`, surface the failure to the caller and shut down so
	// the loop doesn't sit on a dead handle. Without this, recursive
	// watch failures on Linux<20 leave the user staring at a "watching…"
	// banner that will never tick.
	watcher.on("error", (err) => {
		if (closed) return;
		closed = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		try {
			watcher.close();
		} catch {
			/* already torn down */
		}
		opts.onError?.(err instanceof Error ? err : new Error(String(err)));
	});

	return {
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			pending.clear();
			watcher.close();
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
	};
}
