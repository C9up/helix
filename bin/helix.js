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
	grep: { kind: "string", help: "Filter tests by name (not yet implemented)" },
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

function printHelp() {
	const lines = [
		"helix — Vitest-compatible test runner",
		"",
		"Usage:",
		"  helix test [files...|dirs...]",
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
	const distRun = path.resolve(here, "../dist/cli/run.js");
	const useDist = existsSync(distRun);
	const runModule = pathToFileURL(
		useDist ? distRun : path.resolve(here, "../src/cli/run.ts"),
	).href;
	try {
		// Probe by resolving through dynamic import; Node throws synchronously.
		const { run } = await import(runModule);
		const discoverModule = pathToFileURL(
			useDist
				? path.resolve(here, "../dist/cli/discover.js")
				: path.resolve(here, "../src/cli/discover.ts"),
		).href;
		const { discover } = await import(discoverModule);

		const expanded = await expandPositionals(parsed.positional, discover);
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
			timeoutMs: parsed.flags.timeout,
			reporter: parsed.flags.reporter,
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
		const outcome = await run(cfg);
		return outcome.exitCode;
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

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		process.stderr.write(`helix: ${err instanceof Error ? err.stack : err}\n`);
		process.exit(2);
	});
