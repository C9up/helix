/**
 * Orchestrator entry point — the TS equivalent of `ream-test-napi::run`.
 *
 * Discovers test files (or uses the explicit list), spawns the worker
 * pool, collects framed results, aggregates into a `Summary`, and invokes
 * the reporter at each milestone. When coverage is enabled, also threads
 * the V8 coverage lifecycle (open session → forward `NODE_V8_COVERAGE`
 * env to workers → aggregate after pool drain → write reports → enforce
 * thresholds).
 *
 * Designed so the future NAPI binding can be plugged in as a drop-in
 * replacement: both sides accept the same `RunConfig` shape and return
 * the same `Summary`.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type DiffOptions,
	type DiffSummary,
	diffViolationSummary,
	finaliseDiff,
} from "./coverage/diff/index.js";
import {
	type CoverageOptions,
	type CoverageSession,
	type CoverageSummary,
	finalise as finaliseCoverage,
	openSession,
	type ThresholdViolation,
	violationSummary,
} from "./coverage/index.js";
import { type DiscoveryOptions, discover } from "./discover.js";
import { getNative } from "./native.js";
import { runPool } from "./pool.js";
import { makeReporter, type Reporter } from "./reporter.js";
import {
	buildSummary,
	exitCode,
	type Summary,
	type Totals,
} from "./summary.js";
import { runWatch } from "./watch/loop.js";
import type { WatchOptions } from "./watch/types.js";

export type { WatchOptions } from "./watch/types.js";

const DEFAULT_WATCH_DEBOUNCE_MS = 200;
const DEFAULT_WATCH_INCLUDE = [
	"src/**/*.{ts,tsx,js,mjs,cjs}",
	"tests/**/*.{ts,tsx,js,mjs,cjs}",
	"test/**/*.{ts,tsx,js,mjs,cjs}",
];
const DEFAULT_WATCH_EXCLUDE = [
	"node_modules/**",
	"dist/**",
	"build/**",
	"coverage/**",
	".helix-coverage/**",
	".git/**",
	".wolf/**",
	"target/**",
	".next/**",
];

export interface RunConfig {
	/** Absolute root directory to discover from. */
	root: string;
	/** Explicit files to run. When non-empty, discovery is skipped. */
	files?: string[];
	/** Discovery options (suffixes, excludes). */
	discovery?: DiscoveryOptions;
	/** Number of concurrent workers. Default: os.cpus().length. */
	threads?: number;
	/** Per-file timeout (ms). Default 60 000. */
	timeoutMs?: number;
	/** Reporter name: `"dot" | "spec" | "json"`. Default `"spec"`. */
	reporter?: string;
	/** Enable ANSI colours. Default: stdout is TTY. */
	useColors?: boolean;
	/** Pluggable reporter instance (overrides `reporter` when provided). */
	reporterInstance?: Reporter;
	/** Override the node binary. Default: `process.execPath`. */
	nodeBin?: string;
	/** Extra args for node (before the worker entry). */
	nodeArgs?: string[];
	/** Override the worker entry path (defaults to bundled `cli-worker.ts`). */
	workerEntry?: string;
	/** Coverage collection + reporting. Defaults to `{ enabled: false }`. */
	coverage?: CoverageOptions;
	/** Diff coverage vs a base ref. Requires `coverage.enabled === true`. */
	diffCoverage?: DiffOptions;
	/** Watch mode: re-run on file changes. */
	watch?: WatchOptions;
}

export interface RunOutcome {
	summary: Summary;
	coverage?: CoverageSummary;
	coverageViolations?: ThresholdViolation[];
	diffCoverage?: DiffSummary;
	diffCoverageViolations?: ThresholdViolation[];
	exitCode: number;
}

function defaultWorkerEntry(): string {
	// Resolve relative to THIS module's directory so it works whether we run
	// from `src/cli/run.ts` (dev: src sibling is `.ts`) or from the compiled
	// `dist/cli/run.js` (publish: sibling is `.js`). Hardcoding `.ts` made
	// the spawned worker open a non-existent `dist/runtime/cli-worker.ts`
	// when consumed via the dist tarball, dying silently before the pool's
	// frame handler could observe anything.
	const here = path.dirname(fileURLToPath(import.meta.url));
	const compiled = path.resolve(here, "../runtime/cli-worker.js");
	if (existsSync(compiled)) return compiled;
	return path.resolve(here, "../runtime/cli-worker.ts");
}

/**
 * Plain-path execution via the native `ream-test-napi` engine: it discovers
 * (skipped here — we pass the resolved `files`), spawns the worker pool, drives
 * the reporter, and returns aggregated totals. Per-file detail is carried in
 * `payload.json` (same shape as `Summary`) for callers that need it; the CLI
 * only consumes `exitCode`, and the Rust reporter already streamed per-file
 * output, so the reconstructed `Summary` keeps the detail arrays empty.
 */
async function runNative(
	config: RunConfig,
	root: string,
	files: string[],
): Promise<RunOutcome> {
	const { run: nativeRun } = getNative();
	const payload = await nativeRun({
		root,
		files,
		threads: config.threads,
		timeoutMs: config.timeoutMs,
		reporter: config.reporter,
		workerEntry: config.workerEntry ?? defaultWorkerEntry(),
		nodeBin: config.nodeBin ?? process.execPath,
		nodeArgs: config.nodeArgs,
		useColors: config.useColors ?? process.stdout.isTTY === true,
	});
	const totals: Totals = {
		pass: payload.pass,
		fail: payload.fail,
		skip: payload.skip,
		todo: payload.todo,
		fileErrors: payload.fileErrors,
	};
	const summary: Summary = {
		totals,
		files: [],
		fileErrors: [],
		durationMs: payload.durationMs,
	};
	return { summary, exitCode: payload.exitCode };
}

export async function run(config: RunConfig): Promise<RunOutcome> {
	if (!config.watch?.enabled) return runOnce(config);
	const root = path.isAbsolute(config.root)
		? config.root
		: path.resolve(config.root);
	const debounceMs = config.watch.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
	// When the user has configured custom coverage globs, mirror them in
	// the watcher so the two surfaces agree on "files I care about".
	// Otherwise fall back to the watch defaults (which intentionally
	// include `tests/**` even though coverage doesn't, so editing a test
	// triggers a re-run).
	const include =
		config.watch.include ?? config.coverage?.include ?? DEFAULT_WATCH_INCLUDE;
	const exclude = [
		...(config.watch.exclude ??
			config.coverage?.exclude ??
			DEFAULT_WATCH_EXCLUDE),
	];
	return runWatch(
		{
			root,
			include,
			exclude,
			debounceMs,
			signal: config.watch.signal,
		},
		() => runOnce(config),
	);
}

/** Aggregated coverage + diff-coverage results threaded back into `RunOutcome`. */
interface CoverageOutcome {
	coverage?: CoverageSummary;
	coverageViolations?: ThresholdViolation[];
	diffCoverage?: DiffSummary;
	diffCoverageViolations?: ThresholdViolation[];
	// Tracks unrecoverable diff-cov failures so the run still exits non-zero
	// when diff-cov was supposed to gate the PR (otherwise a thrown error
	// in finaliseDiff would silently downgrade exit to the full-tree code).
	diffCoverageFailed: boolean;
}

/** Resolve the explicit file list, or discover, warning when nothing matches. */
async function resolveRunFiles(
	config: RunConfig,
	root: string,
): Promise<string[]> {
	const files =
		config.files && config.files.length > 0
			? config.files.map((f) => (path.isAbsolute(f) ? f : path.resolve(f)))
			: await discover(root, config.discovery);

	if (files.length === 0) {
		process.stderr.write(
			`helix: no test files found under ${root} — check your include/exclude patterns.\n`,
		);
	}
	return files;
}

/**
 * Refuse mis-configured diff coverage up front (before spawning workers) so the
 * user fixes the config rather than getting a silent no-op or 0% diff coverage.
 */
function assertDiffCoverageConfig(config: RunConfig, root: string): void {
	if (!config.diffCoverage?.enabled) return;

	// Diff-cov requires the full-tree coverage to be enabled — it has nothing
	// to overlay otherwise.
	if (config.coverage?.enabled !== true) {
		throw new Error(
			"diffCoverage.enabled requires coverage.enabled — diff-cov has nothing to overlay otherwise.",
		);
	}

	// Diff-cov spawns git in `diffCoverage.cwd` (defaulting to `coverage.root`).
	// The two paths must share a common ancestry — either coverage.root is
	// under diffCoverage.cwd (common monorepo case: `cwd` = git root,
	// `root` = a sub-package), or diffCoverage.cwd is under coverage.root
	// (legacy single-repo case). When they're fully disjoint, every diff
	// entry resolves to a path the coverage summary never indexes →
	// silent 0% diff coverage. Refuse only that case.
	if (!config.diffCoverage.cwd) return;
	const covRoot = path.resolve(config.coverage?.root ?? root);
	const diffCwd = path.resolve(config.diffCoverage.cwd);
	const covUnderDiff = path.relative(diffCwd, covRoot);
	const diffUnderCov = path.relative(covRoot, diffCwd);
	const covDescendantOfDiff =
		covUnderDiff !== "" &&
		!covUnderDiff.startsWith("..") &&
		!path.isAbsolute(covUnderDiff);
	const diffDescendantOfCov =
		diffUnderCov !== "" &&
		!diffUnderCov.startsWith("..") &&
		!path.isAbsolute(diffUnderCov);
	const equal = covUnderDiff === "";
	if (!equal && !covDescendantOfDiff && !diffDescendantOfCov) {
		throw new Error(
			`diffCoverage.cwd (${diffCwd}) and coverage.root (${covRoot}) are disjoint paths; diff entries would never overlay coverage.`,
		);
	}
}

/**
 * Finalise full-tree coverage, then overlay diff coverage on top. Each stage is
 * isolated: a failed coverage finalise (disk full, permissions) or a thrown
 * diff-cov is surfaced to stderr without crashing the run, but a diff-cov
 * failure still flips `diffCoverageFailed` so the CI gate stays red.
 */
async function finaliseCoverageOutcome(
	config: RunConfig & { coverage: CoverageOptions },
	root: string,
	session: CoverageSession,
): Promise<CoverageOutcome> {
	const out: CoverageOutcome = { diffCoverageFailed: false };
	try {
		const finalised = await finaliseCoverage({
			root: config.coverage.root ?? root,
			session,
			enabled: true,
			include: config.coverage.include,
			exclude: config.coverage.exclude,
			reporters: config.coverage.reporters,
			outputDir: config.coverage.outputDir,
			thresholds: config.coverage.thresholds,
		});
		out.coverage = finalised.summary;
		out.coverageViolations = finalised.violations;
		if (finalised.textReport) process.stdout.write(finalised.textReport);
		if (finalised.violations.length > 0) {
			process.stderr.write(`${violationSummary(finalised.violations)}\n`);
		}

		// Diff coverage runs AFTER full-tree finalise, using its summary.
		if (config.diffCoverage?.enabled && out.coverage) {
			await overlayDiffCoverage(config, root, out.coverage, out);
		}
	} catch (err) {
		// Coverage finalisation failed (disk full, permission, etc.) — the test
		// summary already printed; surface the failure but don't crash the whole
		// run with a stack trace.
		process.stderr.write(
			`helix-coverage: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		out.coverageViolations = [];
	}
	return out;
}

/** Overlay diff coverage onto an already-finalised full-tree summary. */
async function overlayDiffCoverage(
	config: RunConfig & { coverage: CoverageOptions },
	root: string,
	coverage: CoverageSummary,
	out: CoverageOutcome,
): Promise<void> {
	if (!config.diffCoverage?.enabled) return;
	try {
		const diff = await finaliseDiff({
			enabled: true,
			root: config.coverage.root ?? root,
			coverage,
			base: config.diffCoverage.base,
			thresholds: config.diffCoverage.thresholds,
			outputDir: config.diffCoverage.outputDir ?? config.coverage.outputDir,
			cwd: config.diffCoverage.cwd,
		});
		if (diff.warning) {
			process.stderr.write(`${diff.warning}\n`);
			return;
		}
		out.diffCoverage = diff.summary;
		out.diffCoverageViolations = diff.violations;
		if (diff.textReport) process.stdout.write(diff.textReport);
		if (diff.violations.length > 0) {
			process.stderr.write(`${diffViolationSummary(diff.violations)}\n`);
		}
	} catch (err) {
		process.stderr.write(
			`helix-diff-cov: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		// Don't let a thrown finaliseDiff masquerade as a clean run — the user
		// explicitly opted into diff-cov and a CI gate around it must still fail.
		out.diffCoverageFailed = true;
	}
}

async function runOnce(config: RunConfig): Promise<RunOutcome> {
	const started = Date.now();
	const root = path.isAbsolute(config.root)
		? config.root
		: path.resolve(config.root);

	const files = await resolveRunFiles(config, root);

	// Cutover: the Rust NAPI engine owns the plain discovery + worker-pool +
	// reporter + summary path (42-N-orchestrator). Delegate unless a TS-only
	// layer is active — a pluggable reporter instance, coverage, or diff-cov,
	// none of which the Rust `run` exposes yet. Watch is already unwrapped by
	// `run()` above, so it never reaches here.
	if (
		!config.reporterInstance &&
		config.coverage?.enabled !== true &&
		config.diffCoverage?.enabled !== true
	) {
		return runNative(config, root, files);
	}

	const reporter =
		config.reporterInstance ??
		makeReporter(
			config.reporter,
			config.useColors ?? process.stdout.isTTY === true,
		);

	const threads = config.threads ?? os.cpus().length;

	assertDiffCoverageConfig(config, root);

	// Open a coverage session BEFORE spawning workers so `NODE_V8_COVERAGE`
	// is set in their env. The pool forwards `extraEnv` to every spawn.
	const coverageEnabled = config.coverage?.enabled === true;
	const session = coverageEnabled ? await openSession() : undefined;

	try {
		const { results, errors } = await runPool(
			files,
			{
				workerEntry: config.workerEntry ?? defaultWorkerEntry(),
				nodeBin: config.nodeBin,
				nodeArgs: config.nodeArgs,
				threads,
				timeoutMs: config.timeoutMs,
				extraEnv: session?.env,
			},
			reporter,
		);

		const summary = buildSummary(results, errors, Date.now() - started);
		reporter.onSummary(summary);

		const cov: CoverageOutcome =
			session && config.coverage
				? await finaliseCoverageOutcome(
						{ ...config, coverage: config.coverage },
						root,
						session,
					)
				: { diffCoverageFailed: false };

		const baseExit = exitCode(summary);
		const coverageExit =
			cov.coverageViolations && cov.coverageViolations.length > 0 ? 1 : 0;
		const diffCoverageExit =
			(cov.diffCoverageViolations && cov.diffCoverageViolations.length > 0) ||
			cov.diffCoverageFailed
				? 1
				: 0;
		return {
			summary,
			coverage: cov.coverage,
			coverageViolations: cov.coverageViolations,
			diffCoverage: cov.diffCoverage,
			diffCoverageViolations: cov.diffCoverageViolations,
			exitCode: Math.max(baseExit, coverageExit, diffCoverageExit),
		};
	} finally {
		// Belt-and-braces: if `runPool` itself rejected before
		// `finaliseCoverage` ran (which normally cleans the temp dir), we
		// still remove the session dir here so failed runs don't leak under
		// `.helix-coverage/`.
		if (session) {
			await rm(session.envDir, { recursive: true, force: true }).catch(
				() => {},
			);
		}
	}
}
