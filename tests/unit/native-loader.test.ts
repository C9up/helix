/**
 * Where the native engine comes from, and what helix says when it is not there.
 *
 * A checkout builds `index.<suffix>.node` at the package root; an install gets
 * the platform package `@c9up/helix-<suffix>` as an optional dependency. The
 * loader tries the local file first and the package only when that file is
 * absent. `require` and the host are stubbed, so every case runs, and asserts,
 * on every platform.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/** The host the loader is told it runs on. */
const HOST = { platform: "linux", arch: "x64", suffix: "linux-x64-gnu" };

/** The platform package this host installs. */
const PLATFORM_PACKAGE = `@c9up/helix-${HOST.suffix}`;

/** A binary that carries every call helix makes on its engine. */
const engine = () => ({ run: async () => undefined });

/** What `require` throws for a module that is not there. */
function notFound(id: string): Error {
	return Object.assign(new Error(`Cannot find module '${id}'`), {
		code: "MODULE_NOT_FOUND",
	});
}

/** Load helix's native module with `require` running `load` for every id. */
async function withRequire(
	load: (id: string) => unknown,
	host: { platform: string; arch: string } = HOST,
) {
	vi.resetModules();
	vi.doMock("node:process", async (importOriginal) => ({
		...(await importOriginal<typeof import("node:process")>()),
		platform: host.platform,
		arch: host.arch,
	}));
	vi.doMock("node:module", async (importOriginal) => ({
		...(await importOriginal<typeof import("node:module")>()),
		createRequire: () => load,
	}));
	return {
		native: await import("../../src/cli/native.js"),
		errors: await import("../../src/errors.js"),
	};
}

/** What `getNative()` throws, or `undefined` when it returns. */
function refusalOf(native: typeof import("../../src/cli/native.js")): unknown {
	try {
		native.getNative();
		return undefined;
	} catch (error) {
		return error;
	}
}

afterEach(() => {
	vi.doUnmock("node:process");
	vi.doUnmock("node:module");
	vi.resetModules();
});

describe("helix > the engine comes from the local build or the platform package", () => {
	it("loads the platform package when no local binary is built", async () => {
		const asked: string[] = [];
		const binary = engine();
		const { native } = await withRequire((id) => {
			asked.push(id);
			if (id === PLATFORM_PACKAGE) return binary;
			throw notFound(id);
		});

		expect(native.getNative()).toBe(binary);
		expect(asked).toHaveLength(2);
		expect(asked[0]).toMatch(/[\\/]index\.linux-x64-gnu\.node$/);
		expect(asked[1]).toBe(PLATFORM_PACKAGE);
		// Loaded once, then cached: no second lookup.
		native.getNative();
		expect(asked).toHaveLength(2);
	});

	it("prefers the local build, and never asks for the package then", async () => {
		const asked: string[] = [];
		const { native } = await withRequire((id) => {
			asked.push(id);
			return engine();
		});

		native.getNative();

		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatch(/index\.linux-x64-gnu\.node$/);
	});

	it("names the platform package to install when neither is there", async () => {
		const { native, errors } = await withRequire((id) => {
			throw notFound(id);
		});

		const refusal = refusalOf(native);

		expect(refusal).toBeInstanceOf(errors.E_HELIX_NATIVE_REQUIRED);
		expect(refusal).toMatchObject({ code: "E_HELIX_NATIVE_REQUIRED" });
		expect(String(refusal)).toContain(
			`Install ${PLATFORM_PACKAGE} at the exact version of @c9up/helix`,
		);
		expect(String(refusal)).toContain("pnpm --filter @c9up/helix build:napi");
		expect(String(refusal)).toContain("On Alpine/musl");
		// The load error travels as the cause, not in the message: it names
		// paths on the host.
		expect(refusal).toMatchObject({ cause: { code: "MODULE_NOT_FOUND" } });
		expect(String(refusal)).not.toContain("Cannot find module");
	});

	it("rejects a platform package from another version", async () => {
		const { native, errors } = await withRequire((id) => {
			if (id === PLATFORM_PACKAGE) return { notRun: () => undefined };
			throw notFound(id);
		});

		const refusal = refusalOf(native);

		expect(refusal).toBeInstanceOf(errors.E_HELIX_NATIVE_REQUIRED);
		expect(String(refusal)).toContain(`Install ${PLATFORM_PACKAGE}`);
		const cause = refusal instanceof Error ? refusal.cause : undefined;
		expect(String(cause)).toContain(`${PLATFORM_PACKAGE} loaded, but`);
	});

	it("reports a local build that fails to load, instead of falling back to the package", async () => {
		const asked: string[] = [];
		const { native, errors } = await withRequire((id) => {
			asked.push(id);
			throw new Error("invalid ELF header");
		});

		const refusal = refusalOf(native);

		expect(asked).toHaveLength(1);
		expect(refusal).toBeInstanceOf(errors.E_HELIX_NATIVE_REQUIRED);
		expect(String(refusal)).toContain(
			"The @c9up/helix native engine index.linux-x64-gnu.node failed to load or is stale. Rebuild it",
		);
		expect(String(refusal)).not.toContain("invalid ELF header");
		expect(refusal).toMatchObject({ cause: { message: "invalid ELF header" } });
	});

	it("lists the supported targets on a host no binary is built for", async () => {
		const asked: string[] = [];
		const { native, errors } = await withRequire(
			(id) => {
				asked.push(id);
				return engine();
			},
			{ platform: "linux", arch: "riscv64" },
		);

		const refusal = refusalOf(native);

		expect(asked).toHaveLength(0);
		expect(refusal).toBeInstanceOf(errors.E_HELIX_NATIVE_REQUIRED);
		expect(String(refusal)).toContain(
			"@c9up/helix has no native engine for linux-riscv64; it ships one for linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.",
		);
	});
});
