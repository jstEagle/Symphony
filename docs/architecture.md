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

Workflow revisions are immutable. Every run step has an idempotency key derived from the run, step, iteration, and attempt. Completed attempts replay their committed output. A running agent attempt records the logical agent and native session IDs so daemon startup can call the native resume operation. Cron occurrences and API commands also have unique durable keys.

This is why the SQLite state exists. It is not a knowledge base, vector store, or replacement transcript. It prevents duplicate side effects and reconstructs orchestration state.

## Observation

Drivers tee structured native events into the local event stream. `observe_agent` summarizes this recorded evidence without sending a message into the worker session. Claims retain event IDs. The default OpenRouter observer model is configurable, and deterministic observation remains available when no key exists.

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

The frontend should not mirror the database or poll hundreds of agents. It starts with one `/v1/bootstrap` projection and then consumes `/v1/events` with the last committed cursor. TanStack Query can own server snapshots; a small reducer can apply events to in-memory projections. IndexedDB is optional only as an offline display cache. It must never become orchestration authority.
