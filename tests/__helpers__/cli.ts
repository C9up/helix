import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, "../../bin/helix.js");

/** The runtime as a URL a throwaway test file can import from anywhere. */
export const runtimeUrl = pathToFileURL(
	path.resolve(here, "../../src/runtime/index.ts"),
).href;

/** A temporary project directory holding `files` (paths relative to it). */
export async function project(
	files: Readonly<Record<string, string>>,
): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "helix-cli-"));
	for (const [name, body] of Object.entries(files)) {
		const target = path.join(root, name);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, body, "utf8");
	}
	return root;
}

export interface CliRun {
	status: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Run `helix test <args>` in `cwd` the way a user does. The environment is the
 * caller's, minus anything a run of helix itself (this suite's own runner, a CI
 * job) might have left behind.
 */
export function helix(
	cwd: string,
	args: readonly string[],
	env: Readonly<Record<string, string | undefined>> = {},
): CliRun {
	const inherited: Record<string, string | undefined> = { ...process.env };
	for (const key of Object.keys(inherited)) {
		if (key.startsWith("HELIX_") || key === "CI" || key === "NODE_ENV") {
			delete inherited[key];
		}
	}
	const result = spawnSync(
		process.execPath,
		[bin, "test", "--colors=false", ...args],
		{
			cwd,
			env: { ...inherited, ...env },
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}
