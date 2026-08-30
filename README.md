# Symphony

Symphony is a local-first orchestration harness for native coding agents. You talk to one conductor; it can create a tree of focused workers in Codex, Claude Code, Cursor, OpenCode, Pi, or any configured ACP agent, observe them without interrupting them, steer them, and execute durable schema-driven workflows.

The project deliberately does not replace the native harnesses or build a repository RAG system. Each harness keeps its own loop, tools, authentication, context management, and transcript. Symphony owns only the cross-harness graph, workflow state, event projection, model routing, and cost evidence.

The backend and local chat surface are integrated. `apps/web` is a familiar assistant-style command surface over the daemon: chat history, grouped conversations, native-harness settings, live agent state, semantic activity, attachments, cost evidence, and agent controls all project the daemon's authoritative state.

## What works

- One `AgentWorkOrder` primitive with a concise objective, native harness/model, `full-access` or `read-only`, explicit inputs, and a required JSON output schema.
- Parent/child agent graph with an optional maximum depth. At a finite limit, lowest-level agents do not receive `create_agent`; the limit can also be disabled.
- Native adapters for Codex App Server, Claude Agent SDK, Cursor SDK (local and cloud), OpenCode SDK/server, Pi RPC plus a Pi extension, and generic ACP.
- Cross-agent tools: `list_agents`, `create_agent`, `send_message`, `observe_agent`, and `cancel_agent`.
- Passive observation at `tldr`, `paragraph`, or `full` granularity using recorded native events. A cheap OpenRouter model is optional; deterministic observation is the fallback.
- JSON and TypeScript workflows with sequence, parallel, conditional, `while`, typed agent outputs, manual/cron triggers, idempotent attempts, and restart recovery.
- Neutral model routing. The conductor describes intent; Symphony anonymizes eligible model cards and uses an OpenRouter reranker, with a deterministic lexical fallback.
- Live native model catalogs enriched from OpenRouter with current descriptions, context, token pricing, Artificial Analysis intelligence/coding/agentic indices, and Design Arena ELO. Locally configured catalogs and trusted plugins can add or override facts.
- Provider/harness usage normalization plus router, observer, and UI-utility overhead, with cost totals that keep unknown cost separate rather than silently treating it as zero.
- A local SQLite authority in WAL mode, plus a cursor-based Server-Sent Events stream for resumable UI projections.
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

Open `http://127.0.0.1:3210` after the production build. For development, run `pnpm dev` once and open `http://127.0.0.1:3000`. That command watches the daemon and the TanStack UI together; plugins retain last-known-good hot reload, and `theme.json` is re-read live. The separate `pnpm dev:daemon` and `pnpm dev:web` commands remain available for debugging either process.

The daemon API listens on `http://127.0.0.1:3210`. Useful endpoints:

```bash
curl http://127.0.0.1:3210/health
curl http://127.0.0.1:3210/v1/drivers
curl http://127.0.0.1:3210/v1/models
curl http://127.0.0.1:3210/v1/bootstrap
curl http://127.0.0.1:3210/v1/settings
```

Run the full local verification suite with:

```bash
pnpm check
```

## Configuration and secrets

All non-secret settings live in [`symphony.config.json`](./symphony.config.json). The sample config selects the conductor's native harness/model, binds only to localhost, permits up to three delegation levels and eight concurrent agents, defaults to `full-access`, and uses `cohere/rerank-v3.5` for neutral reranking. The conductor can be changed directly from the composer or Settings; agent limits can be finite or unlimited. Small UI semantics such as first-message chat titles use the separately configured `uiUtilities` model and fall back immediately to deterministic local behavior when OpenRouter is unavailable.

Secrets never belong in that file or SQLite. On macOS, store them in Keychain:

```bash
pnpm symphony -- secret set openrouter.apiKey '<key>'
pnpm symphony -- secret set cursor.apiKey '<key>'
```

Environment variables are also supported for headless use: `OPENROUTER_API_KEY`, `CURSOR_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY`.

Native user logins remain valid. For example, Claude Code and Codex can use their existing authenticated installations. Cursor's local login is checked with `cursor-agent status`; the open Settings panel refreshes native status every five seconds and also refreshes on window focus. Cursor Cloud can additionally use `CURSOR_API_KEY` or `Cursor.auth.login()`. Symphony never asks for a Cursor account password.

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

Symphony is open source under the [MIT License](./LICENSE). Contributions are welcome; read [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md) first.
