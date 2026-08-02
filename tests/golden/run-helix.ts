/**
 * Golden harness — the helix side.
 *
 * Runs one spec file through helix's own worker and writes the same normalized
 * journal as {@link file://./run-japa.ts}, by subscribing to helix's emitter.
 *
 *     node --import tsx tests/golden/run-helix.ts <absolute-spec-path>
 */

import { emitter } from "../../src/runtime/emitter.js";
import { runTestFile } from "../../src/runtime/worker.js";
import { emitGolden } from "./journal.js";

const file = process.argv[2];
if (file === undefined) {
	throw new Error("run-helix: expected a spec file path as the first argument");
}

// The remaining argv entries are Japa-style filter flags, applied verbatim on
// both sides. Helix reads its filters from the environment (the CLI forwards
// them there so they survive either orchestrator), so translate them here.
for (const arg of process.argv.slice(3)) {
	if (arg === "--match-all") process.env.HELIX_MATCH_ALL = "1";
	else if (arg.startsWith("--tags=")) process.env.HELIX_TAGS = arg.slice(7);
	else if (arg.startsWith("--tests=")) process.env.HELIX_TESTS = arg.slice(8);
	else if (arg.startsWith("--groups=")) process.env.HELIX_GROUPS = arg.slice(9);
	else throw new Error(`run-helix: unsupported filter flag "${arg}"`);
}

emitter.on("runner:start", () => emitGolden({ e: "runner:start" }));
emitter.on("runner:end", (p) =>
	emitGolden({ e: "runner:end", hasError: p.hasError }),
);
emitter.on("suite:start", (p) =>
	emitGolden({ e: "suite:start", name: p.name }),
);
emitter.on("suite:end", (p) =>
	emitGolden({ e: "suite:end", name: p.name, hasError: p.hasError }),
);
emitter.on("group:start", (p) =>
	emitGolden({ e: "group:start", title: p.title }),
);
emitter.on("group:end", (p) =>
	emitGolden({ e: "group:end", title: p.title, hasError: p.hasError }),
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

await runTestFile(file);
