# Symphony

Symphony is a local-first orchestration harness for native coding agents. You talk to one conductor; it can create a tree of focused workers in Codex, Claude Code, Cursor, OpenCode, Pi, or any configured ACP agent, observe them without interrupting them, steer them, and execute durable schema-driven workflows.

The project deliberately does not replace the native harnesses or build a repository RAG system. Each harness keeps its own loop, tools, authentication, context management, and transcript. Symphony owns only the cross-harness graph, workflow state, event projection, model routing, and cost evidence.

The backend and local chat surface are integrated. `apps/web` is a familiar assistant-style command surface over the daemon: chat history, grouped conversations, native-harness settings, live agent state, semantic activity, attachments, cost evidence, and agent controls all project the daemon's authoritative state.

## What works

- One `AgentWorkOrder` primitive with a concise objective, native harness/model, `full-access` or `read-only`, explicit inputs, and a required JSON output schema.
- Parent/child agent graph with an optional maximum depth. At a finite limit, lowest-level agents do not receive `create_agent`; the limit can also be disabled.
- Native adapters for Codex App Server, Claude Agent SDK, Cursor SDK (local and cloud), OpenCode SDK/server, Pi RPC plus a Pi extension, and generic ACP.
- Cross-agent tools: `list_agents`, `create_agent`, `send_message`, `observe_agent`, `cancel_agent`, `register_workflow`, `list_workflows`, `run_workflow`, `cancel_run`, session logs, plugin tools, and idempotent structured UI presentation.
- Passive observation at `tldr`, `paragraph`, or `full` granularity using recorded native events. A cheap OpenRouter model is optional; deterministic observation is the fallback.
- JSON and TypeScript workflows with sequence, parallel, conditional, `while`, typed agent outputs, manual/cron triggers, idempotent attempts, and restart recovery.
- Neutral model routing. The conductor describes intent; Symphony anonymizes eligible model cards and uses an OpenRouter reranker, with a deterministic lexical fallback.
- Live native model catalogs enriched from OpenRouter with current descriptions, context, token pricing, Artificial Analysis intelligence/coding/agentic indices, and Design Arena ELO. Locally configured catalogs and trusted plugins can add or override facts.
- Provider/harness usage normalization plus router, observer, and UI-utility overhead, with cost totals that keep unknown cost separate rather than silently treating it as zero.
- A local SQLite authority in WAL mode, plus a cursor-based Server-Sent Events stream for resumable UI projections.
- Bounded native cancellation, process-group cleanup, recovery deadlines, and graceful shutdown that fail closed when a harness cannot prove its outcome.
- Pi-compatible trusted plugins with TypeScript hot reload and last-known-good rollback.
- A local assistant-ui chat surface with persistent threads, automatic titles, search, pinning, archive state, user-defined groups, text/code attachments, and restart-safe conversation continuation.
- Composer and Settings controls for the default conductor harness/model, default `full-access` or explicit `read-only`, maximum delegation depth, and concurrency. Depth and concurrency may be set to `null` for unlimited execution. Non-secret changes are atomically persisted to `symphony.config.json`.
- Per-conversation agent graph, compact semantic activity, passive observations, steering/cancellation, and attributed usage totals without dumping raw native event payloads into the primary chat.
- assistant-ui structured data and generative UI for diagrams, flow graphs, specifications, timelines, plans, subagent lists, progress, handoffs, schedules, checkpoints, recommendations, costs, and other allowlisted compositions. Run traces use react-o11y.
- Live native-harness health, authentication, installed/latest versions, and safe configured update actions in Settings.
- A root `theme.json` owns every rendered color token. Saved edits are reflected by the running UI without a rebuild.

## Quick start

Requirements: Node.js 24+, pnpm 11+, and at least one native harness authenticated on the machine.

```bash
pnpm install
pnpm build
pnpm symphony -- doctor
pnpm symphony -- start --no-open
```

Open `http://127.0.0.1:3000` after the production build. This is the full daemon-backed application, not a Vite preview. For development, run `pnpm dev` once and open `http://127.0.0.1:3001`; Vite proxies API traffic to the stable daemon on port `3000`. The UI keeps Vite HMR, while a frontend or shared-file edit cannot terminate long-running native work. Plugins retain last-known-good hot reload, and `theme.json` is re-read live. Use `pnpm dev:watch` only when actively changing daemon code and accepting supervised recovery between backend generations; `pnpm dev:daemon`, `pnpm dev:daemon:watch`, and `pnpm dev:web` remain available independently.

The daemon API and production UI listen on `http://127.0.0.1:3000`. Useful endpoints:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/v1/drivers
curl http://127.0.0.1:3000/v1/models
curl http://127.0.0.1:3000/v1/bootstrap
curl http://127.0.0.1:3000/v1/settings
```

Run the full local verification suite with:

```bash
pnpm check
```

## Configuration and secrets

All non-secret settings live in [`symphony.config.json`](./symphony.config.json). The sample config selects the conductor's native harness/model, binds only to localhost, leaves delegation depth and concurrency unlimited, defaults to `full-access`, and uses `cohere/rerank-v3.5` for neutral reranking. The conductor can be changed directly from the composer or Settings; either agent limit can be made finite. Small UI semantics such as first-message chat titles use the separately configured `uiUtilities` model and fall back immediately to deterministic local behavior when OpenRouter is unavailable. Semantic command-palette search is a separate explicit `uiUtilities.chatSearch.rerankEnabled` choice. When enabled it sends only a bounded, locally prefiltered set of recent chat text to the configured OpenRouter reranker, may incur provider cost, records a usage event, and caches only result IDs and scores; when disabled or unavailable, search remains entirely local and fuzzy.

Secrets never belong in that file or SQLite. On macOS, store them in Keychain:

```bash
printf %s "$OPENROUTER_API_KEY" | pnpm symphony -- secret set openrouter.apiKey --stdin
printf %s "$CURSOR_API_KEY" | pnpm symphony -- secret set cursor.apiKey --stdin
```

Secret values are never accepted as positional CLI arguments because process arguments may be visible to other local processes. `--stdin` removes exactly one final `LF` or `CRLF` contributed by a pipeline and preserves all other characters. To preserve a credential byte-for-byte as UTF-8 text, write it to a permission-restricted temporary file and use `pnpm symphony -- secret set <key> --file <path>`, then securely remove that file.

Environment variables are also supported for headless use: `OPENROUTER_API_KEY`, `CURSOR_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY`. A new headless daemon also requires a stable 32-byte root encoded as 64 lowercase hexadecimal characters in `SYMPHONY_DAEMON_SECRET`; keep the same value across restarts so retained agents and worker hosts remain adoptable.

Symphony-owned OpenCode services use per-agent HTTP Basic authentication. On macOS, the first owned-service doctor/start lazily creates a 32-byte base64url master in Keychain as `dev.symphony.opencode.serverMasterKey`. On headless or non-macOS hosts, provide the equivalent secret only through the daemon environment:

```sh
export SYMPHONY_OPENCODE_SERVICE_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
```

Keep that master stable while retained OpenCode services exist; retire them before rotating it. Symphony derives an isolated password from the master and agent ID, passes only that derived password to the owned child, and sends the matching static SDK `Authorization` header for HTTP and SSE. Neither the master, derived password, nor header may enter config, SQLite, leases, spools, events, or logs. `OPENCODE_API_KEY` is a separate provider credential. Reachable user-managed OpenCode endpoints remain external and receive no Symphony-generated authorization header.

Native user logins remain valid where the harness API shares that login, including Claude Code and Codex. Cursor is different: Symphony executes both local and cloud Cursor work through `@cursor/sdk`, whose documented credential store is separate from `cursor-agent` CLI login. Use the **Authenticate SDK** action in Settings (`Cursor.auth.login()`) or provide `CURSOR_API_KEY` / the `cursor.apiKey` Keychain secret. The CLI status is shown only as supplemental diagnostics and never makes the SDK harness appear runnable. The open Settings panel refreshes the authoritative SDK status every five seconds and on window focus. Symphony never asks for a Cursor account password or copies undocumented CLI credentials.

The non-secret CLI update commands and latest-version sources are configured under `harnessUpdates` in `symphony.config.json`. Settings only offers updates from that allowlist; commands are executed directly without a shell. App-bundled CLIs, such as Codex bundled with ChatGPT, are labelled as app-managed rather than overwritten.

## Workflow example

The workflow output schema is an engine boundary, not merely a prompt hint. Symphony validates the final value before committing a step, and loop conditions can only see committed outputs.

```ts
import { agent, defineWorkflow, whileLoop } from "@symphony/sdk";

export default defineWorkflow({
  id: "build-review-loop",
  name: "Build and independently review",
  mission: {
    statement: "Ship the requested feature as a coherent and reliable part of the product.",
    keyResults: ["Independent review scores at least 8/10"],
  },
  workspace: { path: process.cwd(), dirtyPolicy: "local-only" },
  output: "steps.review",
  steps: [
    whileLoop(
      "quality",
      { path: "steps.review.score", op: "lt", value: 8, default: 0 },
      [
        agent({
          id: "build",
          objective: "Build or improve the feature and verify the result.",
          harness: "auto",
          model: "auto",
          outputSchema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
            additionalProperties: false,
          },
        }),
        agent({
          id: "review",
          objective: "Review the finished feature against the mission and return a score.",
          permissions: "read-only",
          routing: { taskKind: "coding", prioritize: ["intelligence", "coding-success"] },
          outputSchema: {
            type: "object",
            properties: {
              score: { type: "number", minimum: 0, maximum: 10 },
              feedback: { type: "array", items: { type: "string" } },
            },
            required: ["score", "feedback"],
            additionalProperties: false,
          },
        }),
      ],
      5,
    ),
  ],
});
```

See [`examples/workflows/build-review-loop.workflow.ts`](./examples/workflows/build-review-loop.workflow.ts) and [the workflow guide](./docs/workflows.md).

Copy that file to `.symphony/workflows/` to have the daemon discover it. The plugin example under [`examples/plugins/release-review`](./examples/plugins/release-review) is deliberately not enabled by default: copy it into `.symphony/plugins/`, add its exact ID to `plugins.trusted`, and restart once. Subsequent source edits hot reload.

## Repository map

| Path | Purpose |
|---|---|
| `apps/daemon` | Local HTTP/SSE authority, chat service, recovery startup |
| `apps/cli` | `symphony` command |
| `apps/mcp` | Coordination tools injected into MCP-capable harnesses |
| `apps/web` | TanStack Start SPA chat UI (assistant-ui + DotMatrix) |
| `apps/worker-host` | External authenticated native-process host and bounded replay spool |
| `packages/protocol` | Public schemas and driver contracts |
| `packages/storage` | SQLite migrations and projections |
| `packages/drivers` | Native harness adapters and Pi coordination extension |
| `packages/runtime` | Agent graph, router, observer, cost normalization |
| `packages/workflow` | DSL, loader, compiler, executor, cron triggers |
| `packages/plugins` | Trusted Pi-compatible plugin host and hot reload |
| `packages/sdk` | Public workflow/plugin authoring surface |

## Why SQLite exists

SQLite is not “agent memory.” It is the minimum transaction boundary needed to answer four mechanical questions after a crash: which workflow revision was running, which step attempt already committed, which native session should be resumed, and which command/trigger occurrence must not be repeated. It also gives the UI a monotonic event cursor and makes cost provenance auditable. Source code, native harness transcripts, and model context stay where they already belong.

More detail: [architecture](./docs/architecture.md), [native harnesses](./docs/native-harnesses.md), [plugins](./docs/plugins.md), and [local API](./docs/api.md).

## Status and boundaries

The protocol, daemon, workflow engine, drivers, plugin host, CLI, tests, production build, and integrated TanStack Start UI are present. No credentials are stored in the repository or browser. Local doctor checks verify installed executables/SDKs and use native status commands where a harness exposes one; run-time provider failures are surfaced in the chat and inbox. Cursor Cloud still requires the user's Cursor authentication before it can run.

Durable orchestration state is not the same as a daemon-owned process surviving a daemon crash. Symphony reconciles persisted native sessions, never blindly replays an outcome-unknown prompt, and fails closed when continuity cannot be proved. Every directly owned native process has an owner-generation lease recording PID, process group, birth evidence, workspace grant, native IDs, and the last event cursor. Before native recovery, Symphony classifies an old lease as exited, strongly verified-but-orphaned, identity-mismatched, or unverified; it never signals a cross-generation PID whose birth identity is ambiguous or reused, and it never starts a duplicate adapter behind a verified live orphan.

`apps/worker-host` is the external-process continuity layer used by durable local adapters. It owns one native process group independently of the daemon, authenticates a single epoch-fenced controller over a private Unix socket, durably sequences stdout/stderr/terminal frames, replays unacknowledged output after controller loss, deduplicates mutating commands, and stops the worker rather than overwriting a full spool. Codex App Server, Pi RPC, and Symphony-owned OpenCode services use this host today. Their real daemon-`SIGKILL` acceptance tests prove the same host/native PID and native session are adopted without duplicate dispatch. Fresh owned OpenCode services receive private loopback ephemeral ports and derived Basic-auth credentials per agent, while historical retained leases keep their proven endpoint until retirement. OpenCode additionally reconciles its persisted native transcript, so a turn that finishes while the daemon is absent is imported exactly once after restart. Harnesses without a proven retained transport still use native resume where available and fail closed when an in-flight outcome cannot be established.

Symphony is open source under the [MIT License](./LICENSE). Contributions are welcome; read [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md) first.
