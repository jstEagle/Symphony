# Objective/control-plan acceptance harness

This is an isolated, executable acceptance suite for the next-generation
objective/control-plan path. It drives the existing public compiler, reducer,
runtime, protocol, and web projection APIs with deterministic fixtures. It does
not start a daemon, call a native harness, mutate protocol/storage/runtime
implementation files, or require provider credentials.

Run it from the repository root:

```sh
./scripts/objective-control-acceptance.sh
```

The equivalent focused command is:

```sh
pnpm exec vitest run tests/acceptance/objective-control-harness.acceptance.test.ts --reporter=verbose
```

The scenario manifest is [objective-control-acceptance.json](../tests/fixtures/objective-control-acceptance.json).
The test prints a plain-text scorecard suitable for CI logs and evaluation
records.

## Scorecard

| Scenario | Status | Evidence boundary |
| --- | --- | --- |
| Adaptive build -> evaluate -> revise | PASS | Runtime checkpoint failure, bounded plan revision, then criterion-backed success |
| Nested bounded loops | PASS | Distinct nested execution keys, loop counters, and terminal root |
| Parallel backpressure | PASS | With `maxConcurrentAgents=1`, a queued sibling remains undispatched until the running child settles |
| Approval interruption and resume | PASS | Completion pauses in `awaiting-approval` and approved resolution reaches `succeeded` |
| Crash/replay exactly-once | PASS | Duplicate control acknowledgement and objective create replay to the same durable result |
| Dynamic plan mutation | PASS | Typed mutation target validation, dependency insertion, and evidence cursor preservation |
| Dependency-gated frontier | PASS | A conductor-authored dependency keeps the second parallel child queued until its prerequisite completes |
| Per-agent approval gate | PASS | `requiresApproval` yields an approval intent before dispatch and resumes after approval |
| Durable objective fan-out | PASS | Source items materialize as scoped executions, honor local concurrency, preserve source order, and fail-fast cancel siblings |
| Budget/evidence-gated completion | PASS | Budget limits parse and false required evidence cannot produce success |
| Frontend-as-projection semantics | PASS | Web projection scopes events by exact run identity and derives the control-room lane |

The manifest supports `EXPECTED-GAP` rows so an unsupported capability can be
recorded explicitly without failing the default repository check. The current
suite has no expected gaps: parallel concurrency is now covered by the pure
reducer's durable frontier behavior. If a future change moves that guarantee
back to the daemon budget runner, retain the row and mark the boundary
explicitly rather than treating an unconstrained expansion as a pass.

## Acceptance invariants

- Plans remain data-only, hashable, and bounded; loop iterations use concrete
  execution paths rather than bare node IDs.
- Every acknowledgement is tied to the current deterministic intent and the
  exact attempt ID; duplicate receipts are idempotent and conflicting retries
  are rejected.
- A revision is only accepted with the expected revision and its dependencies;
  source identity remains unchanged across a mutation.
- Approval is a durable interruption boundary. Pending approvals prevent task
  or context changes until an explicit resolution resumes or terminates the
  run.
- Completion requires all tasks to settle and every required criterion to pass;
  evidence cursors and budget limits remain explicit inputs.
- Dynamic fan-out is durable: each item has a stable execution path and item
  scope, queued work advances after terminal events, and a failed item cancels
  siblings before the parent fails. Composite item templates remain an
  explicit follow-up boundary rather than being silently treated as agents.
- The browser is a read-only projection of run-scoped durable records and
  events. It never infers another run's state from arbitrary payload IDs.
