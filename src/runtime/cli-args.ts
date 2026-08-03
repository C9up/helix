/**
 * The run's command-line arguments, as seen from inside a worker.
 *
 * `bin/helix.js` parses the flags in the CLI process and forwards them to every
 * worker through the environment (`HELIX_TAGS`, `HELIX_TESTS`, …), because a
 * worker is spawned by either orchestrator (Node pool or the Rust engine) with
 * a fixed instruction shape. Reading them back here is what lets both the
 * runtime and a plugin (`api.cliArgs`, Japa parity) see the same filters.
 *
 * Named deviation from Japa's `CLIArgs`: values are parsed (`string[]`,
 * `number`, `boolean`) rather than kept as raw CLI strings — they have already
 * been through the parser once, on the CLI side.
 */

/** Parsed CLI flags for the current run. */
export interface CLIArgs {
	/** Positionals — the paths or suite names typed on the command line. */
	_?: string[];
	/** `--list-pinned` — collect and print the pinned tests, run nothing. */
	listPinned?: boolean;
	/** `--tags` — `~@tag`/`!@tag` entries exclude. */
	tags?: string[];
	/** `--tests` — exact test titles. */
	tests?: string[];
	/** `--groups` — exact group titles. */
	groups?: string[];
	/** `--match-all` — require every `--tags` entry instead of any. */
	matchAll?: boolean;
	/** `--timeout`, in ms. */
	timeout?: number;
	/** `--retries` — extra attempts on failure. */
	retries?: number;
	/** `--grep` — helix extra: regex/substring over the full test name. */
	grep?: string;
	/** `--suite` — the suite name these files belong to. */
	suite?: string;
	/** `--files` — substrings matched against the test file path (Japa `--files`). */
	files?: string[];
	/** `--reporters` — the reporters activated for this run. */
	reporters?: string[];
	/** `--bail` — stop at the first failure. */
	bail?: boolean;
	/** `--bail-layer` — how far a bail reaches. */
	bailLayer?: string;
	/** `--failed` — this run replays the previous run's failures. */
	failed?: boolean;
	/** `--force-exit` — the CLI will `process.exit()` once the run ends. */
	forceExit?: boolean;
}

/** Comma-separated env list → trimmed non-empty entries, or undefined. */
export function envList(name: string): string[] | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return undefined;
	const items = raw
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	return items.length > 0 ? items : undefined;
}

/** A non-negative integer env var, or undefined when unset/invalid. */
export function envCount(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** `--tags` as forwarded by the CLI. */
export function envTags(): string[] | undefined {
	return envList("HELIX_TAGS");
}

/** `--match-all` as forwarded by the CLI. */
export function envMatchAll(): boolean | undefined {
	return process.env.HELIX_MATCH_ALL === "1" ? true : undefined;
}

/** A boolean flag as forwarded by the CLI — absent stays `undefined`, as in Japa. */
function envFlag(name: string): boolean | undefined {
	return process.env[name] === "1" ? true : undefined;
}

/**
 * The run's flags, as ONE object.
 *
 * Japa hands its plugins a `cliArgs` they may edit — that is a documented way
 * to steer a run from a plugin. Rebuilding it from the environment on every
 * access would silently drop those edits, so it is built once and every reader
 * (the plugin API, and the runtime's own filter resolution) shares it.
 */
let materialised: CLIArgs | undefined;

export function cliArgs(): CLIArgs {
	materialised ??= readCLIArgs();
	return materialised;
}

/** Test seam: rebuild from the environment on the next access. */
export function resetCLIArgs(): void {
	materialised = undefined;
}

/** Every CLI flag the current worker can see, read fresh from the environment. */
export function readCLIArgs(): CLIArgs {
	return {
		tags: envTags(),
		tests: envList("HELIX_TESTS"),
		groups: envList("HELIX_GROUPS"),
		matchAll: envMatchAll(),
		timeout: envCount("HELIX_TIMEOUT"),
		retries: envCount("HELIX_RETRIES"),
		grep: process.env.HELIX_GREP,
		suite: process.env.HELIX_SUITE,
		files: envList("HELIX_FILES"),
		reporters: envList("HELIX_REPORTERS"),
		bail: envFlag("HELIX_BAIL"),
		bailLayer: process.env.HELIX_BAIL_LAYER,
		failed: envFlag("HELIX_FAILED"),
		forceExit: envFlag("HELIX_FORCE_EXIT"),
		listPinned: envFlag("HELIX_LIST_PINNED"),
		_: envList("HELIX_POSITIONALS"),
	};
}
