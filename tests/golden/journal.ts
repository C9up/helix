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
