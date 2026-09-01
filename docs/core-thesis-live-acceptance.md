# Core thesis live acceptance

Run the deterministic live acceptance suite with:

```sh
./scripts/core-thesis-live-acceptance.sh
```

The suite starts the real daemon twice against a temporary root and its real
SQLite store. It registers and compiles a workflow through the in-repo
workflow engine, admits a durable objective, and drives native execution only
through an in-process `WorkerDriver` fixture. The fixture uses fixed event
times and IDs, waits for explicit test releases, and never contacts a model,
provider, browser, or external service.

The first scenario checks the important boundary sequence: an SSE/UI reader
disconnects while a loop attempt is running; the durable run and attempt stay
running; a strategy mutation from an authenticated full-access conductor is
committed with revision CAS and replayed idempotently; a daemon restart resumes
the same native sessions and frontier without calling `start` again; two
explicit releases complete the bounded loop; and an artifact is published from
the resulting evidence. Assertions inspect the real event log, control-plan
head/snapshot/revisions, logical agents and attempt IDs, usage rows, the
policy-backed budget ledger, artifacts, and supervisor attention events where
applicable.

The second scenario releases one native attempt as an unknown/cancelled
delivery and verifies fail-closed attention with the objective still
executing. A separate attempt emits a known native failure and verifies the
objective is failed, with no success event. The suite intentionally does not
fake UI progress: the only UI action is cancelling a real SSE reader.

The manifest at `tests/fixtures/core-thesis-live-acceptance.json` is a
machine-readable claim list; the Vitest suite is the executable acceptance
contract. Test roots and SQLite files are removed after each case.

The first scenario also exercises the atomic objective-workspace projection at
`GET /v1/objectives/:objectiveId/snapshot` (with `workspace` and `aggregate`
aliases). It verifies the one SQLite `eventCursor` fence, objective/run/
revision/attempt identity before and after restart, monotonic cursor movement,
and that the returned events and occurrences are objective-scoped rather than
assembled by selecting a conversation. The legacy run detail and control
strategy routes remain useful run-scoped views, but the acceptance claim for
the workspace aggregate is made only through this snapshot route.
