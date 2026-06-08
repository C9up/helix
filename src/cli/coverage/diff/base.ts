/**
 * Resolve the default base ref to diff against. Tries, in order:
 *   1. `origin/main`
 *   2. `origin/master`
 *   3. local `main`
 *   4. local `master`
 *
 * Returns `undefined` if none of those exist (so the caller can warn
 * instead of failing the run). Throws when the `git` binary itself is
 * missing — the caller distinguishes "no repo / no ref" (skip
 * gracefully) from "git not installed" (configuration error).
 */

import { spawnSync } from "node:child_process";

const CANDIDATES = ["origin/main", "origin/master", "main", "master"];

export class GitMissingError extends Error {
	constructor() {
		super("git binary not found on PATH");
		this.name = "GitMissingError";
	}
}

function runGit(cwd: string, args: string[]): { ok: boolean } {
	const result = spawnSync("git", args, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const err = result.error as NodeJS.ErrnoException | undefined;
	if (err?.code === "ENOENT") throw new GitMissingError();
	return { ok: result.status === 0 };
}

function refExists(cwd: string, ref: string): boolean {
	return runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
		.ok;
}

export function resolveBaseRef(cwd: string): string | undefined {
	if (!runGit(cwd, ["rev-parse", "--git-dir"]).ok) return undefined;
	for (const cand of CANDIDATES) {
		if (refExists(cwd, cand)) return cand;
	}
	return undefined;
}
