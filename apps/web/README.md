# Symphony UI

The local chat surface is a TanStack Start SPA. assistant-ui owns the thread, composer, and message primitives. DotMatrix loaders mark live agent work. TanStack Query caches the daemon bootstrap projection.

The interface is one conversation with the conductor. Worker agents stay inside that conversation's orchestration graph; they are not extra sidebar chats.

## Run it

```bash
pnpm install
pnpm dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Vite proxies `/v1` and `/health` to the daemon on `127.0.0.1:3210`.

```bash
pnpm lint
pnpm typecheck
pnpm build
```

`pnpm build` writes a static SPA to `out/` so the Symphony daemon can serve it. `dataMode` in `src/symphony.config.ts` is `auto`: the UI uses the live daemon when `/health` succeeds, otherwise an explicitly labelled preview projection.

## Local data boundary

The browser is a projection and control surface, not the orchestration authority:

```text
native harnesses -> Symphony daemon -> SQLite + event log
                              |
             snapshot API + resumable SSE + commands
                              |
              TanStack Start SPA / assistant-ui
```

- The Symphony daemon is the only owner of SQLite, workflow state, transcripts, leases, retries, and process lifecycle.
- assistant-ui's `ExternalStoreRuntime` projects Symphony messages into the standard thread UI.
- TanStack Query owns the replaceable bootstrap snapshot cache.
- A resumable server-sent event stream announces committed runtime changes; the client refreshes the authoritative projection after events or a reset.
- Plain React state owns ephemeral UI details such as whether the run popover is open.
- The browser does not persist authoritative run data in localStorage, IndexedDB, Zustand, or another local database. A reload cannot stop an agent or change the truth of a run.

The main daemon boundary is:

```text
GET  /v1/bootstrap
GET  /v1/events?after=<cursor>
GET/PATCH /v1/settings
GET/POST  /v1/threads
GET/PATCH /v1/threads/:id
POST      /v1/threads/:id/messages
```

Message requests carry a client-generated ID, so the stored user message and optimistic assistant-ui message converge on one identity. Text/code attachments are parsed by assistant-ui and sent as structured attachment parts; secrets and binary files are deliberately not browser storage. Commands carry idempotency keys. Do not put orchestration in TanStack Start server functions.

## Interface components

- assistant-ui supplies the thread, messages, composer, actions, reasoning display, tool expansion, attachments, and accessibility behavior.
- Symphony customizes only the pieces unique to orchestration: agent tool calls, compact run details, and structured workflow outputs.
- DotMatrix loaders identify live work. Different shapes distinguish agents and harnesses; a loader appears in the header, active tool rows, agent lists, and loading states, then becomes a static completion or error icon.
- The responsive chat sidebar provides search, pinned chats, project groups, new-chat actions, status markers, and per-chat move/pin controls.
- The composer switches the persisted default conductor across currently available native harness/model pairs. Settings exposes the same conductor controls plus finite or unlimited agent depth/concurrency, and writes all non-secret defaults back through the daemon. Usage shows measured, estimated, and unknown evidence separately. Run details show compact semantic events rather than raw native SDK payloads.
- If a completed native session cannot be resumed after a daemon restart, the next user turn creates a replacement conductor with bounded prior conversation context. The conversation remains one sidebar chat.

Non-secret runtime choices belong in `src/symphony.config.ts`. Only credentials, tokens, and API keys belong in environment variables or secret stores.
