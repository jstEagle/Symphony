# Workflow usage and product research for Symphony

**Research date:** 2026-09-01
**Scope:** Current, publicly available primary sources from agent harnesses, durable workflow runtimes, and agent UI libraries.
**Purpose:** Give Symphony a concrete product direction for long-running, dynamic, multi-agent work without turning the conductor into a prescriptive workflow template.

## Executive answer

The recurring job is not “chat with several bots”. It is: **give an objective to a durable control plane, let agents choose and execute a strategy, and give a person a trustworthy way to observe, intervene, recover, and inspect the resulting evidence.**

Existing products converge on the same missing layer from different directions:

- Coding agents add background sessions, subagents, worktrees, PRs, checkpoints, and remote follow-up.
- Workflow runtimes add durable history, timers, signals, retries, replay, child runs, and human interrupts.
- Chat UI libraries add streaming tool states, artifacts, generative UI, thread persistence, and interactables.
- CI systems add event triggers, concurrency policies, reruns, environments, approvals, and debug logs.

Symphony should combine these capabilities while preserving one important boundary: the daemon owns execution and durable truth; the browser is a reconnectable projection and control surface. The user should be able to describe an objective, constraints, and values. The conductor and workers should be free to create tasks, loops, branches, handoffs, checkpoints, and workflows when useful. Symphony should expose those choices clearly and enforce safety, durability, and recovery—not dictate that every job use “review”, “research”, or another fixed agent role.

## Method and evidence classes

This is a product research synthesis, not a usage-telemetry study. Sources were accessed on 2026-09-01. “Observed” means the linked official documentation, repository, or issue explicitly describes a capability, implementation, or requested behavior. “Inferred” means a product conclusion drawn from several observed sources. GitHub issues are marked as **demand signal**: they are valuable evidence of friction and desired behavior, but do not establish prevalence or an implemented contract.

## Evidence matrix

| Source | Observed workflow or UI pattern | Evidence class | Symphony implication |
|---|---|---|---|
| [Cursor background agents](https://docs.cursor.com/background-agent), [Cloud Agents](https://prod.cursor.com/help/ai-features/background-agents) | Agents run asynchronously in isolated VMs, clone to branches, install dependencies, use configured secrets/network, and can be followed up or taken over. Users can close the laptop and inspect later. Cloud Agents can attach screenshots, videos, and logs to PRs. | Official product docs | A run must outlive a page and expose a durable status, workspace, branch, artifacts, and takeover path. |
| [Cursor API](https://docs.cursor.com/background-agent/api/overview), [web/mobile](https://docs.cursor.com/en/background-agent/web-and-mobile) | Cloud agents are created and managed programmatically, scaled in parallel, and reachable from web/mobile, Slack, GitHub, and Linear. | Official product docs | Treat creation, follow-up, cancellation, and notification as first-class control-plane mutations, not UI-only actions. |
| [Cursor builds](https://cursor.com/docs/cloud-agent/builds), [automations](https://prod.cursor.com/help/ai-features/automations) | Environment builds are reusable and have logs; automations start agents from schedules, webhooks, Git events, and issue trackers for recurring maintenance, review, triage, and security scans. | Official product docs | Separate environment readiness from run state; support event/schedule triggers and show why a run started. |
| [Cursor checkpoints](https://cursor.com/docs/agent/overview), [subagents](https://prod.cursor.com/docs/subagents) | Checkpoints can preview/restore workspace changes; subagents have clean context and can run foreground or background with distinct models and permissions. | Official product docs | Every agent attempt needs a recoverable workspace checkpoint and an explicit context/permission boundary. |
| [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) | Subagents have their own context, prompt, tools, permissions, model, skills, max turns, background mode, worktree isolation, and resumable partial output; the parent receives a summary. | Official product docs | Use typed agent records and handoff envelopes containing objective, context references, model, permissions, workspace, progress, and summary. |
| [Claude Code workflows](https://code.claude.com/docs/en/workflows) | A script can fan out dozens of agents, run phases, loop until checks pass, rank findings, research multiple sources, pause/resume/stop/restart, and show progress, prompts, tool calls, results, tokens, and elapsed time. Mid-run user input is intentionally unavailable. | Official product docs | Dynamic strategy is a real use case. Add an attention queue and resumable control messages so “no mid-run input” is a product choice, not a limitation. |
| [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams), [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) | Independent teammates share a task list and mailbox; dependencies unblock automatically. Cross-session messages coordinate work across sessions/machines, but messages are text and do not carry history or files. | Official product docs | Provide a durable, typed message bus with artifact/context references and provenance rather than relying on ad-hoc text or files. |
| [Claude Code agent view](https://code.claude.com/docs/en/agent-view), [hooks](https://code.claude.com/docs/en/hooks), [goals](https://code.claude.com/docs/en/goal) | A detached-session view groups working/needs-input/completed agents and exposes logs/attachment. Lifecycle hooks observe or control subagent/task/worktree events. A goal stores a completion condition that can be evaluated while background work runs. | Official product docs | The UI needs an attention-oriented frontier, event subscriptions, explicit completion criteria, and a reliable distinction between idle, waiting, failed, and done. |
| [Codex collaboration implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents.rs) | The official implementation gives child agents inherited provider/config/approval/sandbox/cwd plus role-specific configuration. | Official repository | Agent creation must capture effective runtime configuration and make inherited versus overridden settings inspectable. |
| [Codex parallel-agent request](https://github.com/openai/codex/issues/22099), [non-blocking workflow friction](https://github.com/openai/codex/issues/31178), [missing progress](https://github.com/openai/codex/issues/16900) | Users ask for a persistent task/subagent panel, elapsed time and metadata, non-blocking execution, and intermediate progress. Without it, parents queue user messages, assume slow workers stalled, or duplicate work. | Official issue demand signals | A run view must be persistent, reconnectable, and heartbeat-aware. A parent should not guess whether a child is working. |
| [Codex shared work/message bus](https://github.com/openai/codex/issues/21027), [orchestrator proposal](https://github.com/openai/codex/issues/21998), [phase proposal](https://github.com/openai/codex/issues/32100) | Demand signals include append-only status/findings/handoffs, disjoint write scopes, worker packets, retries/backoff, quality gates, and explicit planning/investigation/execution/review phases. | Official issue demand signals | Offer these as primitives the conductor may choose, not mandatory opinions about how every workflow must be organized. |
| [OpenCode agents](https://opencode.ai/docs/agents), [commands](https://opencode.ai/docs/commands) | Primary and subagents can be invoked manually or delegated automatically; custom agents specify prompt/model/permissions/mode/color. Markdown/JSON commands accept arguments, shell output, file references, agent/subtask/model options, and can override built-ins. | Official product docs | Let users define reusable agent/workflow capabilities and select models per task; keep command templates declarative and inspectable. |
| [GitHub Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [reruns](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs), [concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency), [deploy approvals](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments) | Schedules, manual structured dispatch, workflow completion chains, reruns, debug logs, concurrency groups, environment approvals, protected branches, and deployment secrets make event-driven work controllable. | Official platform docs | Model triggers, approvals, concurrency, rerun scope, and debug logging explicitly. Record the source event and exact commit/ref for reproducibility. |
| [Temporal workflows](https://docs.temporal.io/workflows), [message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing), [timers](https://docs.temporal.io/develop/typescript/workflows/timers), [child workflows](https://docs.temporal.io/develop/typescript/workflows/child-workflows) | Durable histories survive infrastructure failures; replay is deterministic; timers persist for months; queries read state, signals mutate asynchronously, updates are trackable/deduplicable, and child workflows have handles and close policies. | Official runtime docs | Build an append-only event ledger plus projections, durable waits/signals, idempotent updates, child-run lineage, and deterministic recovery semantics. |
| [Temporal cancellation/reset](https://docs.temporal.io/develop/typescript/workflows/cancellation) | Activities heartbeat and cancel; a workflow can reset from a history event after a fix with a reason, and history remains reviewable. | Official runtime docs | “Retry” must identify the failed attempt and replay boundary; make cancellation, reset, and compensation visible rather than silently restarting. |
| [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), [HITL](https://docs.langchain.com/oss/python/langchain/human-in-the-loop), [functional API](https://docs.langchain.com/oss/python/langgraph/functional-api) | Checkpoints are taken every step and support memory, HITL, time travel, fork, and fault tolerance. Interrupts pause indefinitely and resume by thread ID; nodes restart from the beginning, so side effects must be idempotent. Durable behavior can wrap ordinary loops and conditionals rather than forcing a DAG. | Official runtime docs | Support dynamic loops/branches in an event model, durable interrupt payloads, fork/time travel, idempotent side effects, and explicit resume identity. |
| [assistant-ui generative UI](https://www.assistant-ui.com/docs/tools/generative-ui), [tool UI](https://www.assistant-ui.com/docs/tools/tool-ui), [interactables](https://www.assistant-ui.com/docs/tools/interactables), [examples](https://www.assistant-ui.com/examples) | A model can stream allowlisted JSON UI components; tool renderers expose args/status/result/toolCallId/addResult/resume/interrupt; interactables let model and user edit shared state; examples include persistence, artifacts, HITL, and generative UI. | Official UI docs/examples | Render plans, approvals, agent lists, graphs, traces, artifacts, schedules, and checkpoints from typed schemas. Never evaluate arbitrary model-generated UI code. |
| [assistant-ui runtimes/threads](https://www.assistant-ui.com/docs/api-reference/runtimes), [thread concepts](https://www.assistant-ui.com/docs/runtimes/concepts/threads), [artifacts](https://www.assistant-ui.com/examples/artifacts) | Runtime actions cover threads/messages/composer/tools; history adapters are required for reload persistence; out-of-band metadata must be reloaded; artifacts provide shared IDs, previews, side panels, and export. | Official UI docs/examples | Keep assistant-ui as a projection adapter over daemon truth. Persist message/run metadata server-side and reconnect with an event cursor. |
| [Vercel Workflow](https://vercel.com/blog/introducing-workflow), [durable execution](https://vercel.com/blog/a-new-programming-model-for-durable-execution), [AI SDK observability](https://ai-sdk.dev/docs/ai-sdk-core/devtools) | Steps persist across crashes/deploys, sleep without consuming resources, resume on webhook/external event, and expose step/input/output/pause/error logs. Durable streams let clients reconnect from the last event; AI SDK groups tool-loop steps into a run and reports tool calls/results/errors/usage. | Official product/docs | Separate the durable event stream from the UI transport; expose a run timeline with step spans, reconnect/resume, errors, token/cost data, and stream cursors. |
| [T3 Code internals](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md), [workspace layout](https://github.com/pingdotgg/t3code/blob/main/docs/internals/workspace-layout.md), [install](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md) | The server owns sessions, workspaces, VCS, filesystem, terminals, providers, checkpointing, and auth. Clients use an authenticated RPC/WebSocket boundary; follow-ups queue workers; ingestion normalizes provider streams; a checkpoint reactor captures/reverts workspaces. | Official repository docs | T3’s server/client boundary validates Symphony’s daemon-first direction. Make workspace ownership, provider auth, ingestion, checkpoints, and reconnect semantics server-side. |
| [T3 worktree issue](https://github.com/pingdotgg/t3code/issues/3753), [worktree include issue](https://github.com/pingdotgg/t3code/issues/5671) | Issues expose practical failure modes: moving a thread/worktree can leave cwd/checkpoint/diff bindings stale; ignored local files can be absent from a worktree unless explicitly included. | Official issue demand signals | Bind thread, workspace, VCS ref, cwd, checkpoint, and diff as one durable identity; make setup manifests and missing-file failures explicit. |

## Concrete user jobs and recurring workflow shapes

These are recurring shapes found in the sources. They are not prescribed Symphony templates; the conductor should be able to combine or invent them.

1. **Repository-wide audit:** inspect many disjoint surfaces in parallel, collect evidence, run an adversarial or independent check, rank findings, and produce a synthesis with links to logs/files/commits.
2. **Acceptance loop:** change a target, run a check, interpret the result, and continue until the completion condition passes, a plateau/iteration limit is reached, or a human changes the objective.
3. **Large migration:** partition files or modules into isolated workspaces, apply a transformation, run focused tests, reconcile conflicts, and merge only validated outputs.
4. **Event reaction:** start from a push, issue, webhook, schedule, CI completion, or external signal; preserve the triggering ref and payload; deduplicate repeated delivery.
5. **Approval gate:** pause before a consequential tool call or deployment; allow approve, edit, reject, defer, or escalate, with the decision and actor recorded.
6. **Competing hypotheses:** run independent debugging/research paths, compare evidence, and let a conductor select the next experiment instead of averaging incompatible answers.
7. **Long wait/resume:** sleep until a timer, build, review, webhook, provider response, or user signal arrives without holding a browser open or consuming an active worker.
8. **Remote observe/steer:** start from a laptop, mobile, Slack, or another machine; inspect progress, send a message, take over a terminal, or stop safely.
9. **Artifact/checkpoint cycle:** produce a diff, report, diagram, preview, or generated file; inspect it; fork or restore the workspace; continue from a known state.
10. **Cross-harness dispatch:** use the best available native harness for a subtask, preserve its model/auth/tool semantics, and return a normalized result with provider-specific details still inspectable.
11. **Recurring maintenance:** run the same objective on a cadence but allow the strategy and number of workers to adapt to the current repository state.
12. **Self-improvement/debugging:** allow an agent to inspect Symphony’s own logs and source, propose or implement a fix in a scoped branch, run gates, and open a PR while preserving human approval boundaries.

## Failure modes and intervention points

| Failure mode | What the sources reveal | Required intervention |
|---|---|---|
| A child is started but absent from the UI | Codex demand signals ask for a persistent task panel; Claude exposes detached agent view; assistant-ui needs a remote history adapter. | Create the durable child record before dispatch, then stream/replay it from the daemon. Never depend on a single chat message to announce existence. |
| Parent or UI assumes a slow child is stalled | Codex issue demand explicitly cites duplicate work caused by missing progress. | Heartbeats, last event, elapsed time, current step, and stale/unknown state; offer inspect, message, retry, stop, and take-over actions. |
| Browser refresh kills or hides work | Cursor, Temporal, LangGraph, and Vercel all treat execution as durable beyond clients. | UI disconnect must only remove a projection. Reconnect by run/thread ID and event cursor, replaying missed events. |
| Harness crash or provider disconnect | Temporal history/activity retry and Cursor build/runtime separation make the boundary explicit. | Persist provider attempt, exit code, stderr, auth/model/version, retry policy, and recovery eligibility. Distinguish `failed`, `canceled`, `unknown`, and `orphaned`. |
| Context is lost at handoff | Claude messages are text-only and do not carry history/files; T3 normalizes provider streams server-side. | Use a portable handoff envelope: objective, constraints, parent/child IDs, selected context refs, artifact refs, workspace/ref, provider/model, permissions, summary, and open questions. |
| Dynamic loop never converges | Claude workflows and goals support loops/completion conditions; LangGraph supports ordinary loops with durable checkpoints. | Require a visible objective/condition and show iteration, evidence, budget, and stop reasons. Permit agent-chosen loops, but expose optional safety budgets and human escalation. |
| Mid-run decision is needed | Claude workflow scripts intentionally cannot accept mid-run input; LangGraph and HITL explicitly interrupt/resume. | Represent attention as a durable queue with typed decisions, expiry/delegation, and resume token; do not bury it in a modal or prose. |
| Tool-call stream is malformed or duplicated | Assistant-ui tool UI and Vercel AI SDK model calls/results/errors as structured parts/steps. | Ingest provider events into normalized turn/step/tool records with stable IDs, ordering, partial arguments, result/error state, and deduplication. |
| Invalid/non-serializable workflow state | LangGraph interrupts require JSON-serializable payloads; assistant-ui generated UI uses schemas/allowlists. | Validate every event, control command, tool payload, and generated UI schema at the boundary; store rejected payloads as visible errors. |
| File/worktree conflict or missing local setup | T3 worktree issues show stale bindings and ignored-file gaps; Cursor uses explicit builds and environment setup. | Make workspace/ref/setup manifest part of run identity; report missing files/dependency/build failures before dispatching expensive workers. |
| Unauthorized side effect | GitHub environments and harness permission settings gate deployments and tools. | Show effective inherited/overridden permissions; require explicit approval for destructive or external side effects; record actor and decision. |
| Hidden cost/concurrency explosion | Cursor has active-agent/API limits; Claude and Codex expose token/elapsed/concurrency concerns in their workflow surfaces. | Budget tokens/cost/time/concurrency; show estimates and actuals per run/agent/tool; let the conductor adapt within declared limits. |
| Auth/model/version drift | Cursor and T3 place provider auth on the host; Codex/OpenCode/Claude expose model and permission selection. | Poll/revalidate harness readiness, selected model, CLI version, and auth state; surface a recoverable provider error instead of a generic spinner. |
| Retry duplicates a side effect | Temporal and LangGraph require idempotent activities/effects around replay/resume. | Every mutating control command needs an idempotency key and durable receipt; retries must reference the original attempt and delivery status. |

## What a chat UI cannot express by itself

A single assistant message stream is a poor representation of:

- an event-sourced run whose current state is a projection of many durable events;
- concurrent children, dependencies, fan-out/fan-in, dynamic loops, retries, and branches;
- a worker that is waiting, stale, blocked, failed, canceled, or complete rather than merely “typing”;
- a human attention request with a specific action, deadline, permission, and resume identity;
- a tool call with streamed arguments, partial output, result, error, approval, and stable call ID;
- an artifact, file diff, checkpoint, workspace, commit, or fork that must remain addressable after the message scrolls away;
- replay from a cursor after refresh, provider reconnect, daemon restart, or mobile handoff;
- model/provider/auth/version/permission/cost/concurrency state;
- an evolving plan where agents can add or remove work and explain why;
- the difference between an observed fact, a claim, an unresolved question, and a synthesized recommendation.

Chat remains useful as the natural objective and intervention surface. It should sit beside structured run projections, not replace them.

## Inferences: Symphony product thesis

The following are product inferences, not direct vendor claims.

### 1. Objective-first, not workflow-template-first

The durable object should be an **objective run** with constraints, values, success conditions, and optional budgets. Agents can create arbitrary tasks, agents, loops, branches, workflows, waits, handoffs, and checkpoints. The product should offer affordances and schemas, not opinions such as “every run needs review” or a fixed agent catalog.

### 2. Agent-authored strategy, daemon-supervised execution

The conductor should be able to decide how to pursue the objective. The daemon must still enforce identity, permissions, idempotency, concurrency, resource limits, event ordering, and recovery. This is the balance between harness-native orchestration and Symphony: use the native harness for its own loop/tools, use Symphony for durable cross-harness work and global coordination.

### 3. The unit of truth is a typed durable record

Messages are views over events. Persist runs, turns, steps, tool calls, agents, workspaces, artifacts, checkpoints, controls, attention requests, costs, and provider attempts with stable IDs and parent/child lineage. Build projections for chat, graph, trace, activity, agent tree, file tree, usage, and command palette from that same ledger.

### 4. Status must be explicit and terminal

Use a state machine that distinguishes `queued`, `starting`, `running`, `waiting`, `needs_attention`, `succeeded`, `failed`, `canceled`, `orphaned`, and `unknown`. Animation belongs only to genuinely active states. Every terminal state needs a timestamp, reason, last event, and drill-down log.

### 5. Attention is a first-class queue

Human intervention is not just an approval modal. The queue should contain approve/edit/reject, answer question, resolve conflict, provide credential, choose branch, retry failed attempt, stop, take over, and change objective. Decisions are durable, scoped, auditable, and resumable.

### 6. Structured UI is how complex work stays legible

Use assistant-ui’s allowlisted tool/generative UI model as a projection layer for plan cards, agent lists, dependency graphs, traces, timelines, artifacts, file trees, score breakdowns, recommendations, schedules, checkpoints, and handoffs. The daemon remains authoritative; the model may request a component schema but cannot execute arbitrary UI code.

### 7. Evidence beats confidence

Every synthesis should link to event ranges, tool calls, artifacts, diffs, logs, and checkpoints. Agents should be able to report “unknown”, “blocked”, or “needs a human” without being pushed into a plausible prose answer.

## Prioritized primitives and acceptance criteria

### P0 — durability and truth

1. **Durable run ledger and event cursor**
   - The daemon writes an immutable, ordered event stream for every run and child.
   - A browser refresh, tab close, reconnect, or daemon process restart does not stop execution or lose events.
   - A client reconnects by run/thread ID and cursor, receives missed events, and converges to the same projection.
   - Duplicate provider/control delivery does not create duplicate turns, agents, or side effects.

2. **Unified agent frontier and liveness**
   - Every spawned agent appears before execution begins and has parent, objective, harness, model, permissions, workspace, and attempt IDs.
   - Heartbeats and last-event timestamps support stale detection; no active animation remains after a terminal state.
   - Failures expose actionable error, exit/attempt metadata, logs, retry eligibility, and a scoped retry action.

3. **Dynamic strategy/state machine**
   - The conductor can add/remove/reorder work, spawn children, join results, loop, branch, wait, signal, checkpoint, and hand off.
   - No fixed role such as “review” is required. Custom user/agent-defined capabilities are supported.
   - Completion criteria, stop reasons, iteration count, optional budgets, and unresolved questions are visible.

4. **Idempotent control plane**
   - Start, follow up, pause, resume, signal, approve, reject, retry, cancel, reset, stop, and take over are durable commands with idempotency keys and receipts.
   - Unknown delivery is shown as unknown and reconciled; it is never inferred as success.

5. **Attention and recovery queue**
   - A user can approve/edit/reject/defer/escalate a requested action and later resume the exact waiting attempt.
   - A failed child can be retried independently; a run can reset/fork from a checkpoint with a recorded reason.

### P1 — useful power-user surfaces

6. **Portable handoff envelope**
   - Cross-harness handoff preserves objective, constraints, context/artifact refs, summary, open questions, workspace/ref, provider/model, permissions, and lineage.
   - Native harness transcript/tool semantics remain inspectable instead of being flattened into text.

7. **Workspace, artifact, and checkpoint ledger**
   - Every artifact/diff/commit/preview is addressable, hashable, and linked to the event/attempt that produced it.
   - Worktree/cwd/setup changes update all bindings atomically; missing ignored files and setup failures are explicit.

8. **Live trace and graph projections**
   - Trace uses a shared time axis with nested spans for runs, turns, tools, waits, and child agents; graph supports pan, zoom, fit-to-content, status colors, dependency edges, and stable node IDs.
   - Both views are generated from the same ledger and remain correct after reconnect or late events.

9. **Structured tool/generative UI**
   - Tool calls expose streamed args, running/result/error/approval states, stable IDs, expand/collapse, and raw evidence.
   - Allowlisted schemas render agent plan, subagent list, graph, timeline, file tree, artifacts, recommendations, score/spec sheets, schedules, handoffs, and checkpoints.
   - UI state is not the execution authority and is safe against arbitrary model-generated code.

10. **Triggers, timers, and external signals**
    - Runs can start from manual input, schedule, webhook, CI event, provider event, or another run; payload/ref/source are retained.
    - Durable sleep and signal/update/query semantics survive daemon restarts and deduplicate repeated event delivery.

11. **Cost, model, and concurrency accounting**
    - Show planned and actual token/cost/time by run, agent, harness, model, tool, and attempt.
    - Show concurrency limits, queue delay, provider readiness/auth/version, and model fallback decisions.

### P2 — scale and ergonomics

12. **Reusable custom workflow/agent library**
    - Users can save declarative capabilities with typed parameters, model/permission defaults, trigger bindings, and version history.
    - A saved workflow remains an optional strategy, not a hidden mandatory policy.

13. **Durable agent message bus**
    - Agents can send typed findings, questions, handoffs, and status updates with artifact refs and delivery receipts; parent decisions remain explicit.

14. **Command palette and multi-surface control**
    - Search across runs/events/artifacts semantically when enabled, fuzzy-find otherwise, and execute every safe Symphony action with confirmation for consequential actions.
    - A run can be observed and controlled from multiple windows/monitors without diverging state.

## End-to-end acceptance scenario

This scenario should be automated and manually exercised against a real daemon:

1. Start an objective with a completion condition, workspace, model policy, and a concurrency budget.
2. The conductor spawns three heterogeneous native-harness agents with distinct scopes. All three appear immediately in the agent frontier and sidebar.
3. Disconnect the browser for several minutes while agents stream tool calls, create an artifact, and one child fails.
4. Reconnect with the saved run ID. The UI replays missed events, shows two terminal successes and one failed child, and stops all terminal loaders.
5. Open the failed child’s chat, raw logs, trace span, workspace diff, and provider attempt. Retry only that attempt with an idempotency key.
6. Let the conductor dynamically add a follow-up branch based on the evidence, then loop until the acceptance check passes or the declared budget stops it.
7. Pause on a human attention request. Approve an edited command; verify the same waiting attempt resumes once, not twice.
8. Wait on an external signal/timer, restart the daemon, deliver the signal twice, and verify one resume.
9. Inspect graph, waterfall trace, activity log, agent tree, cost view, artifacts, and checkpoint history; all agree on IDs/status/timestamps.
10. Fork from a checkpoint, alter the objective, and verify the fork has lineage without mutating the original.
11. Handoff a child to another harness and verify the envelope, workspace, permissions, and result provenance.
12. Refresh every UI surface and open the same run in another window. Both converge from the ledger. No browser lifecycle event stops the run.

## Boundaries and limitations

- These sources describe capabilities and friction, not private adoption or frequency. No source here proves that a particular workflow is the most common.
- GitHub issues and discussions are demand signals from individual users; they should guide acceptance tests, not be treated as shipped behavior or prevalence data.
- assistant-ui and vendor examples demonstrate viable UI patterns, not a requirement to copy their visual design or architecture.
- T3 Code is an architectural reference for server/client/workspace boundaries; Symphony should preserve its own daemon, protocol, native harness, and plugin contracts.
- “Run forever” is not a safe product requirement. Long-lived runs need explicit objective, budget, liveness, stop, escalation, and recovery semantics; the agent may choose strategy inside those bounds.

## Research stopping point

The evidence converged across four independent classes—coding-agent products, durable workflow runtimes, CI/event systems, and structured agent UI libraries. Further browsing would mostly add another implementation of the same primitives. The next highest-value work is instrumenting Symphony’s real daemon/browser behavior against the acceptance scenario above and using the resulting failures to refine the event and control contracts.
