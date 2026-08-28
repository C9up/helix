/**
 * Runner events — the helix `Emitter` surface.
 *
 * helix's plugin/reporter topology is built on an event emitter: a plugin
 * receives `{ config, cliArgs, runner, emitter }` and subscribes to
 * `runner:start`, `suite:start`, `group:start`, `test:start`, … to observe the
 * run. Helix emits the SAME event names with the SAME node shapes
 * (`TestStartNode`, `TestEndNode`, `GroupStartNode`, …) so a helix reporter or
 * plugin can be ported without rewriting its listeners.
 *
 * One named deviation from `helix`: `suite:start` / `suite:end` carry the
 * test FILE name. Helix runs one process per file, so the file is what a
 * worker-side listener can see of a suite.
 *
 * `errors[].error` is the thrown `Error` itself, as in helix — the emitter runs
 * in the worker, where the original is still around. Only an error rebuilt from
 * an IPC frame (which can carry data only) degrades to the {@link
 * SerializedError} shape, which keeps the same `name`/`message`/`stack` fields.
 */

import type { SerializedError } from "./run.js";

/** The lifecycle phase an error was raised in (helix parity). */
export type ErrorPhase =
	| "setup"
	| "test"
	| "setup:cleanup"
	| "teardown"
	| "teardown:cleanup"
	| "test:cleanup";

/**
 * One captured failure, tagged with the phase it happened in. `error` is the
 * thrown `Error`; it degrades to {@link SerializedError} — same `name`,
 * `message` and `stack` — only for a result rebuilt from an IPC frame.
 */
export interface EmittedError {
	phase: ErrorPhase;
	error: Error | SerializedError;
}

/** A test title, before and after dataset interpolation (helix parity). */
export interface EmittedTitle {
	original: string;
	expanded: string;
}

/** The dataset row a test instance was expanded from. */
export interface EmittedDataset {
	size: number;
	index: number;
	row: unknown;
}

/**
 * Shared shape of `test:start` / `test:end` — helix's `TestOptions`, field for
 * field. Only `title`, `tags`, `timeout`, `meta` and `isPinned` always carry a
 * value; the rest appear when the corresponding modifier was used, so a
 * reporter that probes for a key sees what helix would show it.
 */
interface TestNodeBase {
	title: EmittedTitle;
	tags: string[];
	timeout: number;
	waitsForDone?: boolean;
	/** The test body, as helix hands it over. Absent on a `todo`. */
	executor?: (...args: never[]) => unknown;
	retries?: number;
	retryAttempt?: number;
	isTodo?: boolean;
	isSkipped?: boolean;
	isFailing?: boolean;
	skipReason?: string;
	failReason?: string;
	isPinned: boolean;
	meta: Record<string, unknown>;
	dataset?: EmittedDataset;
}

/** Payload of `test:start`. */
export type TestStartNode = TestNodeBase;

/** Payload of `test:end`. */
export type TestEndNode = TestNodeBase & {
	duration: number;
	hasError: boolean;
	errors: EmittedError[];
};

/** Payload of `group:start`. */
export interface GroupStartNode {
	title: string;
	meta: Record<string, unknown>;
}

/** Payload of `group:end`. */
export type GroupEndNode = GroupStartNode & {
	hasError: boolean;
	errors: EmittedError[];
};

/** Payload of `suite:start` — helix's suite is the test file. */
export interface SuiteStartNode {
	name: string;
}

/** Payload of `suite:end`. */
export type SuiteEndNode = SuiteStartNode & {
	hasError: boolean;
	errors: EmittedError[];
};

/**
 * Payload of `runner:start`. helix types this as `{}`; helix spells the same
 * "no fields" shape as an empty record so no lint suppression is needed.
 */
export type RunnerStartNode = Record<string, never>;

/** Payload of `runner:end`. */
export interface RunnerEndNode {
	hasError: boolean;
}

/** Every event the runtime emits, with its payload (helix `RunnerEvents`). */
export interface RunnerEvents {
	"test:start": TestStartNode;
	"test:end": TestEndNode;
	"group:start": GroupStartNode;
	"group:end": GroupEndNode;
	"suite:start": SuiteStartNode;
	"suite:end": SuiteEndNode;
	"runner:start": RunnerStartNode;
	"runner:end": RunnerEndNode;
}

/** A listener for one event. */
export type EventHandler<E extends keyof RunnerEvents> = (
	payload: RunnerEvents[E],
) => void;

/**
 * A registered listener. `fn` is declared as a METHOD so its parameter is
 * bivariant: a concrete `EventHandler<"test:end">` assigns to it without a
 * cast, while `emit` can still invoke it with the union payload.
 */
interface StoredListener {
	fn(payload: RunnerEvents[keyof RunnerEvents]): void;
}

/**
 * A typed event emitter over {@link RunnerEvents}. Deliberately minimal — `on`
 * / `once` / `off` / `emit`, the surface a helix reporter or plugin uses. A
 * throwing listener is reported on stderr and never fails the run.
 */
export class Emitter {
	readonly #listeners = new Map<keyof RunnerEvents, Set<StoredListener>>();

	/** Subscribe to an event. Returns `this` for chaining. */
	on<E extends keyof RunnerEvents>(event: E, handler: EventHandler<E>): this {
		const set = this.#listeners.get(event) ?? new Set<StoredListener>();
		set.add({ fn: handler });
		this.#listeners.set(event, set);
		return this;
	}

	/** Subscribe to the next occurrence of an event only. */
	once<E extends keyof RunnerEvents>(event: E, handler: EventHandler<E>): this {
		const wrapped: EventHandler<E> = (payload) => {
			this.off(event, wrapped);
			handler(payload);
		};
		return this.on(event, wrapped);
	}

	/** Remove a previously registered listener. */
	off<E extends keyof RunnerEvents>(event: E, handler: EventHandler<E>): this {
		const set = this.#listeners.get(event);
		if (set === undefined) return this;
		for (const entry of set) {
			if (entry.fn === handler) set.delete(entry);
		}
		return this;
	}

	/** Drop every listener (used between runs in the same process). */
	clear(): void {
		this.#listeners.clear();
	}

	/** Broadcast an event. Listener failures are isolated. */
	emit<E extends keyof RunnerEvents>(event: E, payload: RunnerEvents[E]): void {
		const set = this.#listeners.get(event);
		if (set === undefined) return;
		// Snapshot: a `once` listener removes itself while we iterate.
		for (const entry of [...set]) {
			try {
				entry.fn(payload);
			} catch (err) {
				console.error(`[helix] "${event}" listener failed:`, err);
			}
		}
	}
}

/**
 * The process-wide emitter. Helix runs one file per process, so a module-level
 * instance is the run's emitter — the same object plugins receive at
 * `configure()` time and the runtime emits on.
 */
export const emitter = new Emitter();
