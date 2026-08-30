# Local API

The default origin is `http://127.0.0.1:3210`.

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
| `POST` | `/v1/drivers/:id/update` | Run the configured allowlisted native CLI updater |
| `GET` | `/v1/theme` | Read the validated root `theme.json` |
| `GET` | `/v1/theme/icon.svg` | Render the current Symphony mark from theme tokens |
| `POST` | `/v1/agents/:id/present` | Authenticated agent presentation of allowlisted assistant-ui data |
| `GET/POST` | `/v1/threads` | List/create grouped chats |
| `GET/PATCH` | `/v1/threads/:id` | Thread detail/organization |
| `POST` | `/v1/threads/:id/messages` | Send to the conductor |
| `GET` | `/v1/plugin-tools` | Active trusted plugin tools |
| `POST` | `/v1/plugin-tools/:name` | Invoke a plugin tool |

Agent-to-daemon coordination is authenticated with a daemon-derived per-agent token injected only into the child process. Agent requests cannot choose their own parent, depth, workflow, run, or mission; the API overwrites those from trusted state.

`POST /v1/commands` accepts an explicit idempotency key for retry-safe control operations. SSE event IDs are SQLite cursors; clients should reconnect with `Last-Event-ID` or `?after=`.

`GET /v1/bootstrap` includes recent persisted semantic events, per-run and per-agent cost aggregates, current runtime settings, native driver status, model cards, threads, messages, agents, workflows, runs, and plugin status. The browser can therefore reconnect without treating an in-memory client cache as truth.

`POST /v1/threads/:id/messages` accepts `{ messageId, content, attachments }`. `attachments` are text/code records with an id, name, optional content type, assistant-ui attachment type, and JSON content parts. A default chat title is derived from the first text message. If the previous conductor has reached a terminal state or its completed native session was lost across restart, Symphony starts a replacement conductor with bounded conversation context; an in-flight conductor that is not yet messageable returns `409` before storing the new user message.
