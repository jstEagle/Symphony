# Native harness adapters

Symphony keeps each harness vanilla. Drivers launch/resume native sessions, translate events, inject the coordination bridge, deliver supported steering/cancellation, and report usage.

| Harness | Integration | Resume / steer | Read-only behavior |
|---|---|---|---|
| Codex | App Server over JSONL stdio | Thread resume, turn steer/interrupt | App Server `read-only` sandbox and `never` approvals |
| Claude Code | Claude Agent SDK | Session resume; follow-ups queue at a safe boundary | Read/search/web allowlist, mutation/task tools removed, `dontAsk` |
| Cursor local | `@cursor/sdk` | `Agent.resume`, streamed runs | Local tool allowlist and SDK sandbox |
| Cursor Cloud | `@cursor/sdk` Cloud Agents | Durable agent/run resume | Explicit `read-only` is rejected because Cloud does not expose enforceable tool restrictions |
| OpenCode | SDK/server, SSE, and a per-agent dynamic MCP server | Durable sessions, async prompts, abort | Known mutation tools disabled; use a local sandbox for hostile code |
| Pi | RPC JSONL plus Symphony Pi extension | Native steer, follow-up, abort, session switch; completion waits for `agent_settled` | Pi `--tools` allowlist limits built-ins to read/search plus coordination |
| ACP | Version-pinned SDK client | Capability-dependent session resume/cancel | Permission requests are denied in read-only mode; conformance still depends on the ACP agent |

## Authentication

`symphony doctor` reports executable/SDK availability separately from authentication. A native driver confirms provider authentication only when it makes a provider-backed request. This distinction avoids showing a false “connected” state.

Cursor offers two safe paths:

- `CURSOR_API_KEY` / macOS Keychain for Cloud Agents and catalog/account calls;
- `Cursor.auth.login()` or an independently logged-in Cursor CLI for the user's native local state.

Cloud work must reference a remote repository and optional starting ref. Symphony rejects read-only Cursor Cloud work instead of weakening the requested boundary. Uncommitted local files are not silently uploaded.

## Event fidelity

Each stored driver event includes its harness and native event ID when available. Raw event payloads remain available to the UI and observer; normalized semantic kinds provide a common projection without erasing the native evidence.

Codex App Server behavior is based on OpenAI's official [App Server documentation](https://learn.chatgpt.com/docs/app-server). Cursor and the other SDKs are pinned in `packages/drivers/package.json`; update them deliberately with their conformance fixtures.
