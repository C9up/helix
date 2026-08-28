// GENERATED FROM THE RUST — do not edit.
//
// Produced by scripts/generate-napi-types.mjs from napi-derive's type-def
// output. Editing this file by hand puts it back where it started: a
// description that can disagree with the code it describes.

export interface RunConfig {
	/** Absolute root directory to discover from. Required. */
	root: string;
	/** Explicit files to run (skips discovery if non-empty). */
	files?: string[] | undefined;
	/** Number of concurrent workers. Defaults to `num_cpus::get()`. */
	threads?: number;
	/** Per-file timeout in milliseconds. Default 60 000. */
	timeoutMs?: number;
	/** `"dot" | "spec" | "json"`. Default `"spec"`. */
	reporter?: string;
	/**
	 * Activate several reporters at once (Japa `--reporters=spec,json`).
	 * Takes precedence over `reporter` when it holds more than one name.
	 */
	reporters?: string[] | undefined;
	/** Stop the run at the first failing file (Japa `--bail`). */
	bail?: boolean;
	/**
	 * Path to the compiled worker entry (points at the JS shim that calls
	 * `runtime/worker.ts#main()`). Required — there's no sensible default
	 * from Rust's perspective.
	 */
	workerEntry: string;
	/** Optional `node` executable path. Defaults to `"node"` on `PATH`. */
	nodeBin?: string;
	/**
	 * Extra args passed to the node binary (before the worker entry). For
	 * example, `["--import", "tsx"]` to enable TS loading.
	 */
	nodeArgs?: Array<string>;
	/** ANSI colours in the Spec reporter. Default true when stdout is TTY. */
	useColors?: boolean;
}

export interface SummaryPayload {
	pass: number;
	fail: number;
	skip: number;
	todo: number;
	fileErrors: number;
	durationMs: number;
	exitCode: number;
	/** Full summary as a JSON string (clients that want detail parse this). */
	json: string;
}

export declare function run(config: RunConfig): Promise<SummaryPayload>;
