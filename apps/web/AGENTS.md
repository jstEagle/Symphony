# Symphony UI

`apps/web` is a TanStack Start SPA. The daemon remains the orchestration authority; this package is only the projection and control surface.

- Keep assistant-ui for thread, composer, messages, reasoning, and tool primitives.
- Keep DotMatrix loaders for live agent and harness work.
- Use TanStack Query for bootstrap snapshots and invalidation after SSE events.
- Do not add TanStack Start server functions that own runs, transcripts, or SQLite.
- Static export output lives in `out/` for the daemon to serve.
