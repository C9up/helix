/**
 * The event journal both golden harnesses write.
 *
 * One `__GOLDEN__<json>` line per runner event, on stdout. Keeping the shape in
 * one module is what makes the comparison meaningful: the helix side and the
 * `@japa/runner` side serialize through the SAME function, so a difference in
 * the output is a difference in the runners, never in the harness.
 *
 * Deliberately excluded from the journal: durations, file paths and timeouts —
 * environment-dependent, not semantics.
 */

/** One normalized runner event. */
export interface GoldenEvent {
	e:
		| "runner:start"
		| "runner:end"
		| "group:start"
		| "group:end"
		| "test:start"
		| "test:end"
		| "suite:start"
		| "suite:end";
	name?: string;
	title?: string;
	original?: string;
	tags?: string[];
	isSkipped?: boolean;
	isTodo?: boolean;
	hasError?: boolean;
	retryAttempt?: number;
	datasetIndex?: number;
	errorPhases?: string[];
	/** The payload's own keys — the node's RAW shape, not a normalization of it. */
	keys?: string[];
	/** Whether `errors[].error` is an `Error` instance, as Japa types it. */
	errorsAreErrors?: boolean;
}

/**
 * The keys a payload actually carries a value under, sorted.
 *
 * Comparing this alongside the normalized fields is what turns "the two runners
 * agree on the semantics we chose to look at" into "the two runners hand a
 * reporter the same OBJECT". A key present on one side only shows up as a
 * journal diff. Keys explicitly set to `undefined` are skipped: an absent key
 * and a key holding `undefined` read the same to every consumer.
 */
export function shapeOf(node: object): string[] {
	return Object.keys(node)
		.filter((key) => Reflect.get(node, key) !== undefined)
		.sort();
}

/** Marks a journal line so harness/runner noise on stdout can be skipped. */
export const GOLDEN_PREFIX = "__GOLDEN__";

/** Write one journal line. */
export function emitGolden(event: GoldenEvent): void {
	process.stdout.write(`${GOLDEN_PREFIX}${JSON.stringify(event)}\n`);
}

/** Read a journal back out of a captured stdout stream. */
export function parseGolden(stdout: string): GoldenEvent[] {
	const events: GoldenEvent[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.startsWith(GOLDEN_PREFIX)) continue;
		const parsed: unknown = JSON.parse(line.slice(GOLDEN_PREFIX.length));
		if (isGoldenEvent(parsed)) events.push(parsed);
	}
	return events;
}

/** Narrow a parsed JSON line to a {@link GoldenEvent} without a cast. */
function isGoldenEvent(value: unknown): value is GoldenEvent {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "e") === "string"
	);
}
