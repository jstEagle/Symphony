# Objective workspace contract

## Status

This document defines the target product and runtime contract for Symphony's
next-generation workspace. It is intentionally stricter than the current UI.
The [current-versus-target matrix](#current-versus-target-state) distinguishes
working behavior, foundations that are only partially wired, and proposed
capabilities.

The central decision is:

> An objective, not a chat, is the durable unit of work.

A chat is one way to talk to an agent. An objective is the durable reason work
exists, the outcomes it is trying to produce, the evolving plan, the active
execution frontier, its decisions, evidence, artifacts, checkpoints, costs, and
history. Closing every Symphony window must not affect it.

## Why this workspace exists

Long-running agent use has already outgrown the single-thread chat model:

- OpenAI reports that by May 2026, 70.2% of sampled Codex users had made a
  request estimated to exceed one hour of human work and 25.6% had made one
  estimated to exceed eight hours. The unit of interaction is increasingly a
  delegated outcome, not one response. See [How agents are transforming
  work](https://openai.com/index/how-agents-are-transforming-work/).
- Codex Automations are used for recurring issue triage, CI-failure summaries,
  release briefs, and bug checks, with results delivered to a review queue.
  See [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/).
- GitHub's agent workflow is issue to branch to pull request to review and CI,
  with further agent work requested through review comments. See [Get started
  with Copilot agents](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/overview).
- Claude Code documents parallel sessions, isolated worktrees, subagents, agent
  teams, resumable sessions, hooks, and background work as distinct coordination
  mechanisms. See [Run agents in parallel](https://code.claude.com/docs/en/agents)
  and [Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees).
- Durable workflow systems make state, event history, retries, signals, and
  checkpoints explicit. Temporal recreates pre-failure workflow state from an
  ordered event history; LangGraph uses checkpointers for resume, human input,
  fault recovery, replay, and forks. See [Temporal workflows](https://docs.temporal.io/workflows)
  and [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence).
- Dynamic agent workflow libraries expose conditional routing, loops, persisted
  state, human feedback, fan-out, and event-driven continuation as ordinary
  control flow. See [CrewAI Flows](https://docs.crewai.com/en/concepts/flows)
  and [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).

The product gap is not another way to display more chats. It is a workspace in
which users and agents can understand and change a living execution strategy
without losing durability, evidence, or control.

## Product boundary

T3 Code demonstrates excellent control-surface foundations: native harness
adapters, bring-your-own subscriptions, local supervision, remote clients,
branch-per-thread isolation, fast session switching, inline diff review, and a
short path from agent work to a pull request. These are worth reusing where the
license and implementation fit. See the [official T3 Code repository](https://github.com/pingdotgg/t3code)
and [product overview](https://t3.codes/).

Symphony's boundary must remain different:

- **T3-style thread control is plumbing.** Sessions, terminals, diffs,
  worktrees, and provider adapters must be fast and dependable.
- **The objective workspace is the product.** A user opens an objective and sees
  its current strategy, frontier, evidence, decisions, and outputs across every
  participating harness.
- **Symphony does not replace native agent loops.** Codex, Claude Code, Cursor,
  OpenCode, Pi, and ACP agents keep their own tools, context, transcripts,
  authentication, and internal orchestration.
- **Symphony owns cross-harness truth.** The daemon owns the objective revision,
  workflow plan, Symphony agent graph, durable commands, semantic events,
  attempts, decisions, artifacts, costs, and recovery state.
- **Symphony does not impose roles.** “Reviewer,” “researcher,” and
  “implementer” are objectives chosen for a run, not runtime classes. Agents may
  invent whatever topology best serves the mission within policy.

## Core domain model

### Objective

An objective is a durable container for intended value. It has:

- a stable ID;
- a short mission statement;
- optional measurable key results;
- an immutable objective revision for every active run;
- workspace and repository scope;
- authority, cost, time, and risk envelopes;
- references to its current plan and runs;
- current outcome state: `active`, `waiting`, `achieved`, `abandoned`, or
  `superseded`;
- accumulated artifacts, decisions, and outcome evidence.

An objective may span many runs. A recurring objective such as “keep main green”
does not become a new unrelated chat every morning. Each scheduled occurrence is
a run under the same objective, pinned to the objective and workflow revisions
that launched it.

Changing a mission or key result creates a new objective revision. It never
silently changes the instruction inherited by already-running agents. A user
may explicitly continue existing runs on the old revision, cancel them, or fork
new runs from a compatible checkpoint.

### Objective admission identity

The daemon binds every objective run to an immutable workflow identity before
it is admitted. If the request names a registered workflow, the requested
revision must exist in durable storage and the supplied hash must exactly match
that stored revision. A local request may use an unregistered workflow only as
an explicit standalone objective: `workflowId` must be
`manual-<slug>@1`, where `<slug>` is the lower-case ASCII objective-id slug
(non-alphanumeric runs collapse to `-`, leading/trailing `-` are removed, and
the result is capped at 80 characters, falling back to `objective`), and
`workflowHash` must be `manual-workflow-<slug>`. Other unregistered identities
are rejected; this prevents a caller from manufacturing a workflow hash.

When a conductor is supplied, it must be a durable agent in a coherent root
lineage, use the requested workflow (or the chat workflow bridge), share the
objective's canonical workspace, and be live or backed by a reusable native
session. The daemon also requires `objectiveId === spec.id`; omitted
`objectiveId` is normalized to `spec.id`.

### Workflow plan

A plan is the current execution strategy for one run. It is a typed graph made
from a small, composable vocabulary:

- intelligent work: `agent`;
- deterministic work: command, gate, and state assignment;
- composition: sequence and parallel;
- choice: branch/if;
- repetition: while/loop;
- suspension: timer, external event, and human decision;
- durable boundary: checkpoint;
- output: artifact publication and objective evaluation.

The initial plan may come from a saved workflow, the conductor, the user, or a
combination. It is not frozen when reality changes. Authorized agents can
propose or apply typed mutations using compare-and-swap against the current plan
revision. Every accepted mutation records:

- author and idempotency key;
- expected and resulting plan revision;
- added, removed, or changed nodes and edges;
- the reason and supporting event/artifact references;
- policy decision and any human approval;
- effect on the current frontier.

The first safe mutation vocabulary can remain append-only. The target contract
also needs replacement, cancellation, dependency changes, branch insertion,
and loop-bound changes. A stale writer must receive a revision conflict and
rebase its proposal; it must never overwrite a newer plan.

### Run

A run is one durable execution of an objective revision and an initial workflow
revision, plus its accepted plan mutations. A run owns:

- its trigger occurrence and input;
- current plan revision;
- step and agent attempts;
- committed state and outputs;
- current frontier;
- attention items;
- checkpoints and artifacts;
- cost, time, and policy evidence;
- an append-only semantic event history.

Runs are not UI sessions. They may continue for minutes, days, or indefinitely
while every client is disconnected.

### Agent

An agent is one intelligent work order with the exact inherited mission, one
local objective, explicit inputs, workspace grant, permission ceiling, native
harness/model selector, and an output schema. It may create more Symphony agents
when policy and depth allow.

Native harness subagents remain native implementation detail unless their
harness exposes enough stable identity and lifecycle evidence for Symphony to
project them honestly. Symphony must never invent nodes for activity it cannot
observe.

### Conversation

A conversation is a message channel attached to an objective, run, or agent. It
is not the source of workflow state. Messages may steer work, answer an
attention request, or discuss an artifact, but mounting or closing the
conversation cannot start, stop, duplicate, or settle execution.

### Artifact

An artifact is a first-class, content-addressed output or evidence object. It
records:

- media type, hash, size, and storage/reference location;
- producing objective, run, step, attempt, and agent;
- source event cursor and input lineage;
- validation state and schema when applicable;
- human or agent review state;
- replacement/supersession relationship;
- previews appropriate to code, diffs, test results, logs, documents, images,
  datasets, pull requests, or deployments.

Messages and plan nodes refer to artifact IDs rather than copying large payloads
through transcripts. Completion is expressed through verified artifacts and key
results, not merely a final assistant paragraph.

### Attention item

An attention item is a durable request for a person or governing agent to make a
decision. It is not a transient modal. It records:

- why attention is required and what is blocked;
- risk, urgency, confidence, and affected resources;
- proposed action and viable alternatives;
- exact permission or policy boundary involved;
- relevant diff, artifact, checkpoint, and trace references;
- consequence of approval, rejection, edit, or delay;
- assignee, expiry, and escalation policy;
- resolution and the idempotent command that applied it.

The canonical attention inbox aggregates requests across every objective and
orders them by consequence, not arrival time. Routine operations inside an
explicit autonomy envelope proceed without interruption. This addresses the
observed failure mode where parallel Codex sessions turn the user into a
full-time approval dispatcher; see [Codex issue #37827](https://github.com/openai/codex/issues/37827).

### Checkpoint

A checkpoint is a committed recovery and branching boundary, not necessarily a
snapshot of process memory. It identifies:

- objective, workflow, and plan revisions;
- committed workflow state and step outputs;
- attempt and event high-water cursors;
- artifact hashes;
- workspace revision, commit, patch, or worktree evidence;
- native session IDs and their proven continuity capabilities;
- unresolved external side effects and idempotency receipts;
- policy and configuration snapshot.

A checkpoint can support resume, retry, or fork only to the extent proven by
those capabilities. The UI must say when a retry creates a replacement agent or
re-executes an activity rather than implying that an opaque native process was
rewound.

### Objective supervision kernel

The workflow package exposes `ObjectiveSupervisor` as a bounded decision
kernel. `next(runId)` derives one stable intent from the durable run, plan,
frontier, checkpoint, and approval projection. It emits exactly one of
`dispatch`, `evaluate`, `replan`, `wait-for-approval`, or `finish`; it does not
launch a native harness, call a model, or run an internal loop.

The daemon must acknowledge the intent with its `intentId` and, where state
changes, an idempotent checkpoint or plan/approval command. The kernel fences
the acknowledgement against the active plan revision and rejects stale
intentions. Dispatch and evaluation acknowledgements carry task updates and an
event cursor; replans are append-only and remain bounded by the objective's
`maxReplans`; approval resolution retains the runtime's permission envelope.
Because intent identity is derived from durable state and acknowledgements are
recorded as receipts, constructing a new supervisor after a restart resumes the
same pending action without owning native execution.

## The living runline

The runline is the default human-readable projection of an objective's semantic
event history. It replaces the assumption that the most useful view is a linear
chat transcript.

Each runline entry is typed and backed by daemon evidence. Examples include:

- objective or plan revision accepted;
- stage entered or exited;
- agent delegated, handed off, settled, or failed;
- branch selected and why;
- loop iteration opened, evaluated, or stopped;
- artifact published or superseded;
- checkpoint committed;
- retry scheduled from a named boundary;
- attention requested or resolved;
- key result evaluated;
- run completed, abandoned, or blocked.

The runline is concise by default. Repeated tool calls and text deltas collapse
under their semantic stage, while trace spans and native logs remain available
on drill-down. It never fabricates a percentage for open-ended work.

For a bounded graph, progress may be structural: `4 / 7 settled`. For a loop it
must show evidence such as `iteration 3 · score 7/10 · target 8 · next: revise`.
For an event wait it must show `waiting for deployment health signal since
14:32`, not an animated indefinite loader.

### The execution frontier

The frontier is the set of unfinished items that can currently change the
outcome. It is derived by the daemon from the accepted plan and durable state.
It includes:

- runnable nodes waiting for capacity;
- actively executing agents or deterministic steps;
- blocked dependencies;
- scheduled retries and their due time;
- timers and external event waits;
- unresolved attention items;
- outcome-unknown deliveries requiring reconciliation.

The frontier is not the same as “live agents.” It explains both motion and lack
of motion. A run with zero active agents may still be healthy because it is
waiting for an approved time, signal, or person. A run with an animated worker
may still be blocked if its only meaningful next action requires attention.

The objective header should reduce the frontier to one truthful sentence:

> Two agents are running, one review waits on their artifacts, and production
> deployment needs your approval.

## Plan revisions, branches, and loops

### Plan revision UX

The user sees a plan as a living outline first and a graph second. Each revision
has a readable diff:

- what changed;
- who changed it;
- why it changed;
- what new cost, authority, or delay it introduces;
- which active work is unaffected, cancelled, or replaced.

Graph editing is not limited to a manual node editor. A user can state “add an
independent security check before deployment,” and the conductor can propose the
typed mutation. Agents can make the same proposal autonomously when evidence
suggests the current strategy is insufficient.

### Branches

Every selected branch records its condition inputs and result. Unselected paths
remain visible as alternatives without looking active. When an agent introduces
a new branch at runtime, the plan revision makes that change explicit before the
branch executes.

### Loops

A loop is projected as a compact iterative object with:

- current and maximum iteration when bounded;
- continuation condition;
- per-iteration inputs, outputs, artifacts, cost, and duration;
- evaluation trend and target when one exists;
- retry/backoff policy;
- exit reason: condition met, cap reached, budget exhausted, cancelled, failed,
  or plan revised.

Iterations must not become dozens of indistinguishable chat turns. Users should
be able to compare iterations and open only the evidence that changed the next
decision.

## Objective workspace layout

The workspace uses progressive disclosure rather than forcing every feature
into one dashboard.

### Persistent objective header

Always visible:

- objective and revision;
- key-result state;
- overall status and frontier summary;
- cost/time envelope and current use;
- workspace/repository scope;
- pause, resume, revise, checkpoint, and close controls where valid.

### Primary runline

The default center view is the living runline with embedded stages, decisions,
artifacts, and concise agent activity. Conversation turns can appear in context
without defining the ordering or lifecycle of the run.

### Frontier rail

A compact rail shows active, queued, waiting, retrying, and attention-required
items. Selecting an agent opens its conversation as a tile. Selecting a wait or
decision opens its exact contract rather than a generic chat.

### Tiled work area

Users may tile the conductor, child-agent conversations, terminals, diffs,
artifacts, graph, and trace. The main conductor receives a distinguishing border
only while more than one agent conversation is open. Any tile may be detached
to another browser window or monitor.

Window position, size, selected tabs, and tile layout are presentation state and
may synchronize through browser storage or inter-window messages. Agent state,
run state, approvals, plan revisions, and settlement never use that channel as
authority.

### Graph and trace

- The graph answers: “what depends on what, which strategy is current, and how
  did it change?”
- The trace answers: “where did time, model calls, tool calls, retries, and waits
  go?”
- The runline answers: “what materially happened and what happens next?”

These are projections of the same daemon records, not separately maintained UI
models.

### Artifact shelf and decision inbox

Artifacts are grouped by outcome and provenance, not by whichever message
mentioned them. The decision inbox is available globally and within the
objective. Resolving a decision updates both locations from the same durable
record.

## Daemon truth and disposable windows

The authority boundary is non-negotiable:

1. The daemon owns all orchestration facts in SQLite and the monotonic event
   stream.
2. Native worker hosts or external providers own the execution they can prove;
   Symphony records their identity, capabilities, receipts, and evidence.
3. Clients load an authoritative snapshot, then resume events after their last
   committed cursor.
4. Every client mutation carries an idempotency key. An unknown acknowledgement
   is reconciled, never guessed successful or repeated under a new identity.
5. A browser may optimistically render its own submitted message or proposed
   plan mutation, but it remains visibly pending until the daemon acknowledges
   the exact ID.
6. Reloading, closing, detaching, or crashing any window does not change
   execution.
7. Local storage may contain layout, drafts, and an exact retry outbox. It may
   not contain the authoritative run, plan, frontier, approval, or agent state.
8. Multi-window synchronization improves presentation responsiveness only. Each
   window can reconstruct truth independently from bootstrap plus events.

Every visible status should be traceable to a daemon record and event cursor.
If Symphony cannot establish whether a native side effect occurred, the state
is `outcome-unknown`; it is not silently converted to success, failure, or a
retry.

## Mapping real workflows to Symphony primitives

| Observed workflow | Required Symphony primitives | Primary source |
| --- | --- | --- |
| Daily issue triage, CI summaries, release briefs, and bug checks | Recurring objective, cron occurrence, pinned revisions, run rollup, artifact publication, attention inbox | [Codex Automations](https://openai.com/index/introducing-the-codex-app/) |
| Issue to implementation branch to PR review and CI repair | Repository trigger, isolated workspace grant, plan stages, diff/PR artifacts, deterministic gates, attention decisions, follow-up run | [GitHub agent task lifecycle](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/overview) |
| Parallel research, implementation, testing, and specialist review | Agent fan-out, worktree ownership, visible frontier, dependency/fan-in nodes, evidence-linked outputs, independent drill-down | [Claude parallel agents](https://code.claude.com/docs/en/agents) |
| Plan, execute, evaluate, and refine until criteria pass | Versioned plan, evaluator output schema, loop state, iteration comparison, key-result scoring, budget/cap exit | [Claude lifecycle hooks](https://code.claude.com/docs/en/hooks-guide), [OpenAI agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/) |
| Pause for approval, edits, or additional human context | Durable attention item, checkpoint, approve/edit/reject decisions, policy boundary, exact resume command | [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), [GitHub approvals](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-automation-rationale-and-approvals) |
| Resume after worker, daemon, or client failure | Event history, idempotent activities, step attempts, checkpoint, native continuity evidence, retry provenance | [Temporal durable workflows](https://docs.temporal.io/workflows), [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) |
| Conditional, event-driven, or indefinitely repeating automation | Branches, loops, durable state, external signals, timers, cancellation, iteration and memory boundaries | [CrewAI Flows](https://docs.crewai.com/en/concepts/flows), [Temporal message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing) |
| Specialist takes over or manager combines specialist outputs | Explicit handoff or agent-as-tool edge, bounded transferred context, ownership marker, trace and artifact lineage | [OpenAI Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/) |
| Supervise long-running work from another device | Disposable synchronized projections, global attention inbox, live frontier, concise updates, remote steering and approvals | [Codex cross-device supervision](https://openai.com/index/work-with-codex-from-anywhere/) |

## Current versus target state

| Area | Current implementation | Target contract |
| --- | --- | --- |
| Authority and projection | Implemented: daemon-owned SQLite state, monotonic events, resumable SSE, idempotent API commands, and disposable browser projection | Preserve this boundary for every new objective/workspace feature |
| Missions and objectives | Implemented foundation: immutable workflow mission revisions and key results are injected into Symphony agents; chats have conductor missions | Add a first-class objective entity spanning runs, revisions, policies, outcomes, and artifacts; stop treating a conversation as the top-level container |
| Static workflows | Implemented: immutable JSON/TypeScript workflows with `agent`, `set`, `sequence`, `parallel`, `if`, and bounded `while`, plus manual and cron triggers | Keep saved workflows as reusable starting strategies inside objectives |
| Dynamic plans | Partial foundation: protocol and SQLite records exist for compare-and-swap, append-only plan mutations and plan revisions | Wire mutation through authenticated agent tools, daemon validation, executor scheduling, bootstrap/events, revision diffs, and UI; later support typed replace/cancel/dependency/branch mutations |
| Durable execution | Implemented substantially: workflow revisions, step attempts, idempotency, cron occurrence recovery, cancellation intent, retained worker-host transport for supported drivers, and fail-closed unknown outcomes | Expose these mechanics coherently through checkpoints, retry provenance, frontier state, and objective history |
| Runline and frontier | Partial UI work can derive agent/run activity and current conversation state; graph, trace, and semantic activity views exist | Make the daemon project a first-class runline and frontier across agents, deterministic steps, waits, retries, decisions, branches, and loops |
| Attention | Partial shell: UI inbox components and attention-like conversation summaries exist; the runtime projection currently supplies no durable attention-item records | Add durable attention schema/storage/events/policy/resolution and one cross-objective risk-ranked inbox |
| Checkpoints | Partial foundation: committed attempts, cursors, native session IDs, and worker leases provide recovery evidence; a checkpoint presentation component exists | Add a first-class checkpoint record and verified resume/retry/fork commands. Do not imply process rewind where only replacement is possible |
| Artifacts | Partial foundation: agent input supports artifact references and structured UI can present file/diff-like results; current conversation projection does not expose a durable artifact registry | Add content-addressed artifact storage/references, lineage, validation/review state, previews, and artifact-driven completion |
| Branches and loops | Implemented execution for deterministic `if` and bounded `while`; activity is visible through generic run/graph state | Add branch-decision evidence, iteration comparison, trend/target UI, explicit exit reason, and dynamic branch/loop plan mutations |
| Conversations and tiling | Implemented assistant-style chat, agent drill-down, multiple tiles/pop-outs, project grouping, and structured data UI | Make conversations subordinate views inside the objective workspace and guarantee every tile reconstructs from daemon truth |
| Cost and evaluation | Implemented attributed usage/cost normalization and typed agent outputs; evaluation examples/tests are emerging | Add objective budgets, per-plan/iteration cost comparison, key-result evaluators, stop policies, and outcome history that can improve later routing |
| Autonomy policy | Implemented permission ceiling (`full-access` or `read-only`), workspace grants, depth/concurrency configuration, and bounded native cancellation | Add objective-level authority envelopes, risk-based attention policy, time/cost limits, and transparent plan-mutation authority |

Structured `present_ui` surfaces for plans, schedules, checkpoints, graphs, and
artifacts are presentation capabilities. They must not be counted as runtime
implementation of the corresponding durable domain object.

## Interaction and truthfulness rules

1. **Outcome first.** The workspace leads with objective state and next meaningful
   action, not the latest token stream.
2. **No fake progress.** Show structural state, iteration evidence, waits, and
   frontier changes rather than invented completion percentages.
3. **No prescribed workflow roles.** Templates may suggest useful strategies,
   but the conductor can choose different agents, loops, and branches.
4. **Attention is scarce.** Interrupt only at a policy boundary or a decision
   whose expected value justifies human focus.
5. **Every retry has lineage.** Users can distinguish resumed work, replacement
   attempts, re-executed deterministic steps, and forked plans.
6. **Artifacts prove completion.** Final prose summarizes; verified outputs,
   tests, diffs, deployments, or other evidence satisfy key results.
7. **Current state and history are separate.** The frontier says what is true
   now; the runline explains how it became true.
8. **Agent autonomy remains inspectable.** Agents may revise strategy within
   policy, but every accepted plan change is versioned and attributable.
9. **Unknown stays unknown.** Missing native evidence never becomes a guessed
   success, failure, or duplicate retry.
10. **Windows are disposable.** No React lifecycle, local-storage record, or
    inter-window message is allowed to become orchestration authority.

## Acceptance scenarios

The objective workspace is credible when these end-to-end stories hold:

1. A user starts a multi-hour objective, closes every window, reopens Symphony
   from another device, and sees the same plan revision, frontier, trace,
   conversations, and attention state while work continued.
2. A conductor discovers two new independent risks, appends specialist branches,
   and the UI shows the plan diff and new parallel frontier before execution.
3. A build/review loop runs four iterations. The workspace compares score,
   feedback, artifacts, cost, and duration per iteration without rendering four
   duplicate conversations as the primary history.
4. A deployment reaches a protected boundary. One durable attention item appears
   everywhere, includes the exact diff and checkpoint, and resolves exactly once
   even if two windows click approve.
5. A daemon dies after a native harness accepts work. Recovery adopts the proven
   worker or marks the attempt outcome-unknown; it never sends the prompt again
   merely because a UI loader disappeared.
6. A failed specialist is retried from a committed checkpoint with a different
   harness. The runline identifies the replacement attempt and preserved inputs,
   while the original failure remains inspectable.
7. A recurring maintenance objective accumulates daily runs, artifacts, trends,
   and unresolved attention without flooding the sidebar with unrelated chats.
8. A user opens conductor, specialist, diff, trace, and artifact tiles across two
   monitors. Rearranging or closing them changes only layout state.

## Implementation order

The workspace should be built vertically rather than as disconnected UI
surfaces:

1. **Objective and plan truth:** first-class objective records, run-plan
   projection, authenticated append mutation, daemon events, and recovery.
2. **Runline and frontier:** one authoritative projection consumed by CLI, API,
   web, and tests.
3. **Attention:** durable decision records, policy evaluation, inbox, and exact
   resolution/resume.
4. **Artifacts and checkpoints:** lineage-aware evidence plus honest
   resume/retry/fork capabilities.
5. **Dynamic strategy:** richer typed plan mutations, branch/loop projection,
   budgets, key-result evaluators, and stop policies.
6. **Objective-native workspace:** runline-first UI, frontier rail, tiled
   drill-downs, global attention, and recurring-objective rollups.
7. **Evaluation:** compare Symphony orchestration strategies against a single
   native agent and native-only subagents on completion quality, human attention,
   elapsed time, cost, recovery, and duplicate-side-effect rates.

The first milestone is not a more elaborate graph. It is a running objective
whose accepted plan can change once, durably and visibly, while every client is
disposable. That proves the new abstraction before the surface area expands.
