# Dynamic workflows

Workflow sources can be JSON or TypeScript and default to `.symphony/workflows`. TypeScript files default-export a value created with `defineWorkflow`; JSON uses the same schema.

## Implemented step types

- `agent`: native intelligent work with a required output schema.
- `set`: commit a JSON value, with `{{path}}` interpolation in strings.
- `sequence`: ordered child steps.
- `parallel`: concurrent child steps; the global agent concurrency limit still applies.
- `if`: deterministic branch over committed state.
- `while`: deterministic repetition over committed state with a mandatory bounded engine maximum.

Conditions use a JSON path, operator, comparison value, and optional default. Supported operators are `exists`, `eq`, `neq`, `gt`, `gte`, `lt`, and `lte`.

```ts
{ path: "steps.review.score", op: "lt", value: 8, default: 0 }
```

The default is useful for a first review iteration: no score is treated as zero. The run still has a configured maximum iteration count and remains cancellable.

## Triggers

Manual triggers are always supported. Cron uses standard Croner expressions and an optional IANA timezone. Before launch, each scheduled occurrence durably records its exact scheduled time, input, deterministic run ID, and pinned workflow revision/hash. If the daemon stops before creating the run—or after creating it but before linking the occurrence—startup reuses that run ID to reconcile the intent exactly once. Daemon-owned cron callbacks remain paused until retained agents, workflow runs, and pending occurrences have recovered.

```ts
triggers: [
  { id: "manual", type: "manual" },
  { id: "weekday", type: "cron", expression: "0 9 * * 1-5", timezone: "Pacific/Auckland", input: {} },
]
```

## Registration and execution

Put a workflow in the configured directory and restart the daemon, register JSON through `POST /v1/workflows`, or contribute a workflow from a trusted plugin.

```bash
pnpm symphony -- workflows
pnpm symphony -- run build-review-loop --input '{"request":"Add the feature"}'
```

The HTTP start call returns `202` with the run record immediately. Progress arrives through SSE and `/v1/runs`.

## Trust model

JSON workflows are data. TypeScript workflow files are trusted local code loaded in the daemon process. Do not accept workflow TypeScript from an untrusted repository or remote model without review. Output values are always checked again by the daemon with Ajv before a workflow can consume them.
