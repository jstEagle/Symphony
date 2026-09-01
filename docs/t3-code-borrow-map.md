# T3 Code borrow map for Symphony

## Audit record

This is a source audit, not a product integration. T3 Code was cloned outside
the Symphony checkout into `/tmp/t3-code-audit.VptaQy/t3code`; the clone was
clean at audit time.

- Upstream: [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
- Audited commit: [`85b656ff300f71060ad6305c7e1e29a72b442ce9`](https://github.com/pingdotgg/t3code/commit/85b656ff300f71060ad6305c7e1e29a72b442ce9)
- Commit date: 2026-08-31 (the current upstream tip at the time of the audit)
- License: [MIT License](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/LICENSE), copyright T3 Tools Inc. 2026
- Symphony checkout inspected: `f41c2d33b5283155b248e2178024a32735e0ffa5`
- Scope rule: no T3 code was copied, vendored, committed, or pushed. Every
  upstream link below is pinned to the audited commit.

The labels below are deliberately strict:

- **copy-with-attribution candidate** means a small, generic implementation
  may be copied after a license/header review and a Symphony-specific test
  pass. It does not mean that the surrounding T3 model is accepted.
- **adapt conceptually** means the design is useful, but the code or data
  model is too coupled to T3's thread/project/server assumptions for a direct
  import.
- **reject because it conflicts with Symphony's objective-first boundary**
  means the pattern makes a conversation/thread, provider process, or UI
  selection authoritative where Symphony must make the objective aggregate,
  workflow frontier, policy grant, and durable worker execution state
  authoritative.

Symphony's current boundary remains the decision filter: the daemon owns the
objective/workflow graph, aggregate/frontier convergence, policy and lifecycle
state; a native harness owns its own agent loop, tools, auth, context, and
transcript; the worker-host provides durable local-process continuity. A T3
pattern is therefore only useful if it can be made a projection or execution
primitive without moving authority back into a thread UI or provider session.

## Findings from the source

### 1. Daemon/server authority and event model

T3 has a strong, explicit server boundary. Its server owns providers,
terminals, Git, and filesystem access, while clients use authenticated RPC.
The implementation is an event-sourced command path: an unbounded command
queue is serialized by `OrchestrationEngine`; a pure decider produces events;
one transaction appends events, projects them, persists the projection, and
writes an idempotent command receipt; committed events are then published.
On a failed dispatch, the engine rereads persisted events after the starting
sequence and reconciles its in-memory read model. The relevant implementation
and contract are [OrchestrationEngine.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/Layers/OrchestrationEngine.ts), [decider.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/decider.ts), [projector.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/projector.ts), [OrchestrationEventStore.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/persistence/Layers/OrchestrationEventStore.ts), [OrchestrationCommandReceipts.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts), [ProjectionPipeline.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/Layers/ProjectionPipeline.ts), and the public event/RPC schemas in [orchestration.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/contracts/src/orchestration.ts) and [rpc.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/contracts/src/rpc.ts).

| T3 pattern | Classification | Symphony reading |
| --- | --- | --- |
| Transactional append → projection → receipt → publish, plus reread-after-failure | **adapt conceptually** | The sequencing and receipt invariant are valuable for objective commands, but T3's aggregate selector maps almost every command to a `thread` aggregate. Symphony must key the equivalent ledger by objective/workflow/attempt and include frontier and policy-version identity. |
| T3's `OrchestrationEngine` and thread/project decider/projector as a drop-in authority | **reject because it conflicts with Symphony's objective-first boundary** | Direct adoption would make T3's thread lifecycle and UI command vocabulary the system of record. Reuse the invariant, not the aggregate schema. |
| Drainable queue/worker with an explicit drain operation | **copy-with-attribution candidate** | [DrainableWorker.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/shared/src/DrainableWorker.ts) is a small generic primitive for orderly shutdown and startup barriers. If copied, retain the MIT notice and add objective/attempt labels at the caller boundary. |
| Separate event-sourced domain events from provider-runtime events | **adapt conceptually** | This is a useful two-stream seam. Symphony should preserve it while making the objective aggregate the join point, rather than projecting provider activity directly into a conversational thread. |

T3's own internals documentation confirms the server boundary and the exact
event path in [internals/overview.md](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/docs/internals/overview.md). This is source-backed evidence of a coherent daemon, but it is not evidence that T3's model solves objective aggregate/frontier convergence.

### 2. Provider adapters, event normalization, and tool-part parsing

The provider SPI is intentionally plain data rather than one singleton Effect
service. A driver declares a typed config schema and environment requirements;
the registry materializes an isolated, scoped `ProviderInstance`. The adapter
contract covers start/send/interrupt/approval/user-input/stop/read/rollback,
plus one canonical runtime event stream. T3 ships Codex, Claude, Cursor, Grok,
and OpenCode through [builtInDrivers.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/builtInDrivers.ts), [ProviderDriver.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/ProviderDriver.ts), [ProviderAdapter.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/Services/ProviderAdapter.ts), and [ProviderInstanceRegistryLive.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts). The provider overview also documents the separation in [internals/providers.md](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/docs/internals/providers.md).

The cross-provider event vocabulary is unusually concrete. [providerRuntime.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/contracts/src/providerRuntime.ts) defines session/thread/turn/item/content/request/task/tool/error events, typed raw-source provenance, canonical item/request kinds, and bounded state dimensions. ACP parsing in [AcpRuntimeModel.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/acp/AcpRuntimeModel.ts) handles plan updates, tool-call state merging, command extraction, replay markers, malformed payloads, and an 8,000-character retained tail for cumulative terminal output. [AcpCoreRuntimeEvents.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts) maps permissions, tool lifecycle, plan, and assistant deltas into that canonical stream. [ProviderRuntimeIngestion.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts) then coalesces/buffers assistant text, flushes at approval/input boundaries, projects tool activities, tracks task liveness, and dispatches domain commands.

| T3 pattern | Classification | Symphony reading |
| --- | --- | --- |
| Plain provider-driver SPI with per-instance typed config, scoped resources, and a canonical `streamEvents` boundary | **adapt conceptually** | The boundary is a good fit for native harness adapters, but Symphony's adapter output must carry objective ID, attempt ID, workflow phase, authority grant, and worker-host continuity identity. Do not import T3's provider names or config envelope. |
| ACP parser and canonical tool/permission event helpers, including output bounds and replay detection | **copy-with-attribution candidate** | Small pure helpers in [AcpRuntimeModel.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/acp/AcpRuntimeModel.ts) and [AcpCoreRuntimeEvents.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts) are plausible candidates once their event envelope is changed to Symphony's objective/attempt identity. Copying requires the MIT attribution; preserve provider raw payloads only under explicit retention/secret policy. |
| Full T3 provider adapters (Codex/Claude/Cursor/Grok/OpenCode) | **reject because it conflicts with Symphony's objective-first boundary** | These adapters own T3 sessions, T3 thread IDs, and T3-specific approval semantics. Symphony should speak to native harnesses through its own worker-host/adapters and project only the evidence needed by the objective aggregate. |
| Direct `ProviderRuntimeIngestion` projection into messages, activities, and thread status | **adapt conceptually** | The buffering/coalescing and lifecycle guard are useful. The direct projection target is not: objective progress, frontier evidence, and reviewable artifacts must remain distinct from conversational activity. |

### 3. Process and session lifecycle/recovery

T3 has two different recovery stories. [ProcessRunner.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/processRunner.ts) is a bounded one-shot process utility: typed spawn/stdin/read/timeout/output-limit errors, a 60-second default timeout, and an 8 MiB default output cap. Provider sessions are scope-owned children. [CodexSessionRuntime.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/Layers/CodexSessionRuntime.ts) launches `codex app-server`, resumes with a persisted provider thread ID when possible, and falls back to a fresh thread when resume fails. [OpenCodeAdapter.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/Layers/OpenCodeAdapter.ts) re-adopts an OpenCode session ID, probes the directory, forks on a directory mismatch, and has bounded recovery fibers for lost prompt/status responses.

The durable directory/reaper pair, [ProviderSessionRuntime.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/persistence/ProviderSessionRuntime.ts), [ProviderSessionDirectory.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/Layers/ProviderSessionDirectory.ts), and [ProviderSessionReaper.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/Layers/ProviderSessionReaper.ts), persist provider bindings and reap idle sessions. On server restart, however, [serverRuntimeStartup.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/serverRuntimeStartup.ts) finds projected running sessions without live processes, marks them stopped in the directory, and projects an error telling the user to send a new message. That is explicit and safe, but it is not process adoption or output replay.

| T3 pattern | Classification | Symphony reading |
| --- | --- | --- |
| Typed bounded `ProcessRunner` | **copy-with-attribution candidate** | Useful for short-lived Git/setup/probe commands if Symphony does not already have an equivalent. It must remain subordinate to worker-host process supervision for long-running agents. |
| Scope-owned provider process with provider-ID resume and fresh-start fallback | **reject because it conflicts with Symphony's objective-first boundary** | A provider session is not the authoritative execution record. Restarting into a new conversation can lose objective evidence, leases, or output. Symphony's worker-host must own adoption/replay and report an explicit terminal outcome to the daemon. |
| Session directory, idle reaper, and bounded in-session recovery fibers | **adapt conceptually** | The lease/idle/recovery ideas can inform worker-host lifecycle. They need durable attempt identity, host ownership, replay cursor, cancellation receipt, and health/graph/lease/cursor checks before an attempt is considered recovered. |

### 4. Worktree and project selection

T3's VCS core provides real Git behavior rather than UI-only state. [GitVcsDriverCore.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/vcs/GitVcsDriverCore.ts) creates a sanitized branch-derived worktree path, runs `git worktree add`, updates submodules, configures a base ref, and tolerates already-gone/pruned worktrees during removal. [GitManager.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/git/GitManager.ts) prepares pull-request threads by reusing or creating worktrees, checking dirty/root conflicts, fetching the PR head, and running setup scripts. [ProviderCommandReactor.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts) recreates a missing thread worktree before a later provider turn. Project metadata loading is a best-effort `t3.json` reader in [T3ProjectFileLoader.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/project/T3ProjectFileLoader.ts).

The web branch toolbar and new-thread hook let a user choose `local` versus
`worktree`, branch, and a previous worktree. See [BranchToolbar.logic.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/BranchToolbar.logic.ts) and [useHandleNewThread.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/hooks/useHandleNewThread.ts).

| T3 pattern | Classification | Symphony reading |
| --- | --- | --- |
| Git worktree create/reuse/prune and PR checkout conflict handling | **adapt conceptually** | The Git edge cases are valuable. Symphony should derive a workspace grant from the objective/frontier and record the exact path/ref/checkpoint in the aggregate; a thread cannot freely change the grant. |
| User-selected local/worktree/branch as thread creation state | **reject because it conflicts with Symphony's objective-first boundary** | A UI choice can be an input to a policy-authorized objective command, never the authority that decides where an objective executes or which frontier it may mutate. |
| Best-effort project config loader | **adapt conceptually** | The tolerant parse/error behavior is useful, but Symphony config must be non-secret file configuration and must not silently replace policy or workspace ownership. |

### 5. Terminal, diff, and file-change UI

T3 keeps terminal and filesystem execution on the server and exposes typed
RPC. Its web client has a terminal drawer and state/focus helpers in
[ThreadTerminalDrawer.tsx](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/ThreadTerminalDrawer.tsx), [terminalSession.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/state/terminalSession.ts), and [terminal.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/state/terminal.ts). File browsing/preview is in [FileBrowserPanel.tsx](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/files/FileBrowserPanel.tsx), [FilePreviewPanel.tsx](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/files/FilePreviewPanel.tsx), and [filesystem.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/state/filesystem.ts).

Diffs are checkpoint/turn based, with reusable tree/presentation components:
[DiffPanel.tsx](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/DiffPanel.tsx), [DiffPanelShell.tsx](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/DiffPanelShell.tsx), [ChangedFilesTree.tsx](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/chat/ChangedFilesTree.tsx), [StyledDiffCodeView.tsx](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/diffs/StyledDiffCodeView.tsx), [AnnotatableCodeView.tsx](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/diffs/AnnotatableCodeView.tsx), [checkpointDiff.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/state/checkpointDiff.ts), and [turnDiffTree.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/lib/turnDiffTree.ts). These are presentation/read-model consumers, not authority.

| T3 pattern | Classification | Symphony reading |
| --- | --- | --- |
| Typed terminal session state and reconnectable terminal subscription | **adapt conceptually** | The interaction model is useful for a client, but terminal ownership and replay must follow the worker-host/daemon contract, not a T3 thread session. |
| Diff panel, changed-file tree, annotation, and file preview components | **adapt conceptually** | Borrow the presentation/virtualization ideas only after Symphony has a converged objective artifact/checkpoint projection. Displaying a thread's “changed files” is not itself objective completion evidence. |
| Direct T3 terminal/filesystem RPC and thread-scoped drawer | **reject because it conflicts with Symphony's objective-first boundary** | A client must not gain an implicit shell or filesystem authority from the selected conversation. Every operation needs an objective/workspace grant and explicit side-effect class. |

### 6. Command palette and thread sidebar

The command palette is a well-factored pure logic layer. [CommandPalette.logic.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/CommandPalette.logic.ts) separates command, file, and content-search overlays; supports `>` action filtering; ranks exact/prefix/contains matches; and builds project/thread action items. The UI is in [CommandPalette.tsx](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/CommandPalette.tsx), [CommandPaletteContent.tsx](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/CommandPaletteContent.tsx), and [CommandPaletteResults.tsx](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/CommandPaletteResults.tsx).

The sidebar uses dnd-kit sorting, status priority, pinned/settled/snoozed
sections, adjacent-thread traversal, and a deliberately small three-thread
detail prewarm limit. The pure logic is in [Sidebar.logic.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/Sidebar.logic.ts), the renderer in [Sidebar.tsx](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/Sidebar.tsx), and the behavior contract in [thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/docs/user/thread-sidebar.md).

| T3 pattern | Classification | Symphony reading |
| --- | --- | --- |
| Pure command-palette ranking/reducer and overlay state machine | **copy-with-attribution candidate** | The pure ranking/reducer shape can be reused after action IDs are made Symphony objective/workflow commands. Keep destructive actions behind the daemon's command/approval contract. |
| Sidebar status roll-up, pinned ordering, settled/snoozed groups, and small prewarm budget | **adapt conceptually** | Status precedence and bounded prewarm are useful client discipline. The rows should represent objectives/frontier state, not make a thread's title/session the authority. |
| Thread/project action vocabulary and direct thread sidebar as the primary navigation model | **reject because it conflicts with Symphony's objective-first boundary** | It encourages “pick a conversation, then operate” rather than “inspect objective state, then issue an authorized operation.” A thread can remain a view/link, not the root entity. |

### 7. Streaming/tool-part projection

T3's event path deliberately distinguishes raw provider payload from a
canonical, bounded event and then from a client activity projection. In
[ProviderRuntimeIngestion.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts), assistant text can be buffered up to 24,000 characters and flushed at approval/user-input/turn boundaries; tool updates are projected so cumulative output is not persisted O(N²); terminal-like ACP output is bounded/coalesced in [AcpRuntimeModel.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/acp/AcpRuntimeModel.ts); and raw source/method/payload are retained for diagnostics in the canonical event contract.

| T3 pattern | Classification | Symphony reading |
| --- | --- | --- |
| Raw-source provenance + typed canonical event + bounded projection | **copy-with-attribution candidate** | This is a strong normalization pattern for Symphony's adapter/worker-host boundary. Add objective/attempt/phase/lease IDs and classify each event as progress, evidence, approval, artifact, or diagnostic before aggregate projection. |
| T3's message-segment and activity folding keyed by thread/turn/item | **adapt conceptually** | The segment/coalescing algorithms are useful, but keys must be objective attempt/frontier scoped. A provider item ID cannot be allowed to advance the objective frontier by itself. |
| Treating assistant completion/tool activity as the primary work record | **reject because it conflicts with Symphony's objective-first boundary** | Streaming UI is an observation surface. Completion requires aggregate convergence and verified objective evidence, not a final assistant item. |

### 8. Remote clients and connection runtime

T3 has one server execution boundary with a remote connection layer. Its client
target model supports primary, bearer, relay, and SSH connections in [model.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/connection/model.ts). [supervisor.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/connection/supervisor.ts) is the sole retry owner: it tracks desired/network/phase/generation, uses bounded backoff, treats authentication/configuration as blocked, and supports wake probes. [session.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/rpc/session.ts) disables transport retries and exposes ready/probe/closed signals; [client.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/rpc/client.ts) wraps unary calls, streams, and dynamic resubscription. Web composes the layers in [runtime.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/connection/runtime.ts), while SSH tunnelling is in [tunnel.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/ssh/src/tunnel.ts). T3's design rationale is documented in [internals/remote.md](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/docs/internals/remote.md) and [internals/connection-runtime.md](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/docs/internals/connection-runtime.md).

The client state layer also separates cached shell/detail data, sequence
watermarks, pagination, and reconnect resubscription. Representative sources
are [threads.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/state/threads.ts), [threadDetail.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/state/threadDetail.ts), [terminalSession.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/state/terminalSession.ts), [checkpointDiff.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/state/checkpointDiff.ts), and [filesystem.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/state/filesystem.ts).

| T3 pattern | Classification | Symphony reading |
| --- | --- | --- |
| One supervisor owning retry/backoff, reconnect, wakeup, and blocked states | **adapt conceptually** | The single retry owner and explicit disconnected/synchronizing/ready projection are good client patterns. They must reconnect to objective snapshots and worker-host cursors, not T3 thread snapshots. |
| Client cache watermarks and dynamic subscription resubscription | **copy-with-attribution candidate** | The state-machine shape can be reused for objective read models if event sequence and cursor semantics match the daemon contract. Preserve explicit stale/offline states; never silently fabricate live data. |
| T3 hosted pairing/relay/SSH connection model as Symphony's remote authority | **reject because it conflicts with Symphony's objective-first boundary** | T3's remote model transports a T3 server. Symphony's remote concern is daemon ↔ worker-host continuity and an objective-scoped command/evidence stream; copying pairing or relay assumptions would blur those authorities. |

## Tests audited

The test suite is broad and mostly unit/contract-level. It is useful evidence
of invariants inside one runtime, not proof of surviving external provider
processes or objective completion. Representative tests and the pattern to
borrow are:

| Area | Tests inspected | What they establish |
| --- | --- | --- |
| Command/event consistency | [OrchestrationEngine.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts), [ProjectionPipeline.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts), [OrchestrationEventStore.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/persistence/Layers/OrchestrationEventStore.test.ts) | receipts, sequence/projector behavior, persistence boundaries, and failure reconciliation; adapt the test style to objective aggregate/frontier commands. |
| Runtime ingestion | [ProviderRuntimeIngestion.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts), [ProviderRuntimeIngestion.activity.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.activity.test.ts), [ProviderRuntimeIngestion.approval.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.approval.test.ts) | buffering, lifecycle guards, request/approval projection, and activity folding; copy the boundary tests but add worker-host replay and objective evidence assertions. |
| ACP/tool parsing | [AcpRuntimeModel.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/acp/AcpRuntimeModel.test.ts), [AcpCoreRuntimeEvents.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/acp/AcpCoreRuntimeEvents.test.ts) | typed tool/permission/plan/content mapping, malformed state handling, replay detection, and output bounds; strong candidates for pure parser test fixtures. |
| Provider process lifecycle | [CodexSessionRuntime.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/Layers/CodexSessionRuntime.test.ts), [OpenCodeAdapter.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/Layers/OpenCodeAdapter.test.ts), [ProviderSessionReaper.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/Layers/ProviderSessionReaper.test.ts) | resume/fallback, interrupts, cleanup, pending request recovery, and idle reaping in a T3 scope; not enough for cross-daemon host adoption. |
| Workspace/VCS | [GitVcsDriverCore.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/vcs/GitVcsDriverCore.test.ts), [GitManager.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/git/GitManager.test.ts), [ProviderCommandReactor.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts) | worktree/ref conflict, cleanup, setup, and missing-worktree recovery; adapt after objective workspace grants exist. |
| Client connection/state | [supervisor.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/connection/supervisor.test.ts), [session.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/rpc/session.test.ts), [threads-sync.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/state/threads-sync.test.ts), [terminalSession.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/state/terminalSession.test.ts), [filesystem.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/client-runtime/src/state/filesystem.test.ts) | retry, offline/wakeup, reconnect, cache hydration, cursor sync, and terminal/filesystem state; reuse state-machine testing patterns, not the T3 entity vocabulary. |
| UI behavior | [CommandPalette.logic.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/CommandPalette.logic.test.ts), [Sidebar.logic.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/Sidebar.logic.test.ts), [ChangedFilesTree.test.tsx](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/chat/ChangedFilesTree.test.tsx), [ThreadTerminalDrawer.test.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/web/src/components/ThreadTerminalDrawer.test.ts) | ranking, grouping, status precedence, changed-file rendering, and terminal interactions; borrow only as projection/UI tests after the objective read model settles. |

## Prioritized imports/refactors — only after aggregate/frontier convergence

The ordering below is intentionally gated. “Convergence” means Symphony has a
durable objective aggregate and workflow frontier with stable objective,
attempt, phase, worker-host, policy-snapshot, workspace-grant, and evidence
identities, plus explicit completion/recovery semantics. Until then, these are
not implementation work.

1. **P0 — strengthen the objective command ledger.** Adapt T3's
   append/project/receipt/publish sequencing from [OrchestrationEngine.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/Layers/OrchestrationEngine.ts) and [decider.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/decider.ts) only after replacing the thread aggregate with Symphony objective/workflow aggregates and adding frontier/policy/workspace invariants. Add crash/replay tests before any UI borrow.
2. **P0 — make the worker-host event boundary canonical.** Adapt the bounded
   raw → canonical → projected stream from [AcpRuntimeModel.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/acp/AcpRuntimeModel.ts), [AcpCoreRuntimeEvents.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts), and [ProviderRuntimeIngestion.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts). Require objective/attempt/lease/cursor identity and classify evidence separately from display activity.
3. **P1 — import small generic primitives.** If Symphony lacks equivalents,
   copy [DrainableWorker.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/packages/shared/src/DrainableWorker.ts) and bounded pieces of [ProcessRunner.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/processRunner.ts), retaining the T3 MIT copyright notice and recording the pinned source commit. Keep long-lived agent processes under worker-host supervision.
4. **P1 — adapt VCS algorithms behind workspace grants.** Bring over the
   tested edge cases from [GitVcsDriverCore.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/vcs/GitVcsDriverCore.ts) and [GitManager.ts](https://github.com/pingdotgg/t3code/blob/85b656ff300f71060ad6305c7e1e29a72b442ce9/apps/server/src/git/GitManager.ts) only once workspace ownership/checkpoints are aggregate state. Do not import the thread-selected local/worktree toolbar semantics.
5. **P2 — build client projections.** Adapt T3's cursor-aware connection/state
   supervisor (`supervisor.ts`, `session.ts`, `client.ts`, and `threads.ts`) to objective snapshots and worker-host cursors. Then consider the pure command-palette ranking and sidebar status/prewarm logic as UI consumers. Do not let either surface dispatch a side effect outside the daemon command contract.
6. **P3 — borrow diff/terminal presentation.** After objective artifacts and
   checkpoint evidence are stable, adapt `DiffPanel*`, `ChangedFilesTree`,
   `ThreadTerminalDrawer`, and file preview patterns. Their inputs should be
   read-only objective projections with explicit unavailable/stale states.

Explicitly do **not** import T3's `OrchestrationEngine` schema as-is, its full
provider adapters or provider-session resume behavior, its direct thread
sidebar/action model, or its hosted relay/pairing authority. Those are the
patterns most likely to make Symphony converge around a conversation instead
of around an objective and its verified frontier.

## Verification record

- `git -C /tmp/t3-code-audit.VptaQy/t3code status --short` was empty before
  inspection.
- Every upstream source path linked in this document was checked with
  `test -f` against that clone; the only correction during the audit was using
  the actual path `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
  (not a provider-layer path).
- `git -C /Users/justus/Documents/Programming/Symphony diff --no-index --check
  /dev/null docs/t3-code-borrow-map.md` produced no whitespace errors (exit 1
  is expected because the new file differs from `/dev/null`); a trailing
  whitespace scan was also clean.
- No Symphony product source was changed. No commit or push was performed.
