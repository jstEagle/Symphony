# Objective CLI

The CLI is a scriptable control surface for durable objectives. The daemon
remains the authority: the CLI reads its snapshots and event stream and sends
idempotent commands. It never treats a conversation, browser tab, or local
process as the source of truth.

## Reads

```sh
symphony objective list
symphony objective snapshot objective-id --json
symphony objective frontier objective-id
symphony objective runline objective-id
symphony objective attentions [objective-id]
symphony objective artifacts run-id
symphony objective artifact run-id artifact-id
symphony objective checkpoints run-id
symphony objective strategy run-id
```

Human-readable output is the default. `--json` emits one compact JSON record,
which is useful with `jq`, scripts, and other agents. Objective snapshots are
atomic daemon projections and include runs, frontier/runline, attempts,
attentions, artifacts/reviews, checkpoints, budgets, mutations, suspensions,
and event evidence when available.

## Durable control

All mutating commands accept either `--body JSON` or `--body-file PATH`:

```sh
symphony objective strategy-preview run-id --body-file proposed-plan.json
symphony objective strategy-revise run-id --body-file proposed-plan.json \
  --idempotency-key operator:plan:2026-09-01
symphony objective signal run-id waiting-for-deploy --body '{"payload":{"ok":true}}' \
  --idempotency-key deploy:completed:42
symphony objective attention-resolve run-id attention-id \
  --body '{"status":"resolved","decision":{"approved":true}}' \
  --idempotency-key operator:attention:42
symphony objective artifact-review run-id artifact-id \
  --body '{"state":"verified","reason":"checked"}' \
  --idempotency-key review:artifact:42
```

Checkpoint operations are explicit and do not imply process rewind:

```sh
symphony objective checkpoint run-id checkpoint-id resume --body '{}'
symphony objective checkpoint run-id checkpoint-id retry \
  --body '{"activity":{"kind":"task","id":"task-id"}}'
symphony objective checkpoint run-id checkpoint-id fork \
  --body '{"reason":"try a different strategy","newRunId":"run-branch-a"}'
```

If the daemon connection fails after a mutation is sent, the CLI reports an
`UNKNOWN` outcome and prints the exact key to retry. Reuse that key; do not
invent a new one until the durable receipt has been reconciled.

## Live follow

```sh
symphony objective follow run-id
symphony objective follow run-id --after 120 --json
```

`follow` consumes the daemon's SSE objective event stream, resumes from the
last event cursor after a disconnect, and exits cleanly on Ctrl-C. JSON mode
is NDJSON (one event per line), so it can be piped into a log processor.

Use `--config PATH` to select a Symphony config file when invoking the CLI
outside the project directory. The server address is otherwise read from
`symphony.config.json`; no non-secret endpoint configuration is required in
environment variables.
