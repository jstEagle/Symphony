# Operator CLI

The operator commands are a thin client of the daemon. The daemon owns the
capability registry, durable message bus, and session diagnostic bundle; the
CLI does not create a second store or infer successful delivery.

## Capabilities

```sh
symphony capability list [capability-id]
symphony capability show capability-id 1
symphony capability create --body-file capability.json --idempotency-key operator:capability:1
symphony capability activate capability-id 1 --body '{"actor":{"type":"user","id":"operator"}}'
symphony capability deprecate capability-id 1 --body-file transition.json
symphony capability prepare capability-id 1 --body '{"parameters":{"input":"..."}}'
```

`create`, `activate`, and `deprecate` carry the explicit request key and actor
in the JSON body. An actor can instead be supplied with `--actor-type` and
`--actor-id`. `prepare` is a read-like resolution and does not require an
idempotency key.

## Durable messages

```sh
symphony messages send --body-file message.json --idempotency-key operator:message:1
symphony messages list --after 120 --limit 100 --recipient-id agent:child
symphony messages show agent-message-id
symphony messages receipts agent-message-id
symphony messages cancel agent-message-id --actor-id user:operator --reason 'No longer needed'
symphony messages expire agent-message-id --actor-id system:expiry
```

`messages receipts` reads the immutable receipt history. Supplying
`--body`/`--body-file` records an explicit receipt through the daemon. Use the
same `--idempotency-key` when retrying a mutation. If the connection fails
after a mutation may have reached the daemon, the CLI reports `UNKNOWN` and
prints the key to reconcile; it never silently resends with a new key.

## Session diagnostics

```sh
symphony diagnostics export agent-id --json
symphony session diagnostics agent-id --json
```

The argument is the durable Symphony agent ID (not the provider's native
session ID). The result is the daemon's bounded, secret-free diagnostic bundle;
native session IDs are included in the returned identity when available. `--json`
emits one compact JSON record suitable for piping to `jq`; default output is a
short human summary.
