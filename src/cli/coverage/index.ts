/**
 * Coverage facade — wires collect → filter → aggregate → reporters →
 * thresholds. Called by `run.ts` after the worker pool finishes.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { aggregate } from "./aggregate.js";
import { collect } from "./collect.js";
import { filter } from "./filter.js";
import { jsonSummary } from "./reporters/json.js";
import { lcov } from "./reporters/lcov.js";
import { textSummary } from "./reporters/text.js";
import { enforce } from "./thresholds.js";
import type {
	CoverageOptions,
	CoverageSummary,
	ThresholdViolation,
} from "./types.js";

export { textSummary } from "./reporters/text.js";
export { enforce, violationSummary } from "./thresholds.js";
export type {
	CoverageOptions,
	CoverageSummary,
	ThresholdViolation,
} from "./types.js";

export interface CoverageSession {
	/** Temp dir passed as `NODE_V8_COVERAGE` to every worker. */
	envDir: string;
	/** Inject into the child environment. */
	env: NodeJS.ProcessEnv;
}

/**
 * Create a unique temp directory for a run. The orchestrator passes its
 * path via `NODE_V8_COVERAGE`; every spawned worker writes its own
 * `coverage-*.json` on exit. Returns an env bag the pool forwards.
 */
export async function openSession(baseDir?: string): Promise<CoverageSession> {
	const root = baseDir ?? path.join(process.cwd(), ".helix-coverage");
	const unique = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const envDir = path.join(root, unique);
	await mkdir(envDir, { recursive: true });
	return {
		envDir,
		env: {
			NODE_V8_COVERAGE: envDir,
		},
	};
}

export interface FinaliseOptions extends CoverageOptions {
	root: string;
	session: CoverageSession;
}

export interface FinaliseResult {
	summary: CoverageSummary;
	violations: ThresholdViolation[];
	textReport: string;
	/** Absolute paths of written report files (lcov + json-summary). */
	reportFiles: string[];
}

const KNOWN_REPORTERS = new Set(["text-summary", "lcov", "json-summary"]);

/**
 * After all workers have exited, read the raw v8 output, aggregate, emit
 * reporters + enforce thresholds.
 *
 * The temp dir is removed in `finally` so a write/aggregate failure
 * doesn't leak gigabytes of raw V8 JSON under `.helix-coverage/`.
 */
export async function finalise(opts: FinaliseOptions): Promise<FinaliseResult> {
	try {
		const raw = await collect(opts.session.envDir);
		const filtered = filter(raw, {
			root: opts.root,
			include: opts.include,
			exclude: opts.exclude,
		});
		const summary = aggregate(filtered);

		// Treat empty array as "use defaults" — same as undefined.
		const requested =
			opts.reporters && opts.reporters.length > 0
				? opts.reporters
				: ["text-summary", "lcov"];
		// Warn on unknown reporter names so typos surface (instead of the
		// reporter silently being skipped).
		for (const r of requested) {
			if (!KNOWN_REPORTERS.has(r)) {
				process.stderr.write(
					`helix-coverage: unknown reporter "${r}" — known: ${[...KNOWN_REPORTERS].join(", ")}\n`,
				);
			}
		}
		const outputDir = opts.outputDir ?? path.join(opts.root, "coverage");
		await mkdir(outputDir, { recursive: true });

		const reportFiles: string[] = [];
		if (requested.includes("lcov")) {
			const file = path.join(outputDir, "lcov.info");
			await writeFile(file, lcov(summary, opts.root), "utf8");
			reportFiles.push(file);
		}
		if (requested.includes("json-summary")) {
			const file = path.join(outputDir, "coverage-summary.json");
			await writeFile(file, jsonSummary(summary, opts.root), "utf8");
			reportFiles.push(file);
		}

		const textReport = requested.includes("text-summary")
			? textSummary(summary, opts.root)
			: "";

		const violations = opts.thresholds ? enforce(summary, opts.thresholds) : [];

		return { summary, violations, textReport, reportFiles };
	} finally {
		// Always tidy the temp dir — even on aggregate / writeFile failure.
		await rm(opts.session.envDir, { recursive: true, force: true });
	}
}
