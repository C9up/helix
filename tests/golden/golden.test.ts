/**
 * Golden tests — helix run against the REAL `@japa/runner`.
 *
 * Every spec under `specs/helix/` has a byte-identical twin under `specs/japa/`
 * (only the runner import differs). Each pair is executed by its own runner,
 * both harnesses write the same normalized event journal (see `journal.ts`),
 * and the journals must match event for event.
 *
 * This is what the parity claim rests on: not "helix behaves like we think Japa
 * does", but "helix emits what Japa emits, for the same source". It covers the
 * lifecycle order, outcomes (pass/fail/skip/todo), dataset expansion + title
 * interpolation, retries, resource macros with `t.cleanup`, group identity, and
 * the whole `--tags`/`--match-all`/`--tests`/`--groups` filter matrix.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { type GoldenEvent, parseGolden } from "./journal.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");

/** Spec pairs, by base name. */
const SPECS = [
	"lifecycle",
	"outcomes",
	"dataset",
	"retries",
	"macros",
	"group_identity",
	"filters",
	"bail",
] as const;

/** Filter flags exercised against `filters.spec.ts`, passed to BOTH runners. */
const FILTER_MATRIX: string[][] = [
	[],
	["--tags=@slow"],
	["--tags=@slow,@db"],
	["--tags=@slow,@db", "--match-all"],
	["--tags=~@slow"],
	["--tags=!@slow"],
	["--tests=plain alpha test"],
	["--groups=alpha"],
	["--groups=alpha", "--tags=@db"],
	["--groups=beta", "--tags=@db"],
];

/** `--bail` / `--bail-layer` combinations exercised against `bail.spec.ts`. */
const BAIL_MATRIX: string[][] = [
	["--bail"],
	["--bail", "--bail-layer=group"],
	["--bail", "--bail-layer=suite"],
];

type Side = "helix" | "japa";

/** Run one spec under its runner and return the journal it wrote. */
function runHarness(
	side: Side,
	spec: string,
	flags: string[] = [],
): Promise<GoldenEvent[]> {
	const harness = path.join(here, `run-${side}.ts`);
	const specPath = path.join(here, "specs", side, `${spec}.spec.ts`);
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--import", "tsx", harness, specPath, ...flags],
			{ cwd: pkgRoot, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		// The exit code is NOT checked: specs deliberately contain failing tests,
		// and a runner exits nonzero for those. The journal is the contract.
		child.on("close", () => {
			const events = parseGolden(stdout);
			if (events.length === 0) {
				reject(
					new Error(
						`${side} harness produced no events for "${spec}".\nstdout:\n${stdout}\nstderr:\n${stderr}`,
					),
				);
				return;
			}
			resolve(events);
		});
	});
}

/**
 * Strip what legitimately differs between twins: the file header (each names
 * its own twin) and the runner import line. What remains must be identical.
 */
function specBody(side: Side, spec: string): string {
	const source = readFileSync(
		path.join(here, "specs", side, `${spec}.spec.ts`),
		"utf8",
	);
	const start = source.indexOf('import assert from "node:assert/strict";');
	if (start === -1) {
		throw new Error(`spec "${side}/${spec}" is missing its assert import`);
	}
	return source
		.slice(start)
		.split("\n")
		.filter((line) => !/^import \{ test \} from "/.test(line))
		.join("\n")
		.trim();
}

describe("golden — helix vs @japa/runner", () => {
	for (const spec of SPECS) {
		test(`${spec}: the twins carry the same body`, () => {
			expect(specBody("helix", spec)).toBe(specBody("japa", spec));
		});

		test(`${spec}: both runners emit the same journal`, async () => {
			const [helix, japa] = await Promise.all([
				runHarness("helix", spec),
				runHarness("japa", spec),
			]);
			expect(helix).toEqual(japa);
		}, 60_000);
	}

	for (const flags of BAIL_MATRIX) {
		test(`bail ${flags.join(" ")}: both runners stop the same way`, async () => {
			const [helix, japa] = await Promise.all([
				runHarness("helix", "bail", flags),
				runHarness("japa", "bail", flags),
			]);
			expect(helix).toEqual(japa);
		}, 60_000);
	}

	for (const flags of FILTER_MATRIX) {
		const label = flags.length > 0 ? flags.join(" ") : "(no filter)";
		test(`filters ${label}: both runners select the same tests`, async () => {
			const [helix, japa] = await Promise.all([
				runHarness("helix", "filters", flags),
				runHarness("japa", "filters", flags),
			]);
			expect(helix).toEqual(japa);
		}, 60_000);
	}
});
