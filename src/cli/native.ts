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

import {
	hasFunctions,
	loadNativeBinary,
	supportedTargets,
} from "../vendor/nativeBinary.js";

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

const NATIVE_CALLS = ["run"] as const;

type NativeExports = Pick<
	typeof import("../native/generated.js"),
	(typeof NATIVE_CALLS)[number]
>;

function isNativeExports(value: unknown): value is NativeExports {
	return hasFunctions(value, NATIVE_CALLS);
}

let cachedNative: NativeExports | undefined;

export function getNative(): NativeExports {
	if (cachedNative !== undefined) return cachedNative;

	// The resolution and the export check are shared; the refusals below stay
	// this package's own.
	const attempt = loadNativeBinary(isNativeExports, NATIVE_CALLS);
	if (attempt.loaded) {
		cachedNative = attempt.binary;
		return cachedNative;
	}
	const { suffix, cause } = attempt;
	if (suffix === undefined) {
		throw new Error(
			`No native binary for this platform for @c9up/helix native binary. Supported: ${supportedTargets().join(", ")}.`,
		);
	}
	const causeMessage = cause instanceof Error ? cause.message : String(cause);
	const muslHint = suffix.endsWith("-gnu")
		? " If you are on Alpine/musl, note the prebuilt binaries target glibc (musl is not a supported target)."
		: "";
	throw new Error(
		`@c9up/helix native binary 'index.${suffix}.node' not found, failed to load, or is stale — run 'pnpm --filter @c9up/helix build:napi' to build it.${muslHint} Cause: ${causeMessage}`,
		{ cause },
	);
}
