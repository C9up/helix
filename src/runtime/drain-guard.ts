/**
 * Say something when a finished run cannot drain, instead of hanging silently.
 *
 * Letting the event loop drain on its own is the right default — it is what
 * makes a leaked resource visible instead of swallowed. But visible has to mean
 * SAID: without this the run prints its summary and then stops producing
 * output, which reads as a crash. Under a CI timeout it becomes a non-zero exit
 * for a run in which every test passed.
 *
 * `bin/helix.js` carries its own copy on purpose: it calls the guard from the
 * error path too, where the build may never have been imported, and an exit
 * handler that can fail to load is worse than a duplicated one.
 */

/**
 * How long to wait before deciding the loop is stuck. Long enough that a normal
 * teardown — a socket closing, a pool draining — finishes first, short enough
 * that CI does not sit on it.
 */
export const DRAIN_GRACE_MS = 2000;

/**
 * Arm the guard for a run that has just finished with `code`.
 *
 * Returns immediately. The timer is `unref`'d, so it never keeps the process
 * alive by itself: if everything closed, it never fires and nothing is printed.
 *
 * @param code  The exit code the run produced.
 * @param write Where the diagnostic goes. Defaults to stderr.
 */
export function armDrainGuard(
	code: number,
	write: (message: string) => void = (message) => {
		process.stderr.write(message);
	},
): void {
	const timer = setTimeout(() => {
		write(
			`\nhelix: the run finished (exit ${code}) but the process is still alive after ${DRAIN_GRACE_MS}ms.\n` +
				`helix: still open: ${describeOpenResources()}\n` +
				"helix: a test left something running — an open server, a timer, a database handle. Close it in a teardown hook,\n" +
				"helix: or set `forceExit: true` in the tests config (or pass --force-exit) to exit anyway.\n",
		);
		process.exit(code);
	}, DRAIN_GRACE_MS);
	timer.unref();
}

/** What Node still has open, counted by kind. */
function describeOpenResources(): string {
	const resources =
		typeof process.getActiveResourcesInfo === "function"
			? process.getActiveResourcesInfo()
			: [];
	const counted = new Map<string, number>();
	for (const name of resources) {
		counted.set(name, (counted.get(name) ?? 0) + 1);
	}
	if (counted.size === 0) return "nothing Node can name";
	return [...counted]
		.map(([name, n]) => (n > 1 ? `${name} x${n}` : name))
		.join(", ");
}
