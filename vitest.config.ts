import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// Fixtures contain `test()` declarations meant to be spawned by the
		// orchestrator — they're NOT direct Vitest tests.
		// `tests/selftest/**` — these run under helix's own CLI (Stage 2a
		// dogfooding) and use helix DSL imports, NOT vitest's globals.
			// `src/vendor/**` is generated from scripts/vendor/ and identical in every
			// package that carries it, so measuring it here counts the same lines N
			// times and holds this package to a floor for code it cannot change. The
			// behaviour is pinned where it broke: bay's quasar-bridge suite covers the
			// two manager shapes the loader has to accept.
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
				// The worker entry — it only runs in a real child process (the
				// integration tests spawn it: worker-errors, timeouts,
				// orchestrator), which this in-process v8 coverage cannot see.
				"src/runtime/cli-worker.ts",
				"src/vendor/**",
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
