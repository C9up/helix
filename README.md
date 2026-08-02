# `@c9up/helix`

Framework-agnostic testing toolkit for the Ream ecosystem — a
Vitest-compatible test runner CLI with fluent assertions, container
overrides, and time-travel. Host-specific fakes (bus / HTTP / DB) live in
their own integration packages, not here — helix stays dependency-light.

## Sub-barrels

- `@c9up/helix` — assertions + `expect`, the test entry point
- `@c9up/helix/runtime` — Vitest-compatible DSL (`test`, `describe`, `expect`, `vi`, lifecycle hooks)
- `@c9up/helix/runtime/worker` — worker entry for the parallel runner
- `@c9up/helix/container` — `useContainer` / `override` / `overrideOn` / `spy`
- `@c9up/helix/time` — time-travel helpers

## CLI

```sh
helix test [paths...]            # run a one-shot suite (e.g. `helix test app`)
helix test --watch               # re-run on file changes
helix test --coverage            # V8 coverage + LCOV + thresholds
helix test --diff-cov            # diff coverage vs main branch
```

Filters follow Japa: `--tests` and `--groups` take exact titles,
`--files` matches path segments (`--files=user`, `--files=unit/*`),
`--tags` matches ANY of the given tags (`--match-all`, spelled
`--matchAll` too, requires every one), and a `~@tag` / `!@tag` entry
excludes. `--suite=<name>` names the suite the files belong to
(`"default"` otherwise, like Japa's implicit suite) — it surfaces as
`ctx.test.options.meta.suite` and on the `suite:*` events. `--grep` is
a helix extra: a regex or substring over the full test name.

## Plugins

A plugin is a function run once at `configure()` time, handed the same
object Japa hands its plugins — plus two helix extras:

```ts
await configure({
  plugins: [
    ({ config, cliArgs, runner, emitter, context, cleanup }) => {
      context.macro("greeting", "hello")       // extend the test context
      emitter.on("test:end", (t) => { … })     // observe the run
      cleanup(async () => server.close())      // close resources afterwards
    },
  ],
})
```

- `config` — the resolved `configure()` options
- `cliArgs` — the flags the CLI forwarded to this worker
- `runner` — `getSummary()`: counts, `hasError`, failed titles
- `emitter` — `runner:start` / `suite:*` / `group:*` / `test:*`
- `context` — `macro` / `getter` (also on the `TestContext` class, as
  in Japa)
- `cleanup` — a teardown run once the file's tests finish

In `package.json`, call the `helix` bin directly — in npm scripts it resolves to
`node_modules/.bin/helix` and bootstraps the TS loader itself, so the verbose
`node --import tsx node_modules/@c9up/helix/bin/helix.js …` form is unnecessary:

```json
{
  "scripts": {
    "test": "helix test app --threads=1",
    "test:coverage": "helix test app --threads=1 --coverage"
  }
}
```

## Self-testing (Stage 2a — coexistence)

Helix is currently tested by **two runners in parallel**:

- `pnpm test` — vitest runs `tests/integration/**`. This is the
  established safety net: every commit must verdict pass here.
- `pnpm test:self` — helix runs `tests/selftest/**`. This is helix
  testing itself: the runtime DSL, lifecycle hooks, spies, fake
  timers, and a small set of parity proofs. Vitest is excluded from
  `tests/selftest/**` so it doesn't touch helix-DSL imports.

Both commands run independently in CI. Stage 2b will retire vitest
once the helix self-test corpus reaches parity coverage with the
vitest suite.

### Japa parity proofs (golden tests)

`tests/golden/` runs helix against the **real `@japa/runner`**. Every
spec under `specs/helix/` has a byte-identical twin under
`specs/japa/` — only the runner import differs. Each pair is executed
by its own runner; both harnesses write the same normalized event
journal (`runner:start`, `group:start`, `test:start`, `test:end`, …)
and the journals must match event for event:

| Spec | What it pins down |
| --- | --- |
| `lifecycle` | group `setup`/`teardown`/`each.*` order |
| `outcomes` | pass / fail / `.skip()` / todo / tags, as reported |
| `dataset` | `.with()` expansion and `{prop}` / `{$i}` titles |
| `retries` | one start/end pair per test, 1-based `retryAttempt` |
| `macros` | `test.macro(callback)` + `t.cleanup` |
| `group_identity` | `test.group()` returns the instance its hooks get |
| `filters` | `--tags` (OR), `--match-all`, `~@tag`, `--tests`, `--groups` |

The filter matrix runs the same flags through both runners, including
the rules that a group — or a whole suite — with no runnable test
announces nothing.

`tests/golden/assert-surface.test.ts` does the same for assertions: it
asserts helix exposes every public assertion of the installed
`@japa/assert`, then runs a battery of inputs through BOTH
implementations and requires the same verdict (this is what pinned
`sameMembers` to strict equality and `sameDeepMembers` to structural).

One named deviation, intentional: a dataset title with no interpolation
token gets a `(row N)` suffix so titles stay unique, where Japa repeats
the same title. And since helix runs one process per FILE, `suite:*`
fires once per file rather than once for a multi-file suite.

### Vitest parity proofs

A handful of identical test bodies live in BOTH directories
(`tests/selftest/parity-*.test.ts` and
`tests/integration/parity-*-mirror.test.ts`). When both runners pass
the same assertions, helix's **matcher semantics** are compatible
with vitest's for the asserted surface area. The mirror pairs
currently cover:

- equality matchers (`toBe`, `toEqual`, `not.toBe`)
- string / array `toContain`
- assertion failure shapes (`AssertionError` thrown, message contains
  both received and expected values)

What the VITEST parity proofs do **NOT** cover today (the Japa golden
tests above cover the runner semantics):

- Spy / fake-timer parity (`vi.fn`, `vi.spyOn`, `vi.useFakeTimers`).
- Failure-pipeline parity (i.e. that both runners REPORT a failed
  test the same way, at the runner level). The current parity-fail
  mirrors catch the failure in-process, so both runners verdict pass
  on those files — only the matcher message format is compared.

A divergence guard in `tests/integration/parity-mirror-divergence.test.ts`
asserts the mirror bodies stay byte-identical (modulo the runner
import line). Stage 2b's vitest retirement plan must include deleting
`tests/integration/parity-*-mirror.test.ts` and the divergence guard
itself, since they exist solely to bridge the two runners.

The Stage 2b cutover criterion is "every runtime DSL surface
(`describe`, `test`, `expect.*`, lifecycle hooks, `vi.*`) has at
least one selftest, and the runner-level failure pipeline is proven
via a fixture + child-process pattern". When that bar is met,
vitest can be removed; until then it stays as the safety net.
