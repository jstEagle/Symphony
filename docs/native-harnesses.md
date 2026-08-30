# Native harness adapters

Symphony keeps each harness vanilla. Drivers launch/resume native sessions, translate events, inject the coordination bridge, deliver supported steering/cancellation, and report usage.

| Harness | Integration | Resume / steer | Read-only behavior |
|---|---|---|---|
| Codex | App Server over worker-hosted JSONL stdio | Thread resume, retained in-flight transport, turn steer/interrupt | App Server `read-only` sandbox and `never` approvals |
| Claude Code | Claude Agent SDK | Session resume; follow-ups queue at a safe boundary | Read/search/web allowlist, mutation/task tools removed, `dontAsk` |
| Cursor local | `@cursor/sdk` | `Agent.resume`, streamed runs | Local tool allowlist and SDK sandbox |
| Cursor Cloud | `@cursor/sdk` Cloud Agents | Durable agent/run resume | Explicit `read-only` is rejected because Cloud does not expose enforceable tool restrictions |
| OpenCode | SDK/server, worker-hosted owned service, SSE, and a per-agent dynamic MCP server | Durable sessions, offline transcript reconciliation, async prompts, abort | Known mutation tools disabled; use a local sandbox for hostile code |
| Pi | Worker-hosted RPC JSONL plus Symphony Pi extension | Retained in-flight transport, native steer, follow-up, abort, session switch; completion waits for `agent_settled` | Pi `--tools` allowlist limits built-ins to read/search plus coordination |
| ACP | Version-pinned SDK client | Capability-dependent session resume/cancel | Permission requests are denied in read-only mode; conformance still depends on the ACP agent |

## Authentication

`symphony doctor` reports executable/SDK availability separately from authentication. A native driver confirms provider authentication only when it makes a provider-backed request. This distinction avoids showing a false “connected” state.

Cursor offers two safe paths:

- `CURSOR_API_KEY` / the `cursor.apiKey` macOS Keychain secret, passed only as an explicit SDK option for local or cloud work;
- the documented `Cursor.auth.login()` flow, which persists an expiring SDK credential in Cursor's own SDK store.

`cursor-agent` CLI login and `@cursor/sdk` login are separate authentication surfaces. Symphony may report CLI login as supplemental diagnostics, but only a provider-verified SDK credential makes the Cursor harness and its model catalog runnable. A cached or CLI-only model name is never treated as authentication evidence.

Cloud work must reference a remote repository and optional starting ref. Symphony rejects read-only Cursor Cloud work instead of weakening the requested boundary. Uncommitted local files are not silently uploaded.

Symphony-owned OpenCode services require the retained worker-host path and receive a password derived with HMAC-SHA256 from the secret `opencode.serverMasterKey` and the logical agent ID. The SDK attaches the matching static Basic `Authorization` header to both request/response and SSE traffic. macOS creates the 32-byte base64url master in Keychain on first need; non-macOS daemons must map it from `SYMPHONY_OPENCODE_SERVICE_KEY`. Only the derived `OPENCODE_SERVER_PASSWORD` reaches the native service. The master and all derived credentials are excluded from process arguments, configuration, leases, SQLite, spools, events, and logs. Configured user-managed endpoints receive no Symphony-generated credential.

## Event fidelity

Each stored driver event includes its harness and native event ID when available. Raw event payloads remain available to the UI and observer; normalized semantic kinds provide a common projection without erasing the native evidence.

Adapters must preserve the native terminal cause when normalizing lifecycle notifications. In particular, Pi's `agent_settled` notification describes transport quiescence, not success: when the final assistant message has `stopReason: "error"`, Symphony emits `run.failed` with the provider error instead of `run.completed`. Any empty or partial output remains inspectable without replacing that failure.

Codex App Server behavior is based on OpenAI's official [App Server documentation](https://learn.chatgpt.com/docs/app-server). Cursor and the other SDKs are pinned in `packages/drivers/package.json`; update them deliberately with their conformance fixtures.
