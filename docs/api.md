# Local API

The default origin is `http://127.0.0.1:3000`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Process liveness and latest event cursor |
| `GET` | `/v1/bootstrap` | Initial frontend projection |
| `GET` | `/v1/events?after=N` | Resumable Server-Sent Events |
| `GET/PATCH` | `/v1/settings` | Read or atomically persist non-secret conductor/agent defaults |
| `GET` | `/v1/drivers` | Native availability/auth doctor report |
| `GET` | `/v1/models` | Current eligible model catalog |
| `GET` | `/v1/plugins` | Plugin trust/build/active states |
| `GET/POST` | `/v1/agents` | List or create agents |
| `POST` | `/v1/agents/:id/messages` | Steer/follow up |
| `GET` | `/v1/agents/:id/observe?level=tldr` | Passive observation |
| `POST` | `/v1/agents/:id/cancel` | Cancel native work |
| `GET/POST` | `/v1/workflows` | List/register workflow revisions |
| `POST` | `/v1/workflows/:id/runs` | Start a run |
| `GET` | `/v1/runs` | Run projection |
| `POST` | `/v1/runs/:id/cancel` | Cancel a run |
| `GET` | `/v1/costs` | Cost total with evidence bases and unknown count |
| `GET` | `/v1/usage/heatmap?weeks=12` | Calendar buckets of persisted known and unknown usage |
| `GET` | `/v1/drivers?refresh=true` | Live harness auth, installed/latest versions, and update availability |
| `POST` | `/v1/drivers/:id/update` | Run the configured allowlisted native CLI updater through a durable idempotency receipt |
| `GET` | `/v1/theme` | Read the validated root `theme.json` |
| `GET` | `/v1/theme/icon.svg` | Render the current Symphony mark from theme tokens |
| `POST` | `/v1/agents/:id/present` | Authenticated, idempotent agent presentation of allowlisted assistant-ui data |
| `GET/POST` | `/v1/threads` | List/create grouped chats |
| `GET/PATCH` | `/v1/threads/:id` | Thread detail/organization |
| `POST` | `/v1/threads/:id/messages` | Send to the conductor |
| `GET` | `/v1/plugin-tools` | Active trusted plugin tools |
| `POST` | `/v1/plugin-tools/:name` | Invoke a plugin tool through a durable idempotency receipt |

Agent-to-daemon coordination is authenticated with a daemon-derived per-agent token injected only into the child process. Agent requests cannot choose their own parent, depth, workflow, run, or mission; the API overwrites those from trusted state.

The generic `/v1/commands` surface is user-only. Native agents must use scoped coordination routes so they cannot substitute a caller-supplied actor or bypass their durable parent and permission boundary.

Mutating orchestration routes require an `Idempotency-Key` header. `POST /v1/commands` also accepts the key in its explicit command envelope for retry-safe control operations. Workflow registration is one such command: an authenticated full-access agent can register a custom immutable workflow revision, then run it through the same durable control plane. SSE event IDs are SQLite cursors; clients should reconnect with `Last-Event-ID` or `?after=`.

Trusted plugin tools may perform irreversible external actions, so invocation is also a receipt-backed mutation. A settled retry returns its stored result. If Symphony recovers a `dispatching` plugin receipt after losing the response boundary, it returns outcome-unknown and never replays arbitrary plugin code automatically.

Native harness updates require `Idempotency-Key` and full-access agent permission. Symphony persists the command receipt and a per-driver operation fence before launching the external updater. A settled retry returns the stored result. A concurrent key is rejected, and an update left `dispatching` across restart is never launched again unless the installed version conclusively proves the original operation reached its distinct recorded target.

Interactive native harness authentication also requires `Idempotency-Key` and full-access agent permission. Symphony commits a separate per-driver authentication operation before opening the provider flow. A settled retry returns the stored, credential-free result. A recovered `dispatching` operation is reconciled only when the native harness authoritatively reports `authenticated: true`; otherwise it remains outcome-unknown and is never relaunched automatically.

`GET /v1/bootstrap` includes recent persisted semantic events, per-run and per-agent cost aggregates, current runtime settings, native driver status, model cards, threads, messages, agents, workflows, runs, and plugin status. The browser can therefore reconnect without treating an in-memory client cache as truth.

`POST /v1/threads` requires `Idempotency-Key`. Symphony binds the key to the normalized project/workspace, title, group, and mission payload, derives one stable thread identity from it, and commits the thread, its conductor run, and the durable create receipt in one SQLite transaction. An exact retry—including after daemon restart—returns the original thread; reusing the key for a different payload returns `409`.

`POST /v1/threads/:id/messages` accepts `{ messageId, content, attachments }`. `attachments` are text/code records with an id, name, optional content type, assistant-ui attachment type, and JSON content parts. A default chat title is derived from the first text message. If the previous conductor has reached a terminal state or its completed native session was lost across restart, Symphony starts a replacement conductor with bounded conversation context; an in-flight conductor that is not yet messageable returns `409` before storing the new user message.
