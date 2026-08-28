/**
 * Loads the native `ream-test-napi` binary built by `scripts/copy-napi.mjs`
 * and exposes the Rust orchestrator `run(config)` to the TS CLI.
 *
 * Per the orchestrator design (42-N-orchestrator), the Rust NAPI engine is the
 * canonical discovery + worker-pool + reporter + summary path; the TS `runOnce`
 * delegates to it whenever no TS-only layer (coverage / diff-cov / watch / a
 * pluggable reporter instance) is in play. There is NO JS fallback for a failed
 * load — the caller gets a typed error pointing at `build:napi`.
 *
 * Field names are camelCase: napi-rs converts the Rust struct's snake_case
 * fields automatically (`timeout_ms` → `timeoutMs`, etc.).
 */

import { createRequire } from "node:module";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";

const SUFFIX_MAP: Readonly<Record<string, string>> = {
	"linux-x64": "linux-x64-gnu",
	"linux-arm64": "linux-arm64-gnu",
	"darwin-x64": "darwin-x64",
	"darwin-arm64": "darwin-arm64",
	"win32-x64": "win32-x64-msvc",
};

function platformSuffix(): string {
	const key = `${platform}-${arch}`;
	const suffix = SUFFIX_MAP[key];
	if (typeof suffix !== "string") {
		throw new Error(
			`Unsupported platform/arch '${key}' for @c9up/helix native binary. Supported: ${Object.keys(SUFFIX_MAP).join(", ")}.`,
		);
	}
	return suffix;
}

/**
 * The Rust `RunConfig` and `SummaryPayload`, and the surface that carries
 * them.
 *
 * Derived from `../native/generated.js` — written by `pnpm build:napi-types`
 * from napi-derive's own `type-def` output — rather than mirrored here by
 * hand, where nothing would notice the Rust struct gaining, losing or
 * renaming a field. The runtime guard below still checks `run` is actually
 * there: a declaration says what the Rust promises, not what a stale binary
 * shipped.
 */
export type NativeRunConfig = import("../native/generated.js").RunConfig;
export type NativeSummaryPayload =
	import("../native/generated.js").SummaryPayload;

type NativeExports = typeof import("../native/generated.js");

function isNativeExports(value: unknown): value is NativeExports {
	if (value === null || typeof value !== "object") return false;
	return typeof Reflect.get(value, "run") === "function";
}

let cachedNative: NativeExports | undefined;

export function getNative(): NativeExports {
	if (cachedNative !== undefined) return cachedNative;

	const require = createRequire(import.meta.url);
	const here = fileURLToPath(import.meta.url);
	// `here` is `…/packages/helix/{src,dist}/cli/native.ts|js`. The `.node` lives
	// two levels up at `…/packages/helix/index.<suffix>.node`.
	const suffix = platformSuffix();
	const candidate = `../../index.${suffix}.node`;
	let loaded: unknown;
	try {
		loaded = require(candidate);
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		const muslHint = suffix.endsWith("-gnu")
			? " If you are on Alpine/musl, note the prebuilt binaries target glibc (musl is not a supported target)."
			: "";
		throw new Error(
			`@c9up/helix native binary 'index.${suffix}.node' not found or failed to load near ${here} — run 'pnpm --filter @c9up/helix build:napi' to build it.${muslHint} Cause: ${cause}`,
			{ cause: err },
		);
	}
	if (!isNativeExports(loaded)) {
		throw new Error(
			"@c9up/helix native binary loaded but missing the expected 'run' export. Rebuild with 'pnpm --filter @c9up/helix build:napi'.",
		);
	}
	cachedNative = loaded;
	return cachedNative;
}
