/**
 * Loads the native `ream-test-napi` binary and exposes the Rust orchestrator
 * `run(config)` to the TS CLI.
 *
 * The binary is the one `scripts/copy-napi.mjs` builds at the package root in
 * a checkout, or else the platform package `@c9up/helix-<suffix>` an install
 * put beside `@c9up/helix` as an optional dependency.
 *
 * Per the orchestrator design (42-N-orchestrator), the Rust NAPI engine is the
 * canonical discovery + worker-pool + reporter + summary path; the TS `runOnce`
 * delegates to it whenever no TS-only layer (coverage / diff-cov / watch / a
 * pluggable reporter instance) is in play. There is NO JS fallback for a failed
 * load — the caller gets `E_HELIX_NATIVE_REQUIRED`, naming the platform
 * package to install (or the build to run, in a checkout). The TS pool, which
 * the TS-only layers use, never loads the binary.
 *
 * Field names are camelCase: napi-rs converts the Rust struct's snake_case
 * fields automatically (`timeout_ms` → `timeoutMs`, etc.).
 */

import { arch, platform } from "node:process";
import type { Exception } from "@c9up/flare";
import { E_HELIX_INTERNAL, E_HELIX_NATIVE_REQUIRED } from "../errors.js";
import {
	hasFunctions,
	loadNativeBinary,
	muslHint,
	supportedTargets,
} from "../vendor/nativeBinary.js";

/**
 * The npm name the platform packages derive from: `@c9up/helix-<suffix>`,
 * one per target, each an optional dependency pinned to this version.
 */
const PACKAGE_NAME = "@c9up/helix";

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
	const attempt = loadNativeBinary(isNativeExports, NATIVE_CALLS, {
		packageName: PACKAGE_NAME,
	});
	if (attempt.loaded) {
		cachedNative = attempt.binary;
		return cachedNative;
	}
	throw new E_HELIX_NATIVE_REQUIRED(
		[remedy(attempt.suffix, attempt.platformPackage)],
		{ cause: attempt.cause },
	);
}

/**
 * What to do about a missing engine, phrased for whoever has to fix it.
 *
 * An application installs the platform package; a checkout of helix builds
 * the local binary. The load error itself is not in here: it names paths on
 * the host, so it travels as the refusal's `cause` instead of its message.
 */
function remedy(
	suffix: string | undefined,
	platformPackage: string | undefined,
): string {
	if (suffix === undefined) {
		return `${PACKAGE_NAME} has no native engine for ${platform}-${arch}; it ships one for ${supportedTargets().join(", ")}.`;
	}
	if (platformPackage === undefined) {
		return (
			`The ${PACKAGE_NAME} native engine index.${suffix}.node failed to load or is stale. ` +
			"Rebuild it: pnpm --filter @c9up/helix build:napi"
		);
	}
	return (
		`The ${PACKAGE_NAME} native engine is not loaded. ` +
		`Install ${platformPackage} at the exact version of ${PACKAGE_NAME}: it is the optional dependency that carries the ${suffix} binary, ` +
		"and an install that omits optional dependencies skips it. " +
		`In a checkout of helix, build it instead: pnpm --filter @c9up/helix build:napi.${muslHint()}`
	);
}

/**
 * The prefix the engine leads its refusals with. Its only refusals are
 * invariants the TypeScript side keeps (it resolves `root`, it hands over the
 * file list), so every one is `E_HELIX_INTERNAL`: reaching it is a bug in
 * helix.
 */
const ENGINE_PREFIX = `${E_HELIX_INTERNAL.code}: `;

/**
 * The engine's `E_HELIX_INTERNAL: message` rejection, back as helix's
 * `errors.E_HELIX_INTERNAL`, with the native error as its `cause`. The engine
 * cannot throw a JavaScript class across NAPI, so it prefixes the code onto
 * the message and this puts it back. A rejection without the prefix is still
 * a failure of helix's own engine, and keeps its message whole.
 */
export function fromEngine(error: unknown): Exception {
	const message = error instanceof Error ? error.message : String(error);
	const reason = message.startsWith(ENGINE_PREFIX)
		? message.slice(ENGINE_PREFIX.length)
		: message;
	return new E_HELIX_INTERNAL([reason], { cause: error });
}
