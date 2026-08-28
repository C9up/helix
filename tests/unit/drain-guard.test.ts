import { describe, expect, it, vi } from "vitest";
import {
	armDrainGuard,
	DRAIN_GRACE_MS,
} from "../../src/runtime/drain-guard.js";

/**
 * A run that finishes and then never returns the prompt used to print nothing
 * at all — the summary said every test passed, and a CI timeout scored it as a
 * failure. `forceExit` is the documented way out; what was missing is the line
 * that says so.
 */
describe("helix > drain guard", () => {
	it("says what is still open, and exits with the run's code", () => {
		vi.useFakeTimers();
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);
		const written: string[] = [];

		armDrainGuard(0, (m) => written.push(m));
		expect(written).toEqual([]); // nothing said before the grace period

		vi.advanceTimersByTime(DRAIN_GRACE_MS);

		const message = written.join("");
		expect(message).toContain("the run finished (exit 0)");
		expect(message).toContain("still open:");
		// The way out has to be in the message — that is the whole point.
		expect(message).toContain("forceExit");
		expect(exit).toHaveBeenCalledWith(0);

		exit.mockRestore();
		vi.useRealTimers();
	});

	it("carries a failing run's code through", () => {
		vi.useFakeTimers();
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);
		const written: string[] = [];

		armDrainGuard(1, (m) => written.push(m));
		vi.advanceTimersByTime(DRAIN_GRACE_MS);

		expect(written.join("")).toContain("exit 1");
		expect(exit).toHaveBeenCalledWith(1);

		exit.mockRestore();
		vi.useRealTimers();
	});

	it("does not hold the process open by itself", () => {
		vi.useFakeTimers();
		const unref = vi.fn();
		const setTimeoutSpy = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation((() => ({ unref })) as never);

		armDrainGuard(0, () => {});

		// Without unref the guard would keep the loop alive for its own grace
		// period on EVERY run, including the ones that drain cleanly.
		expect(unref).toHaveBeenCalledOnce();

		setTimeoutSpy.mockRestore();
		vi.useRealTimers();
	});
});
