import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// Fixtures contain `test()` declarations meant to be spawned by the
		// orchestrator — they're NOT direct Vitest tests.
		// `tests/selftest/**` — these run under helix's own CLI (Stage 2a
		// dogfooding) and use helix DSL imports, NOT vitest's globals.
		exclude: [
			"**/node_modules/**",
			"tests/fixtures/**",
			"tests/selftest/**",
		],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: [
				// Pure re-export barrels (no executable code).
				"src/**/index.ts",
				"src/runtime/lifecycle.ts",
				// Worker IPC + CLI entry path — only reachable via a real
				// child process. Will be covered by 42-N-orchestrator's
				// integration tests when the Rust runner spawns it.
				"src/runtime/worker.ts",
			],
			reporter: ["text-summary", "json-summary"],
			thresholds: {
				lines: 86,
				statements: 84,
				branches: 75,
				functions: 83,
			},
		},
	},
});
