/**
 * Self-test: helix lifecycle-hook parity — test hooks receive the Test instance,
 * group hooks receive the Group instance, and a cleanup returned by group.setup
 * runs in the afterAll phase with (hadError, group).
 */

import { expect, test } from "@c9up/helix";

const seen: Record<string, unknown> = {};

test.group("hook args", (group) => {
	group.each.setup((subject) => {
		// A test hook receives the running Test instance.
		seen.eachSetupTitle = subject?.title;
		// helix parity (F2): the injected context is reachable as `$test.context`
		// from within the hook — built BEFORE `beforeEach` runs.
		seen.eachSetupHasContext = subject?.context !== undefined;
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
		expect(seen.eachSetupHasContext).toBe(true);
		expect(seen.groupSetupTitle).toBe("hook args");
	});
});

// F6: `group.tap` receives the Test with a MUTABLE `options` view (helix parity)
// — assigning `options.title` renames the test.
test.group("tap options", (group) => {
	group.tap((t) => {
		if (t.options.title === "before rename") t.options.title = "after rename";
	});
	test("before rename", (ctx) => {
		// The tap renamed this test; the running instance reflects the new title.
		expect(ctx.test.title).toBe("after rename");
	});
});

test("group cleanup ran with (hadError, group) after the group finished", () => {
	expect(seen.groupCleanupTitle).toBe("hook args");
	expect(seen.groupCleanupHadError).toBe(false);
});
