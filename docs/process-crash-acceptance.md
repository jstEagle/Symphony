# Process-crash durability acceptance

`tests/acceptance/process-crash-boundary.acceptance.test.ts` exercises the
daemon as a real child process. Each case creates a fresh temporary SQLite
directory and loopback port, captures child PIDs from readiness/lease records,
disconnects the SSE client where relevant, sends `SIGKILL` only to the named
daemon PID, and starts a replacement process against the same store.

Run one seed while developing:

```bash
SYMPHONY_PROCESS_CRASH_SEED=1 pnpm exec vitest run tests/acceptance/process-crash-boundary.acceptance.test.ts --reporter=verbose
```

Run the bounded repeated-seed matrix:

```bash
./scripts/process-crash-acceptance.sh
```

The acceptance cases prove:

- an active Codex-shaped native child continues while the daemon and SSE
  projection are absent; the replacement adopts the same worker host/session,
  records one terminal result, and replays the durable event cursor without
  duplicate or skipped visible events;
- timer due work and a signal subscription are reconstructed from SQLite after
  a daemon process boundary, and a repeated signal delivery is fenced by its
  durable delivery identity;
- a queued follow-up is restored from SQLite after a daemon process boundary;
  an accepted Cursor follow-up settles exactly once from the retained worker
  host, while a follow-up whose provider acceptance is unproven becomes
  `outcome-unknown`/`interrupted` and is never blindly redispatched.

These tests are process-boundary acceptance, not provider certification. The
Codex app-server and Cursor SDK/CLI children are deterministic local fixtures:
they do not prove real model execution, provider authentication, provider-side
idempotency, network partitions, billing, remote repositories, cloud runs, or
third-party side effects. Those gaps require a separately authorized provider
test repository/account with bounded spend and explicit cleanup. In particular,
an adopted local worker proves continuity of the native fixture and Symphony's
durable ledger; it does not prove that an arbitrary external provider accepted
or completed an irreversible operation.
