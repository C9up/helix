/**
 * Self-test: Japa lifecycle-hook parity — test hooks receive the Test instance,
 * group hooks receive the Group instance, and a cleanup returned by group.setup
 * runs in the afterAll phase with (hadError, group).
 */

import { expect, test } from "@c9up/helix";

const seen: Record<string, unknown> = {};

test.group("hook args", (group) => {
	group.each.setup((subject) => {
		// A test hook receives the running Test instance.
		seen.eachSetupTitle = subject?.title;
	});
	group.setup((subject) => {
		// A group hook receives the Group instance...
		seen.groupSetupTitle = subject?.title;
		// ...and a returned function is a group cleanup: (hadError, group).
		return (hadError, g) => {
			seen.groupCleanupHadError = hadError;
			seen.groupCleanupTitle = g?.title;
		};
	});

	test("a grouped test", () => {
		expect(seen.eachSetupTitle).toBe("a grouped test");
		expect(seen.groupSetupTitle).toBe("hook args");
	});
});

test("group cleanup ran with (hadError, group) after the group finished", () => {
	expect(seen.groupCleanupTitle).toBe("hook args");
	expect(seen.groupCleanupHadError).toBe(false);
});
