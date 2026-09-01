# Authority model

Status: architecture contract derived from the current source tree. This document
separates enforced invariants from required next invariants; a **required** item
is not implemented merely because it is specified here.

## Scope and non-goals

The daemon is the policy and orchestration authority. Native harnesses execute a
daemon-issued work order and retain responsibility for their own loop, tools,
authentication, context, and transcript. Policy limits authority and resources;
it must not prescribe a workflow's business shape, sequencing style, review
roles, or choice of harness.

Every effective grant is the intersection of the caller's grant, the run's
grant, the requested operation, and the workspace/resource policy. Authority is
monotonic: an agent-authored child workflow, retry, revision, or harness cannot
increase any of those ceilings. Missing, stale, ambiguous, or unverifiable
policy state fails closed.

## Invariants already implemented

The following are observable in the checked-in implementation:

- The daemon is the sole command/workflow authority; mutating commands carry a
  durable idempotency key and command receipts are persisted
  (`packages/protocol/src/index.ts`, `packages/storage/src/index.ts`,
  `apps/daemon/src/index.ts`).
- A workflow run pins one immutable revision and definition hash. Step attempts
  also have durable run/step/iteration/attempt identities
  (`packages/workflow/src/index.ts`, `packages/storage/src/index.ts`).
- Permissions are binary (`read-only` or `full-access`), and a child cannot
  exceed a read-only parent. Depth and configured concurrency/loop limits are
  available ceilings (`packages/protocol/src/index.ts`,
  `packages/runtime/src/index.ts`, `packages/workflow/src/index.ts`).
- Cancellation is durably recorded before fan-out; native cancellation,
  escalation, and recovery reconcile unknown outcomes fail-closed
  (`packages/workflow/src/index.ts`, `packages/runtime/src/index.ts`).
- Terminal agent output is checked against its declared schema before it is
  accepted (`packages/runtime/src/index.ts`).
- Driver adapters provide harness-specific read-only controls where supported;
  unsupported Cursor Cloud read-only is rejected. Full access is an explicit
  harness mode, not an implication of workflow authorship
  (`packages/drivers/src/codex.ts`, `packages/drivers/src/claude.ts`,
  `packages/drivers/src/acp.ts`, `packages/drivers/src/opencode.ts`,
  `packages/drivers/src/cursor.ts`, `packages/drivers/src/pi.ts`).
- Plugins are treated as trusted local executable code, with last-known-good
  rebuild behavior and a `--no-plugins` recovery path (`packages/plugins/src/index.ts`,
  `docs/plugins.md`).

These controls do not yet amount to a complete run-scoped authority policy.

## Required next invariants

### 1. Effective grant and agent-authored workflows

At run admission, persist a policy snapshot containing at least
`policyVersion`, `policyHash`, actor identity, workflow/run identity, effective
permission, allowed capabilities, workspace grant, budgets, side-effect class
ceilings, approval policy, and expiry. Derive every child from that snapshot;
never re-read mutable global defaults to widen an active run. A child workflow
may request less authority only. It may not change mission/run identity,
parentage, workspace ownership, trigger privileges, budget ceilings, or external
publication authority.

Agent-authored workflow definitions must be data-only or come from an
operator-owned, allowlisted source. Agent-writable workflow source must not be
evaluated as executable TS/JS. Registration, revision activation, and recurring
trigger enablement require daemon validation and an explicit approval policy;
workflow shape remains unconstrained after those checks.

Current gaps/hooks: `WorkflowEngine.executeAgent` currently creates a depth-zero,
parentless agent and reads current defaults
(`packages/workflow/src/index.ts`); `loadWorkflowDirectory` evaluates TS/JS;
daemon admission and command dispatch are the natural enforcement boundary
(`apps/daemon/src/index.ts`, `packages/runtime/src/index.ts`).

### 2. Durable approval identity and side effects

Approval is control flow, not a permission mode. Any operation with a side effect
must have a durable `operationId` that is stable across retries and contains or
indexes run, step/attempt, actor, operation class, canonical target/scope,
request hash, policy hash, and expiry. An approval decision binds exactly to
that identity and cannot be replayed for another target, revision, or scope.

At minimum classify operations as: read; local mutation; credential/network
write; user-visible communication; repository commit/branch/PR; deployment or
production change. Each class has an explicit ceiling and approval requirement.
Unknown classes and provider-reported ambiguous outcomes are denied or paused;
the daemon must not infer success from a timeout.

Current hooks: command receipts and step-attempt keys exist, and drivers emit
`approval.requested`, but there is no durable approval request/decision store or
operation binding (`packages/protocol/src/index.ts`, `packages/storage/src/index.ts`,
`packages/runtime/src/index.ts`). Add the gate in daemon command dispatch before
calling a driver/plugin (`apps/daemon/src/index.ts`).

### 3. Workspace ownership and checkpoints

Canonicalize workspace paths and resolve symlinks before authorization. Every
run has an immutable workspace grant: owner run/agent, permitted roots,
repository/ref, dirty-file policy, and writer lease. Only the owning run (or an
explicitly delegated, narrower grant) may mutate it; read-only observers may
share it. A child cannot claim a different workspace by editing its work order.

`explicit-checkpoint` must name a durable checkpoint. Before an irreversible or
uncertain side effect, persist a checkpoint containing the operation identity,
workspace state, and last confirmed external effect. On recovery, resume only
from confirmed state; never replay an unknown write, message, purchase,
publication, commit, push, or deployment. Rollback means restoring a named
checkpoint or compensating operation, never an implicit destructive reset.

Current hooks: `WorkspaceGuard` checks existence/dirty policy but has no owner,
canonical-root, lease, or checkpoint record; recovery text already calls for the
last confirmed checkpoint (`packages/runtime/src/index.ts`). Add durable
workspace/checkpoint records and enforce them in agent creation, tool dispatch,
and recovery.

### 4. Budgets and safe outputs

A run receives immutable ceilings for wall time, model/tool calls, concurrency,
loop iterations, output bytes, storage, and estimated/provider cost. Reserve
before starting work, debit actual usage, release unused reservations, and stop
or pause at exhaustion. Retries and child work consume the same parent ceiling;
reported or unknown cost is not permission to continue.

Outputs are untrusted data until schema validation, byte/count limits, and
redaction/content policy pass. Persist bounded summaries and references rather
than unbounded prompts, transcripts, credentials, or raw provider output. A
workflow cannot use output text as an authority grant or approval token.

Current hooks: usage events record reported/estimated/unknown cost and AJV
validates terminal output, but there are no reservations, hard budget gates,
output-size limits, or redaction boundary (`packages/runtime/src/index.ts`,
`packages/storage/src/index.ts`).

### 5. Cancellation, revision, PR, and deploy boundaries

Cancellation is scoped to the authenticated caller's run/tree and is durable,
idempotent, and monotonic (`requested` cannot become runnable again without an
explicit resume decision). New work must not start after cancellation; an
in-flight side effect is reconciled by operation identity. Resume requires the
same or a narrower policy snapshot and a new attempt identity.

Revision changes never mutate a running run. A new revision or trigger may be
registered, but activation must pass the same policy checks and any configured
approval gate. Agent-authored workflows may prepare a patch or proposal only.

PR creation, push, merge, deployment, production mutation, and external
communication are separate side-effect classes. Default authority ends at a
local artifact or reviewable diff. A PR/deploy grant must name repository,
branch/ref, target environment, exact operation, expiry, and approver; it must
not be inferred from `full-access`, workflow authorship, or a provider default.
Cursor's `autoCreatePR` is therefore not sufficient as run-scoped authority.

Current hooks: cancellation/recovery and immutable run revisions exist;
`messageAgent` and workflow commands lack same-run/tree scope checks, and
Cursor takes a global `autoCreatePR` setting (`apps/daemon/src/index.ts`,
`packages/drivers/src/cursor.ts`).

## Minimum viable enforcement order

1. Persist and verify a run policy snapshot/hash; derive child authority from it
   and reject cross-run/tree agent messaging.
2. Add canonical workspace ownership plus a single writer lease; reject
   agent-supplied workspace changes and make checkpoint references real.
3. Add operation identity, durable approval records, side-effect classes, and a
   pre-driver/plugin gate; default unknown/external operations to pause/deny.
4. Add hierarchical budget reservation/debit and hard output limits.
5. Make revision/trigger activation and PR/deploy operations consume explicit,
   scoped grants; retain fail-closed cancellation/recovery semantics.

Acceptance requires tests for monotonic child narrowing, cross-run isolation,
workspace ownership, idempotent approval replay, budget exhaustion, bounded
safe outputs, cancellation races, checkpoint recovery without duplicate side
effects, and PR/deploy denial without an explicit grant. No item above should be
reported as implemented until those enforcement paths and tests exist.
