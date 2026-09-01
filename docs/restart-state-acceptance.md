# Restart-state acceptance

`tests/acceptance/restart-state.acceptance.test.ts` starts the real daemon in
a child process with a fresh temporary config and SQLite directory. It writes
through the same capability and semantic-message services that
`SymphonyDaemon` opens, records a bounded session-diagnostic bundle in the
daemon store, sends `SIGKILL` to the exact daemon PID, then starts a replacement
generation against the same files.

The gate proves that:

- capability definitions and activation state survive a daemon process
  boundary; the original create request replays byte-for-byte and a changed
  payload with the same key is fenced as a conflict;
- semantic agent messages and their delivery receipt survive restart, cursor
  replay returns the message once, and duplicate/conflicting appends remain
  fenced;
- diagnostic identity, event-cursor ranges, liveness, terminal-unknown state,
  provenance, and content hash survive restart without exporting an
  allowlisted secret-shaped value.

Run it directly with:

```bash
pnpm exec vitest run tests/acceptance/restart-state.acceptance.test.ts --reporter=verbose
```

or use the bounded script:

```bash
./scripts/restart-state-acceptance.sh
```

This is a local SQLite/process-boundary acceptance gate. It does not claim
provider-side delivery, remote model billing, cloud execution, or browser
multi-window behavior. The existing process-crash and durability-chaos gates
cover native-worker continuation, SSE cursor replay, timer/signal recovery,
queued follow-ups, and explicit outcome-unknown logging.
