# Runtime architecture

## Authority boundary

The browser is a projection and control surface. The daemon is the single local authority. Native harnesses are execution engines. SQLite stores only orchestration facts and a monotonic event stream.

```text
TanStack Start SPA / assistant-ui
  ├─ GET /v1/bootstrap
  ├─ GET /v1/events?after=<cursor>       resumable SSE
  └─ POST commands / chat messages
             │
             ▼
local daemon ── SQLite WAL
  ├─ workflow compiler/executor
  ├─ agent graph and concurrency
  ├─ neutral model router
  ├─ passive observer
  ├─ cost normalization
  └─ trusted plugin host
             │
             ▼
native drivers
  ├─ Codex App Server
  ├─ Claude Agent SDK
  ├─ Cursor SDK local/cloud
  ├─ OpenCode server SDK
  ├─ Pi RPC + extension
  └─ Agent Client Protocol
```

## External worker-host boundary

`apps/worker-host` is a deliberately small process boundary between a daemon generation and one native stdio harness process. Bootstrap material is delivered on an inherited file descriptor, not command-line arguments or environment variables. The host creates a private Unix socket and `0600` append-only spool, owns the worker's process group, accepts one HMAC-authenticated controller generation at a time, and assigns a monotonic sequence to stdout, stderr, control, and exit frames.

A reconnecting controller supplies its last acknowledged sequence and receives every later frame before live delivery resumes. Mutating control messages carry stable command IDs, so reconnecting cannot write the same stdin payload or signal twice. The spool is bounded by bytes and frame count; overflow terminates the worker group and records terminal evidence rather than silently dropping or overwriting output.

Codex App Server, Pi RPC, and Symphony-owned OpenCode services use this boundary. Runtime lease adoption authenticates the replacement daemon, fences the previous generation, replays unacknowledged frames into the original logical agent, and atomically advances processed and acknowledged cursors. Subprocess and real daemon-`SIGKILL` acceptance tests require the same host PID, native PID, lease, and native session after recovery, with no duplicate prompt dispatch. Pi additionally proves that a follow-up continues in the retained native process without switching sessions; if that native process itself dies before it reports `agent_settled`, the driver fails closed because Pi exposes no durable turn-acceptance ledger from which to prove a safe retry.

OpenCode is a hosted HTTP service rather than a JSONL RPC child, so its worker-host transport retains the service process and persists only the parsed loopback endpoint in lease adapter state. Each fresh owned service binds to `127.0.0.1` on an ephemeral port and requires a per-agent Basic-auth password derived with HMAC-SHA256 from a Keychain/environment master; the SDK's static header covers both HTTP and SSE. Only the derived child password enters the process environment. No master, password, or authorization header is persisted in arguments, bootstrap data, leases, SQLite, spools, events, logs, or configuration. A replacement daemon recomputes the same credential from the stable master and agent ID, preserving adoption; an extra authorization header remains harmless to historical unauthenticated retained services. If an OpenCode turn finishes while the daemon and SSE subscriber are absent, recovery reads the native persisted transcript and emits stable native event IDs for exactly-once text, reasoning, tool, file-change, usage, and terminal evidence. A reachable user-managed OpenCode endpoint remains external infrastructure: Symphony creates no ownership lease, never terminates it, and does not attach Symphony-generated authorization.

This is an explicit per-driver capability, not a blanket promise. A driver without a proven retained transport may reconnect a natively durable session, but an in-flight local outcome that cannot be established is marked interrupted or unknown rather than replayed. The browser is never part of this lifecycle; closing or refreshing it only replaces a projection.

## The one intelligent-work primitive

There is no `role`, reviewer class, or test-agent class. An agent receives:

- the immutable workflow mission and revision;
- one local objective;
- a native harness/model selector (`auto` is allowed);
- `full-access` or `read-only`;
- typed input references;
- a JSON Schema for its final result;
- a workspace grant.

Review is simply another agent with a review objective and usually `read-only`. Tests and deterministic gates should remain ordinary processes when added to a workflow because an exit status does not need model judgment.

## Mission inheritance

The daemon, not the spawning model, injects the workflow ID, run ID, parent ID, depth, exact mission, workspace, and permission ceiling into child creation. A parent supplies the child objective and routing intent but cannot paraphrase the mission or escape a read-only permission. Once a finite configured maximum depth is reached, the coordination bridge does not advertise `create_agent`; `null` explicitly means unlimited depth.

## Recovery and idempotency

Workflow revisions are immutable, and an existing run always resumes against its recorded revision rather than the newest definition. Every run step has an idempotency key derived from the run, step, iteration, and attempt. Completed attempts replay their committed output. A running agent attempt records the logical agent and native session IDs so daemon startup can call the native resume operation. Cron occurrences persist a versioned dispatch intent before launch, including a deterministic run ID, exact scheduled time, input, and pinned workflow revision/hash. Recovery can therefore create a run that was never launched or attach one that already started without duplicating it. API commands also have unique durable keys.

Chat creation uses the same durable identity rule. Before the browser sends `POST /v1/threads`, it stores the exact payload and request key in a client outbox. The daemon binds that key to the normalized request and atomically commits the chat thread, its conductor run, and the create receipt. A lost response or browser reload can therefore repeat the original request without creating another chat, while a key reused for different input fails with an explicit conflict. The browser outbox is only retry memory; the SQLite receipt remains authoritative.

The matching `chat-run:<thread>` record is a durable conversation, cost, and event container—not a compiled workflow execution. Workflow recovery recognizes that exact chat ID pairing and leaves conductor supervision to `AgentCoordinator`; legacy false `recovery-blocked` chat runs are repaired to `running` without emitting another failure event.

Daemon startup keeps daemon-owned cron jobs paused while it restores native agent supervision and schedules persisted workflow executions without awaiting their terminal results. After retained agents and workflow runs are supervised, pending trigger-dispatch intents are reconciled and only then are future cron callbacks activated. Once configuration, durable storage, plugins, routing, and workflow definitions are loaded, the versioned control plane begins serving the current durable projection even while `/health` still reports `recovering`; retained native workers can therefore use Symphony coordination tools during their own reattachment. Readiness means startup reconciliation has completed—not that every recovered job has finished—so bootstrap, logs, observation, steering, and cancellation remain usable throughout long-running work. Terminal workflow promises stay registered in the executor and settle the original run later. Workflow supervision follows the authoritative agent record across every terminal boundary—including cancellation escalation, interruption, and loss—and does not depend on a driver-specific terminal event arriving afterward. A missing pinned revision is explicitly marked recovery-blocked and is never substituted or replayed.

The durable event log is also the outbox for chat transcript projection. ChatService checkpoints a monotonic projector cursor; each conversation-message mutation, its `chat.message.updated` notification, and the source-cursor advance share one SQLite transaction. Startup replays through a fixed pre-recovery high-water before closing genuinely interrupted streams, so a daemon failure after native output commits but before the browser-facing message commits cannot truncate the answer permanently. Installations created before the cursor existed adopt their historical high-water without replaying old chats, after first repairing any unmistakably terminal conductor that still has a streaming message and durable final output.

Workflow cancellation persists the run-level intent before asynchronously fanning cancellation out to every active agent in that run. The same fan-out is reissued from durable intent during recovery, so a daemon failure between accepting the command and reaching a native session cannot silently revive the workflow. Terminal workflow records are immutable execution receipts: later cancellation requests do not rewrite them, and reuse of their run ID returns the recorded result without replaying any step.

For chat follow-ups, the user message ID is also the runtime follow-up attempt ID. The chat-turn receipt and agent follow-up ledger can therefore be reconciled after a crash: a matching queued, dispatching, delivered, or settled attempt proves the accepted turn remains under durable supervision, while a missing or mismatched attempt fails closed as outcome-unknown and is never resent under a new identity.

Direct `agent.message` commands use the command idempotency key as the runtime attempt ID. A retained-session follow-up is durably queued under that identity, while active-turn steering records its intent before calling the native harness and records the native receipt afterward. If the daemon dies after a follow-up is accepted or after steering is acknowledged, an exact retry reconstructs the original command receipt without sending the instruction again. A steering intent left at the pre-acknowledgement boundary becomes explicitly outcome-unknown on recovery and is never replayed speculatively.

A steering delivery failure is scoped to that steering attempt. It does not terminalize the already-running agent or discard its native session, because only a native terminal event can settle the supervised turn. The attempt remains outcome-unknown and non-replayable while the original turn continues to completion, failure, or cancellation.

Native output frames are durable evidence but are not terminal authority. Symphony stores `output.completed` immediately and validates the requested schema only after `run.completed` confirms success. If the harness instead reports `run.failed`, the native/provider error remains the agent's primary failure; any invalid partial output is attached to the failure event only as a secondary `outputValidationError` diagnostic. This preserves causal debugging evidence when a provider emits an empty or partial output immediately before its terminal error.

Structured UI presentation derives its conversation-message identity from the command idempotency key. If the message commits but its command acknowledgement is lost, an exact retry reconstructs the original receipt from the durable message instead of appending a duplicate card.

Workflow cancellation persists `cancelRequested` before native fan-out. If the daemon loses only the API command acknowledgement, retrying the original key reconstructs the receipt and safely resumes cancellation propagation; a crash between receipt claim and intent persistence can therefore no longer leave the workflow running behind a permanent ambiguity response.

Direct agent cancellation follows the same recovery rule. An unfinished command receipt safely re-enters the bounded cancellation lifecycle, which is itself terminal-state and in-flight deduplicated, then settles the original receipt; it never requires the caller to invent a new key that could split cancellation authority.

Conductor replacement is a durable two-phase operation. The chat thread's new conductor pointer and an identity-bound `agent-session-retirement:*` intent commit in the same SQLite transaction, before native termination begins. If the daemon exits before the close is acknowledged, startup reattaches the exact recorded native session and retries retirement. Recovery bounds that provider call by the configured recovery deadline: a hung harness leaves the exact intent pending with explicit failure evidence and cannot keep the daemon unready forever. A missing or mismatched session likewise remains pending; Symphony never reports an unproven session as retired.

When triggers are enabled, registering a new workflow revision atomically replaces that workflow's in-memory cron registrations. Older revision schedules are stopped before the new revision becomes active, preventing duplicate or stale scheduled runs while already-started runs remain pinned to their original immutable revision. Startup rebuilds schedules from the latest workflow revisions in SQLite, including workflows registered only through the API, but keeps them paused until pending occurrences have recovered. An interrupted `workflow.register` acknowledgement is reconciled by content hash and reactivates the stored schedule without creating another revision or cron job.

This is why the SQLite state exists. It is not a knowledge base, vector store, or replacement transcript. It prevents duplicate side effects and reconstructs orchestration state.

## Observation

Drivers tee structured native events into the local event stream. `observe_agent` summarizes this recorded evidence without sending a message into the worker session. Claims retain event IDs. The default OpenRouter observer model is configurable, and deterministic observation remains available when no key exists.

Agent chat transcripts capture a fixed event high-water cursor and paginate through all matching evidence before projection, so a long session cannot freeze at its oldest 10,000 events. Model-generated and deterministic observations remain deliberately bounded, but select the newest 10,000 events rather than the oldest.

## Routing

The conductor supplies intent, not a vendor recommendation. The router:

1. asks native drivers which models are actually available;
2. enriches matching entries with the current OpenRouter catalog;
3. applies local/plugin catalog overrides;
4. filters for explicit harness/model and requirements;
5. presents anonymous candidate text to the configured reranker;
6. records every candidate, score, catalog snapshot, and selection.

OpenRouter's current official APIs expose [`GET /api/v1/models`](https://openrouter.ai/docs/api/api-reference/models/get-models) and [`POST /api/v1/rerank`](https://openrouter.ai/docs/api/api-reference/rerank/create-rerank). Symphony uses only pricing/context/capability data plus the explicitly selected Artificial Analysis and Design Arena fields. It does not use throughput or synthetic benchmark collections as routing truth.

When reranking is unavailable, Symphony labels the trace `neutral-lexical`; it never claims that a reranker selected the model.

## Local data flow for the frontend

The frontend should not mirror the database or poll hundreds of agents. It starts with one `/v1/bootstrap` projection and then consumes `/v1/events` with the last committed cursor. TanStack Query can own server snapshots; a small reducer can apply events to in-memory projections. Local storage may retain a client outbox containing an unsent turn's stable message ID and exact payload so a reload can reconcile before retrying; the daemon's thread and turn receipts remain authoritative. IndexedDB is optional only as an offline display cache. Neither browser store may become orchestration authority.

Projection activity and lifecycle settlement are separate facts. Loaders animate only for queued or actively running work. A retained native session in `idle` may bound the current turn without animation, while `waiting` remains nonterminal because it can represent a durably queued follow-up; graph progress and trace spans must therefore stay open until authoritative settlement rather than inferring completion from a still loader.
