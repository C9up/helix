/**
 * Mirror divergence enforcement — guards the parity-proof contract.
 *
 * `tests/selftest/parity-*.test.ts` and
 * `tests/integration/parity-*-mirror.test.ts` MUST carry identical
 * test bodies (only the import line differs: `@c9up/helix` vs
 * `vitest`). Without this enforcement, a future edit to one file
 * could silently desync them and the parity claim would degrade
 * without anyone noticing.
 *
 * The test reads both files, strips the import line that names the
 * runner, and asserts the rest is byte-identical.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");

const PAIRS = [
	{
		self: "tests/selftest/parity-pass.test.ts",
		mirror: "tests/integration/parity-pass-mirror.test.ts",
	},
	{
		self: "tests/selftest/parity-fail.test.ts",
		mirror: "tests/integration/parity-fail-mirror.test.ts",
	},
];

/**
 * Strip lines that legitimately differ between mirror pairs:
 *   - the runner import line (`from "@c9up/helix"` vs `from "vitest"`)
 *   - the leading file-level docstring (each file documents its own
 *     role; bodies are what we care about).
 */
function normalise(source: string): string {
	const lines = source.split("\n");
	const out: string[] = [];
	let inHeaderComment = false;
	let pastHeader = false;
	for (const line of lines) {
		if (!pastHeader) {
			if (line.startsWith("/**")) {
				inHeaderComment = true;
				continue;
			}
			if (inHeaderComment) {
				if (line.includes("*/")) {
					inHeaderComment = false;
					pastHeader = true;
				}
				continue;
			}
			if (line.trim() === "") continue;
			pastHeader = true;
		}
		if (/from "(?:@c9up\/helix|vitest)"/.test(line)) continue;
		out.push(line);
	}
	return out.join("\n").trim();
}

describe("parity mirrors — body divergence guard", () => {
	for (const pair of PAIRS) {
		test(`${pair.self} ⇔ ${pair.mirror}`, () => {
			const selfBody = normalise(
				readFileSync(path.join(pkgRoot, pair.self), "utf8"),
			);
			const mirrorBody = normalise(
				readFileSync(path.join(pkgRoot, pair.mirror), "utf8"),
			);
			expect(selfBody).toBe(mirrorBody);
		});
	}
});
