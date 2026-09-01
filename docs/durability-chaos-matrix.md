# Durability chaos matrix

`tests/acceptance/durability-chaos-matrix.acceptance.test.ts` is a bounded live
acceptance gate for the daemon's durability contract. It runs the actual
`startDaemon` server, SQLite store, HTTP routes, and SSE projection. The native
boundary is deterministic and explicit: `tests/fixtures/durability-chaos-driver.ts`
can hold startup, return queued message receipts, expose a retained idle
session, or emit completed/failed/unknown terminal evidence.

The matrix covers:

- browser/SSE disconnect while a control timer is waiting;
- daemon generation restart and re-arming of a timer;
- signal delivery before its frontier, wrong subscription, exact retry, and
  conflicting payload;
- objective request replay and conflicting request key, including after a
  restart;
- signal expiry and terminal cancellation;
- accepted-but-unproven native startup (fail closed, no automatic retry);
- durable queued follow-up recovery against a retained native session;
- approval-attention resolution replay and conflict;
- artifact/checkpoint replay and evidence consistency;
- aggregate `eventCursor` high-water fencing.

Run once with:

```sh
pnpm exec vitest run tests/acceptance/durability-chaos-matrix.acceptance.test.ts --reporter=verbose
```

Repeat deterministic generations with different seeds using:

```sh
scripts/durability-chaos-matrix.sh 1 2 3 5 8
```

The seed is recorded in objective context and fixture metadata. It currently
does not randomize scheduling; that is intentional. The first expansion
should add a deterministic permutation of command boundaries without making
the assertions timing-sensitive.

## Interpretation

`daemon.close()` is used at a controlled boundary because sending `SIGKILL` to
the Vitest process would destroy the test runner and make cleanup unreliable.
The restart still closes/reopens the real SQLite store and starts a fresh HTTP
server and driver registry, so it exercises durable rehydration rather than a
mocked process restart.

The fake driver cannot prove a real provider's external side effect after a
crash. The test therefore asserts the safe invariant: an accepted-but-unproven
native request is marked interrupted, its durable identity remains visible, and
Symphony does not resend it automatically. Provider-specific crash injection
and multi-machine SQLite lock tests remain release-gate work.
