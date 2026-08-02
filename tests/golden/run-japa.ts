/**
 * Golden harness — the `@japa/runner` side.
 *
 * Runs one spec file under the REAL Japa runner with a reporter that writes the
 * normalized event journal to stdout, one `__GOLDEN__<json>` line per event.
 * `tests/golden/golden.test.ts` runs the helix side through
 * {@link file://./run-helix.ts} and asserts the two journals match.
 *
 *     node --import tsx tests/golden/run-japa.ts <absolute-spec-path>
 */

import { pathToFileURL } from "node:url";
import { configure, processCLIArgs, run } from "@japa/runner";
import type { Emitter, Runner } from "@japa/runner/core";
import { emitGolden } from "./journal.js";

const file = process.argv[2];
if (file === undefined) {
	throw new Error("run-japa: expected a spec file path as the first argument");
}

// Everything after the spec path is a filter flag (`--tags=…`, `--match-all`,
// …), handed to Japa's own CLI parser.
processCLIArgs(process.argv.slice(3));
configure({
	// The callback form takes URLs; the string form is a glob resolved against
	// `cwd`, which would mangle an absolute path.
	files: () => [pathToFileURL(file)],
	reporters: {
		activated: ["golden"],
		list: [
			{
				name: "golden",
				handler: (_runner: Runner, emitter: Emitter) => {
					emitter.on("runner:start", () => emitGolden({ e: "runner:start" }));
					emitter.on("runner:end", (p) =>
						emitGolden({ e: "runner:end", hasError: p.hasError }),
					);
					emitter.on("suite:start", (p) =>
						emitGolden({ e: "suite:start", name: p.name }),
					);
					emitter.on("suite:end", (p) =>
						emitGolden({
							e: "suite:end",
							name: p.name,
							hasError: p.hasError,
						}),
					);
					emitter.on("group:start", (p) =>
						emitGolden({ e: "group:start", title: p.title }),
					);
					emitter.on("group:end", (p) =>
						emitGolden({
							e: "group:end",
							title: p.title,
							hasError: p.hasError,
						}),
					);
					emitter.on("test:start", (p) =>
						emitGolden({
							e: "test:start",
							title: p.title.expanded,
							original: p.title.original,
							tags: p.tags,
							isSkipped: p.isSkipped === true,
							isTodo: p.isTodo === true,
							datasetIndex: p.dataset?.index,
						}),
					);
					emitter.on("test:end", (p) =>
						emitGolden({
							e: "test:end",
							title: p.title.expanded,
							hasError: p.hasError,
							isSkipped: p.isSkipped === true,
							isTodo: p.isTodo === true,
							retryAttempt: p.retryAttempt,
							errorPhases: p.errors.map((entry) => entry.phase),
						}),
					);
				},
			},
		],
	},
});

await run();
