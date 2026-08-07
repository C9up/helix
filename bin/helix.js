#!/usr/bin/env node
/**
 * `helix` CLI — argv parser + orchestrator bootstrap.
 *
 * This script is plain JS so it works without a loader. To run the TS
 * orchestrator (`src/cli/run.ts`) it either:
 *   (a) relies on Node 24+ TS support via `--experimental-transform-types`
 *       (not yet enabled by default in Node 25), OR
 *   (b) re-executes itself via `node --import <tsx-loader> bin/helix.js`
 *       when tsx is installed — making the CLI self-hoisting.
 *
 * Robustness fixes (review 2026-04-24):
 *   - `fileURLToPath(import.meta.url)` (Windows-safe) instead of URL.pathname
 *   - Argv parser requires `--flag=value` for any non-boolean flag and
 *     validates numeric inputs (NaN / negative / 0 rejected)
 *   - Argv `--` terminator skips remaining parsing
 *   - Unknown flags → hard error (no silent typo coverage)
 *   - `--watch` / `--include` / `--exclude` / `--grep` / `--only-changed`
 *     wired (some stub to orchestrator.run options, `--watch` defers to
 *     42-N-watch and prints a notice)
 *   - tsx loader resolved up-front; clear error if not found
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Known flags. Boolean flags accept `--name` with no value. */
const FLAG_SPEC = {
	reporter: { kind: "string", help: "Output format: spec|dot|json" },
	threads: { kind: "number", help: "Concurrent workers" },
	timeout: { kind: "number", help: "Per-file timeout in ms" },
	colors: { kind: "boolean", help: "Enable ANSI colours" },
	tsx: { kind: "boolean", help: "Use tsx loader for workers (default: true)" },
	include: { kind: "string[]", help: "Glob patterns to include" },
	exclude: { kind: "string[]", help: "Glob patterns to exclude" },
	grep: {
		kind: "string",
		help: "Only run tests whose full name matches (regex or substring)",
	},
	retries: { kind: "number", help: "Extra attempts on failure (default 0)" },
	tags: {
		kind: "string",
		help: "Comma-separated tag filter (@fast, ~@slow to exclude); OR by default",
	},
	"match-all": {
		kind: "boolean",
		help: "Require ALL --tags instead of any (Japa parity)",
	},
	// Japa's parser accepts both spellings (`matchAll` with `match-all` as its
	// alias), so both work here too.
	matchAll: {
		kind: "boolean",
		help: "Alias of --match-all",
	},
	tests: {
		kind: "string",
		help: "Comma-separated exact test titles to run (Japa --tests)",
	},
	groups: {
		kind: "string",
		help: "Comma-separated exact group titles to run (Japa --groups)",
	},
	suite: {
		kind: "string",
		help: "Name of the suite these files belong to (Japa meta.suite)",
	},
	files: {
		kind: "string",
		help: "Comma-separated substrings matched against test file paths (Japa --files)",
	},
	reporters: {
		kind: "string",
		help: "Comma-separated reporters to activate, e.g. spec,json (Japa --reporters)",
	},
	bail: { kind: "boolean", help: "Stop at the first failure (Japa --bail)" },
	"bail-layer": {
		kind: "string",
		help: "How far a bail reaches: group|suite|runner (Japa --bail-layer)",
	},
	failed: {
		kind: "boolean",
		help: "Re-run only the tests that failed last run (Japa --failed)",
	},
	"list-pinned": {
		kind: "boolean",
		help: "Print the tests marked .pin() and run nothing (Japa --list-pinned)",
	},
	"force-exit": {
		kind: "boolean",
		help: "process.exit() as soon as the run ends, without draining the event loop (Japa --force-exit)",
	},
	watch: { kind: "boolean", help: "Watch mode — re-run on file changes" },
	"watch-debounce": {
		kind: "number",
		help: "Debounce window in ms for watch mode (default 200, max 5000)",
	},
	"only-changed": {
		kind: "boolean",
		help: "Only run tests for changed files (deferred)",
	},
	coverage: { kind: "boolean", help: "Enable V8 coverage collection" },
	"coverage-reporters": {
		kind: "string",
		help: "Comma-separated coverage reporters: text-summary,lcov,json-summary",
	},
	"coverage-dir": { kind: "string", help: "Coverage output directory" },
	"coverage-thresholds": {
		kind: "string",
		help: 'Inline JSON thresholds, e.g. {"lines":80,"functions":75}',
	},
	"diff-cov": {
		kind: "boolean",
		help: "Enable diff coverage vs base branch (requires --coverage)",
	},
	"diff-cov-base": {
		kind: "string",
		help: "Git ref to diff against (default: origin/main, then main)",
	},
	"diff-cov-thresholds": {
		kind: "string",
		help: 'Inline JSON diff thresholds, e.g. {"lines":80}',
	},
	help: { kind: "boolean", help: "Print this help" },
};

function parseArgv(argv) {
	const positional = [];
	const flags = {};
	let terminated = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (terminated) {
			positional.push(arg);
			continue;
		}
		if (arg === "--") {
			terminated = true;
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			flags.help = true;
			continue;
		}
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const body = arg.slice(2);
		const eq = body.indexOf("=");
		const name = eq >= 0 ? body.slice(0, eq) : body;
		const inline = eq >= 0 ? body.slice(eq + 1) : undefined;
		const spec = FLAG_SPEC[name];
		if (!spec) {
			throw new Error(`unknown flag: --${name}`);
		}
		if (spec.kind === "boolean") {
			// `--flag` → true; `--flag=false`/`0`/`no` → false.
			flags[name] =
				inline === undefined ? true : !/^(false|0|no|off)$/i.test(inline);
			continue;
		}
		// string / number / string[] require an explicit non-empty `=value`.
		if (inline === undefined || inline === "") {
			throw new Error(
				`flag --${name} expects a non-empty value (use --${name}=<value>)`,
			);
		}
		if (spec.kind === "number") {
			const n = Number(inline);
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error(
					`flag --${name} expects a positive finite number, got "${inline}"`,
				);
			}
			flags[name] = n;
		} else if (spec.kind === "string[]") {
			flags[name] = [...(flags[name] ?? []), inline];
		} else {
			flags[name] = inline;
		}
	}
	return { positional, flags };
}

/**
 * Resolve a usable `tsx` ESM loader path. Tries:
 *   1. `require.resolve('tsx/package.json')` — standard npm/yarn install.
 *   2. Scan pnpm's virtual store for `tsx@*` up the directory tree.
 * Returns a `file://` URL or `undefined`.
 */
/**
 * `ERR_MODULE_NOT_FOUND` is the right re-exec trigger ONLY when the
 * missing specifier is a `.js` path whose `.ts` sibling exists on
 * disk. That signals "Node native TS strip-types loaded the parent,
 * but couldn't auto-rewrite `.js` → `.ts`" — the exact gap tsx
 * closes. Any other shape (genuine missing dep, user typo, …) should
 * surface as-is so the user sees the real error.
 */
function isMissingTsSibling(err) {
	const url = err?.url;
	if (typeof url !== "string") return false;
	if (!url.startsWith("file://")) return false;
	if (!url.endsWith(".js")) return false;
	const jsPath = fileURLToPath(url);
	const tsPath = `${jsPath.slice(0, -3)}.ts`;
	return existsSync(tsPath);
}

function findTsxLoader() {
	try {
		const req = createRequire(import.meta.url);
		const pkgJson = req.resolve("tsx/package.json");
		const loader = path.join(path.dirname(pkgJson), "dist/loader.mjs");
		if (existsSync(loader)) return pathToFileURL(loader).href;
	} catch {
		/* fall through */
	}
	let dir = process.cwd();
	while (dir !== path.dirname(dir)) {
		const store = path.join(dir, "node_modules/.pnpm");
		if (existsSync(store)) {
			try {
				const match = readdirSync(store).find((e) => e.startsWith("tsx@"));
				if (match) {
					const loader = path.join(
						store,
						match,
						"node_modules/tsx/dist/loader.mjs",
					);
					if (existsSync(loader)) return pathToFileURL(loader).href;
				}
			} catch {
				/* ignore */
			}
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

/** Trailing `.test.ts` / `.spec.js` / … stripped, so `--files=user` matches `user.test.ts`. */
const TEST_SUFFIX = /(\.(test|spec))?\.[cm]?[jt]sx?$/;

/**
 * Japa's `--files` rule: keep a file when its path ENDS WITH the filter, or
 * when every segment of the filter (read right-to-left, `*` matching anything)
 * matches the corresponding path segment of the file minus its test suffix.
 * `--files=user` keeps `tests/unit/user.test.ts`; `--files=unit/*` keeps
 * everything under a `unit` directory.
 */
function filterByFileFilters(files, raw) {
	if (raw === undefined) return files;
	const filters = String(raw)
		.split(",")
		.map((f) => f.trim())
		.filter((f) => f.length > 0);
	if (filters.length === 0) return files;
	return files.filter((file) => {
		const unix = file.split(path.sep).join("/");
		const withoutSuffix = unix.replace(TEST_SUFFIX, "");
		return filters.some((filter) => {
			if (unix.endsWith(filter)) return true;
			const filterSegments = filter.split("/").reverse();
			const fileSegments = withoutSuffix.split("/").reverse();
			return filterSegments.every(
				(segment, i) =>
					fileSegments[i] !== undefined &&
					(segment === "*" || fileSegments[i].endsWith(segment)),
			);
		});
	});
}

function printHelp() {
	const lines = [
		"helix — Vitest-compatible test runner",
		"",
		"Usage:",
		"  helix test [files...|dirs...|suites...]",
		"",
		"  Positionals name test files or directories. When every one of them",
		"  matches a suite declared in helix.config.*, they name SUITES instead",
		"  (AdonisJS `node ace test unit functional`). With no positional and a",
		"  config present, every suite runs, in order.",
		"",
		"Flags:",
	];
	for (const [name, spec] of Object.entries(FLAG_SPEC)) {
		const form = spec.kind === "boolean" ? `--${name}` : `--${name}=<v>`;
		lines.push(`  ${form.padEnd(20)} ${spec.help}`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

async function expandPositionals(positional, discover) {
	const out = [];
	for (const p of positional) {
		const abs = path.isAbsolute(p) ? p : path.resolve(p);
		if (existsSync(abs)) {
			if (statSync(abs).isDirectory()) {
				const found = await discover(abs);
				out.push(...found);
				continue;
			}
			out.push(abs);
			continue;
		}
		process.stderr.write(`helix: path not found: ${p}\n`);
	}
	return out;
}

async function main() {
	const argv = process.argv.slice(2);
	const subcommand = argv[0] ?? "test";
	if (subcommand === "-h" || subcommand === "--help") {
		printHelp();
		return 0;
	}
	if (subcommand !== "test") {
		process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
		printHelp();
		return 2;
	}

	let parsed;
	try {
		parsed = parseArgv(argv.slice(1));
	} catch (err) {
		process.stderr.write(`helix: ${err.message}\n\n`);
		printHelp();
		return 2;
	}
	if (parsed.flags.help) {
		printHelp();
		return 0;
	}

	if (parsed.flags["only-changed"]) {
		process.stderr.write(
			"helix: --only-changed is deferred; running full discovery.\n",
		);
	}
	if (parsed.flags["watch-debounce"] !== undefined && !parsed.flags.watch) {
		process.stderr.write(
			"helix: --watch-debounce has no effect without --watch.\n",
		);
	}
	if (parsed.flags["watch-debounce"] !== undefined) {
		const d = parsed.flags["watch-debounce"];
		if (d < 1 || d > 5000) {
			process.stderr.write(
				`helix: --watch-debounce must be in [1, 5000] ms, got ${d}.\n`,
			);
			return 2;
		}
	}

	// Import the TS orchestrator. Prefer the COMPILED `dist/cli/*.js`
	// when present (the published tarball ships it via `pnpm build` at
	// prepublish) so a standalone `npx helix` runs plain JS — no TS
	// loader needed for the orchestrator itself. Fall back to the
	// `src/cli/*.ts` sources in the workspace (dev) where dist isn't
	// built; that path fails with ERR_UNKNOWN_FILE_EXTENSION when no TS
	// loader is active, which triggers the tsx re-exec below.
	// Prefer SRC when it exists (= workspace dev) — the package.json `exports`
	// resolves `@c9up/helix` to src/ in the working tree (publishConfig swaps
	// to dist at publish). If we ran from dist while test files import the src
	// build, the worker's helix runtime and the test's helix runtime are two
	// DIFFERENT module instances with separate `describe`/`it` registries —
	// tests register on one side, the worker reads the other → 0 tests found.
	// Falling back to dist when src is absent covers the published-install case.
	const srcRun = path.resolve(here, "../src/cli/run.ts");
	const distRun = path.resolve(here, "../dist/cli/run.js");
	const useDist = !existsSync(srcRun) && existsSync(distRun);
	const runModule = pathToFileURL(
		useDist ? distRun : path.resolve(here, "../src/cli/run.ts"),
	).href;
	try {
		// Probe by resolving through dynamic import; Node throws synchronously.
		const { run, runSuites } = await import(runModule);
		const discoverModule = pathToFileURL(
			useDist
				? path.resolve(here, "../dist/cli/discover.js")
				: path.resolve(here, "../src/cli/discover.ts"),
		).href;
		const { discover } = await import(discoverModule);
		const suitesModule = pathToFileURL(
			useDist
				? path.resolve(here, "../dist/cli/suites.js")
				: path.resolve(here, "../src/cli/suites.ts"),
		).href;
		const {
			loadHelixConfig,
			resolveHelixConfig,
			resolveSuiteFiles,
			selectSuites,
		} = await import(suitesModule);

		// AdonisJS parity: positionals may name SUITES declared in
		// `helix.config.*` (`helix test unit`). When they don't — or there is no
		// config — they stay what they have always been: paths.
		const helixConfig = await loadHelixConfig(process.cwd());
		const selectedSuites = selectSuites(helixConfig, parsed.positional);

		// AdonisJS `tests/bootstrap.ts`: resolved once here, imported by every
		// worker before its test file. Forwarded through the env so it reaches
		// the worker under BOTH orchestrators.
		const bootstrapModule = pathToFileURL(
			useDist
				? path.resolve(here, "../dist/runtime/bootstrap.js")
				: path.resolve(here, "../src/runtime/bootstrap.ts"),
		).href;
		const { resolveBootstrap } = await import(bootstrapModule);
		const { runGlobalHooks } = await import(
			pathToFileURL(
				useDist
					? path.resolve(here, "../dist/runtime/global-hooks.js")
					: path.resolve(here, "../src/runtime/global-hooks.ts"),
			).href
		);
		process.env.HELIX_BOOTSTRAP =
			resolveBootstrap(process.cwd(), helixConfig.bootstrap) ?? "";
		// A `suites[].configure` callback lives in the config module; the worker
		// re-imports it by path, since the function itself cannot be forwarded.
		// Only named when a suite actually declares one, so a project without any
		// pays nothing.
		const declaresConfigure = (helixConfig.suites ?? []).some(
			(suite) => typeof suite.configure === "function",
		);
		process.env.HELIX_SUITE_CONFIG = declaresConfigure
			? (resolveHelixConfig(process.cwd()) ?? "")
			: "";

		const expanded = selectedSuites
			? []
			: filterByFileFilters(
					await expandPositionals(parsed.positional, discover),
					parsed.flags.files,
				);
		const tsxLoader = findTsxLoader();
		if (parsed.flags.tsx !== false && !tsxLoader) {
			process.stderr.write(
				"helix: could not resolve `tsx` loader. Install tsx as a dev dependency or pass --tsx=false.\n",
			);
			return 2;
		}

		const coverageReporters = parsed.flags["coverage-reporters"]
			? String(parsed.flags["coverage-reporters"])
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s.length > 0)
			: undefined;

		const parseInlineJson = (flag) => {
			const raw = parsed.flags[flag];
			if (!raw) return undefined;
			try {
				return JSON.parse(String(raw));
			} catch (err) {
				process.stderr.write(
					`helix: --${flag}: invalid JSON: ${err instanceof Error ? err.message : err}\n`,
				);
				throw new Error("invalid flag JSON");
			}
		};

		let coverageThresholds;
		let diffCovThresholds;
		try {
			coverageThresholds = parseInlineJson("coverage-thresholds");
			diffCovThresholds = parseInlineJson("diff-cov-thresholds");
		} catch {
			return 2;
		}

		const cfg = {
			root: process.cwd(),
			files: expanded,
			threads: parsed.flags.threads,
			timeoutMs: parsed.flags.timeout ?? helixConfig.timeout,
			reporter: parsed.flags.reporter,
			reporters: parsed.flags.reporters
				? String(parsed.flags.reporters)
						.split(",")
						.map((r) => r.trim())
						.filter((r) => r.length > 0)
				: undefined,
			bail: parsed.flags.bail === true,
			listPinned: parsed.flags["list-pinned"] === true,
			failed: parsed.flags.failed === true,
			useColors: parsed.flags.colors,
			discovery: {
				suffixes: parsed.flags.include,
				hardExcludes: parsed.flags.exclude,
			},
			nodeArgs:
				parsed.flags.tsx === false || !tsxLoader
					? undefined
					: ["--import", tsxLoader],
			coverage: parsed.flags.coverage
				? {
						enabled: true,
						reporters: coverageReporters,
						outputDir: parsed.flags["coverage-dir"],
						thresholds: coverageThresholds,
					}
				: undefined,
			diffCoverage: parsed.flags["diff-cov"]
				? {
						enabled: true,
						base: parsed.flags["diff-cov-base"],
						thresholds: diffCovThresholds,
					}
				: undefined,
			watch: parsed.flags.watch
				? {
						enabled: true,
						debounceMs: parsed.flags["watch-debounce"],
					}
				: undefined,
		};
		// Per-test runtime filters travel to workers via env so they survive
		// BOTH the TS pool and the Rust native orchestrator (child processes
		// inherit this process's env; see runtime/worker.ts).
		if (parsed.flags.grep !== undefined) {
			process.env.HELIX_GREP = String(parsed.flags.grep);
		}
		if (parsed.flags.retries !== undefined) {
			process.env.HELIX_RETRIES = String(parsed.flags.retries);
		}
		// Not used to resolve the timeout (the orchestrator carries it in the
		// run instruction) — exported so a plugin can read it off `api.cliArgs`.
		if (parsed.flags.timeout !== undefined) {
			process.env.HELIX_TIMEOUT = String(parsed.flags.timeout);
		}
		if (parsed.flags.tags !== undefined) {
			process.env.HELIX_TAGS = String(parsed.flags.tags);
		}
		if (parsed.flags["match-all"] === true || parsed.flags.matchAll === true) {
			process.env.HELIX_MATCH_ALL = "1";
		}
		if (parsed.flags.tests !== undefined) {
			process.env.HELIX_TESTS = String(parsed.flags.tests);
		}
		if (parsed.flags.groups !== undefined) {
			process.env.HELIX_GROUPS = String(parsed.flags.groups);
		}
		if (parsed.flags.suite !== undefined) {
			process.env.HELIX_SUITE = String(parsed.flags.suite);
		}
		if (parsed.flags.files !== undefined) {
			process.env.HELIX_FILES = String(parsed.flags.files);
		}
		if (parsed.flags.bail === true) {
			process.env.HELIX_BAIL = "1";
		}
		// Flags a plugin reads off `api.cliArgs` but the runtime itself doesn't
		// act on — forwarded for the same reason as the filters: Japa hands its
		// plugins the whole flag set.
		if (cfg.reporters !== undefined) {
			process.env.HELIX_REPORTERS = cfg.reporters.join(",");
		} else if (parsed.flags.reporter !== undefined) {
			process.env.HELIX_REPORTERS = String(parsed.flags.reporter);
		}
		if (parsed.flags.failed === true) {
			process.env.HELIX_FAILED = "1";
		}
		// `--force-exit`, or `forceExit` in the config (AdonisJS `tests.forceExit`).
		// Read back by `finish()` below, and by a plugin off `api.cliArgs`.
		if (parsed.flags["list-pinned"] === true) {
			process.env.HELIX_LIST_PINNED = "1";
		}
		// Positionals reach a plugin as `api.cliArgs._`, like Japa's.
		if (parsed.positional.length > 0) {
			process.env.HELIX_POSITIONALS = parsed.positional.join(",");
		}
		if (parsed.flags["force-exit"] === true || helixConfig.forceExit === true) {
			process.env.HELIX_FORCE_EXIT = "1";
		}
		if (parsed.flags["bail-layer"] !== undefined) {
			process.env.HELIX_BAIL_LAYER = String(parsed.flags["bail-layer"]);
		}
		// `--failed` replays the previous run's failures as a `--tests` filter,
		// exactly like Japa's retry plugin.
		if (parsed.flags.failed === true) {
			const failedModule = pathToFileURL(
				useDist
					? path.resolve(here, "../dist/cli/failed-cache.js")
					: path.resolve(here, "../src/cli/failed-cache.ts"),
			).href;
			const { readFailedCache } = await import(failedModule);
			const failedTests = await readFailedCache(process.cwd());
			if (failedTests.length === 0) {
				process.stdout.write(
					"helix: no failing tests cached — running all of them\n",
				);
			} else {
				process.env.HELIX_TESTS = failedTests.join(",");
			}
		}

		// `runnerHooks` run ONCE around the whole run, here, and the workers are
		// told to skip them — Japa's semantics, and the difference between
		// migrating once and migrating once per test file.
		const dropGlobalHooks = await runGlobalHooks(process.env.HELIX_BOOTSTRAP);

		if (!selectedSuites) {
			try {
				const outcome = await run(cfg);
				return outcome.exitCode;
			} finally {
				await dropGlobalHooks();
			}
		}

		// Suites run one after another (Japa runs them in sequence too), each
		// with its own files, timeout, retries and `meta.suite` name. The
		// sequence is handed to the orchestrator as a whole so watch mode
		// wraps ALL of it in one watcher and the `--failed` cache holds every
		// suite's failures.
		const steps = [];
		for (const suite of selectedSuites) {
			const suiteFiles = filterByFileFilters(
				await resolveSuiteFiles(suite, process.cwd(), cfg.discovery),
				parsed.flags.files,
			);
			if (suiteFiles.length === 0) {
				process.stderr.write(`helix: suite "${suite.name}": no test files\n`);
				continue;
			}
			// A suite's `retries` overrides `--retries` for that suite only. Set
			// on EVERY step (empty = unset, see `envCount`) so a suite that
			// declares none doesn't inherit the previous suite's value.
			const retries = suite.retries ?? parsed.flags.retries;
			const env = {
				HELIX_SUITE: suite.name,
				HELIX_RETRIES: retries === undefined ? "" : String(retries),
			};
			steps.push({
				env,
				config: {
					...cfg,
					files: suiteFiles,
					timeoutMs: cfg.timeoutMs ?? suite.timeout,
				},
			});
		}
		try {
			const outcome = await runSuites(steps, cfg);
			return outcome.exitCode;
		} finally {
			await dropGlobalHooks();
		}
	} catch (err) {
		// Re-exec under tsx when Node can't satisfy the TS-source imports
		// natively. Two failure shapes seen in the wild:
		//   - `ERR_UNKNOWN_FILE_EXTENSION` — Node refuses to load a `.ts`
		//     file at all (older Node, no strip-types).
		//   - `ERR_MODULE_NOT_FOUND` — Node loads `run.ts` natively
		//     (strip-types) but fails to follow `./foo.js` imports because
		//     only `./foo.ts` exists on disk (Node 25's native TS doesn't
		//     auto-rewrite `.js` → `.ts` like tsx does).
		//
		// `ERR_MODULE_NOT_FOUND` also fires for genuine user typos (missing
		// dep, deleted file). To distinguish, check that the missing
		// specifier is a `.js` path whose `.ts` sibling exists — only
		// then is tsx the right escalation. Also gate behind a sentinel
		// env var so the re-exec'd child can't loop.
		if (process.env.HELIX_REEXECED === "1") {
			throw err;
		}
		const isUnknownExt =
			Boolean(err) && err.code === "ERR_UNKNOWN_FILE_EXTENSION";
		const isMissingTs =
			Boolean(err) &&
			err.code === "ERR_MODULE_NOT_FOUND" &&
			isMissingTsSibling(err);
		const shouldReexec = isUnknownExt || isMissingTs;
		if (shouldReexec) {
			// Re-execute ourselves under tsx so the orchestrator TS imports resolve.
			const tsxLoader = findTsxLoader();
			if (!tsxLoader) {
				process.stderr.write(
					"helix: Node cannot import the TS orchestrator and no tsx loader was found. Install tsx as a dev dependency.\n",
				);
				return 2;
			}
			const { spawnSync } = await import("node:child_process");
			const result = spawnSync(
				process.execPath,
				["--import", tsxLoader, fileURLToPath(import.meta.url), ...argv],
				{
					stdio: "inherit",
					env: { ...process.env, HELIX_REEXECED: "1" },
				},
			);
			return result.status ?? 2;
		}
		throw err;
	}
}

/**
 * Japa semantics: the process exits on its own once the event loop drains, so a
 * resource a test left open surfaces as a hang you can diagnose — rather than
 * being swallowed by an unconditional `process.exit`, which also truncates
 * pending stdout writes. `--force-exit` is the escape hatch, exactly as in Japa.
 */
function finish(code) {
	process.exitCode = code;
	// The env var carries the config-declared `forceExit`; the argv check also
	// covers a failure that happened before the config was ever read.
	const forced =
		process.env.HELIX_FORCE_EXIT === "1" ||
		process.argv.includes("--force-exit");
	if (forced) process.exit(code);
}

main()
	.then(finish)
	.catch((err) => {
		process.stderr.write(`helix: ${err instanceof Error ? err.stack : err}\n`);
		finish(2);
	});
