# Deterministic orchestration evaluation

`tests/workflow-eval.test.ts` is the smallest evaluation gate for Symphony's
orchestration claim. It runs the same deterministic native-turn fixture in
three arms:

- **Dynamic:** a bounded `while` loop runs build/review again when the committed
  review score is below eight.
- **Static:** the same build/review steps run once in a fixed workflow.
- **Single native:** one native agent receives one bounded turn with no
  cross-agent workflow supervision.

The fixture emits usage for every turn. Its first review is score `4`, its
second review is score `9`, and all other outputs are schema-valid. This is a
narrow orchestration test, not a claim about model quality or retail-agent
performance. The dynamic arm is expected to trade two extra native turns (and
their measured cost) for oracle success.

Each result records an explicit `success`, `score`, `attempts`,
`nativeTurns`, `duplicateDispatches`, `costUsd`, `unknownCostEvents`, and
`interventions` field. Run/step-attempt/event/usage rows in the temporary
SQLite store are the durable evidence; unknown usage remains visible instead
of being treated as zero. The test currently asserts zero duplicate dispatches
and zero interventions for all three arms.

Future scenarios can add deterministic diagnosis routing, parallel critical
path reduction, selective fallback, and worker-host daemon recovery. Live
native-harness trials should remain separately versioned and exploratory.
