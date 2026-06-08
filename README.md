# `@c9up/helix`

Unified testing toolkit for the Ream ecosystem — bus, HTTP, and DB
fakes, fluent assertions, container overrides, time-travel, plus a
Vitest-compatible test runner CLI.

## Sub-barrels

- `@c9up/helix/bus` — Event bus assertions (emitted events, ack chains)
- `@c9up/helix/http` — fluent HTTP TestClient with assertions + auth
- `@c9up/helix/db` — factory, useTransaction, truncateAll, in-memory SQLite
- `@c9up/helix/runtime` — Vitest-compatible DSL (`test`, `describe`, `expect`, `vi`, lifecycle hooks)

## CLI

```sh
helix test [paths...]            # run a one-shot suite
helix test --watch               # re-run on file changes
helix test --coverage            # V8 coverage + LCOV + thresholds
helix test --diff-cov            # diff coverage vs main branch
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

### Parity proofs

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

What the parity proofs do **NOT** cover today:

- Lifecycle hook semantics across runners (`beforeEach`/`afterEach`
  behaviour is exercised in `tests/selftest/lifecycle.test.ts` only).
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
