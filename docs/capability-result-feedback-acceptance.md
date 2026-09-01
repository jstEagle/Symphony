# Capability-result feedback acceptance

`tests/acceptance/capability-result-feedback.acceptance.test.ts` is the
bounded acceptance contract for the capability-result feedback loop. Its
machine-readable scenario list is in
`tests/fixtures/capability-result-feedback-acceptance.json`.

Run the readiness gate with:

```sh
./scripts/capability-result-feedback-acceptance.sh
```

The gate invokes the production `ObjectiveFeedbackReducer` and
`CapabilityResultFeedbackRepository`. It also anchors its identity fixture to
the existing capability admission and values-charter contracts. The harness
does not add a test-only reducer or depend on provider credentials.

The acceptance test currently drives the reducer and its durable SQLite
repository directly because no daemon HTTP feedback route is exposed yet. If a
route is added, the same scenarios should be run through that boundary as a
second live adapter; the direct reducer/storage gate remains useful for
isolating protocol and persistence regressions.

The completed gate must demonstrate:

- one feedback request creates one receipt, one evaluation, and one decision;
  identical retries replay, while changed retries conflict without side
  effects;
- feedback and evaluation survive a process/store restart and remain
  deduplicated;
- objective/run/node/attempt, admission and capability content hashes, evidence
  refs, and charter revision/hash remain bound;
- concurrent replans are fenced by the expected plan revision, yielding at
  most one replacement plan;
- missing, stale, ambiguous, or out-of-scope evidence fails closed into
  attention and cannot report success or trigger an unproven replan.

This is an evidence gate for durability and identity. It does not claim model
quality, provider correctness, or human-quality evaluation.
