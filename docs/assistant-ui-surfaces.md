# Assistant UI surfaces in Symphony

Symphony keeps ordinary conversation on assistant-ui's stock thread primitives and adds structured surfaces only when they make an agent result easier to understand. The conductor and child agents can call `present_ui`; the daemon records an allowlisted `data` part in the conversation, and assistant-ui resolves it through `makeAssistantDataUI`. This follows assistant-ui's distinction between known [Tool UI](https://www.assistant-ui.com/docs/tools/tool-ui), backend-emitted data UI, and model-composed [Generative UI](https://www.assistant-ui.com/docs/tools/generative-ui).

## Implemented surface vocabulary

| Surface kind | Intended use | assistant-ui element |
| --- | --- | --- |
| `speaker-identity` | Attribute statements to the user, conductor, child agents, and tools | [Speaker identity](https://www.assistant-ui.com/elements/speaker-identity) |
| `diagram` | Explain a bounded architecture or relationship | [Diagram](https://www.assistant-ui.com/elements/diagram) |
| `flow-graph` | Show workflow or dependency topology | [Flow graph](https://www.assistant-ui.com/elements/flow-graph) |
| `spec-sheet` | Present typed properties, constraints, or a work order | [Spec sheet](https://www.assistant-ui.com/elements/spec-sheet) |
| `timeline` | Show ordered events or future milestones | [Timeline](https://www.assistant-ui.com/elements/timeline) |
| `job-progress` | Show progress only when finite stages are known | [Job progress](https://www.assistant-ui.com/elements/job-progress) |
| `score-breakdown` | Render an explicitly requested scoring output without making scoring a Symphony convention | [Score breakdown](https://www.assistant-ui.com/elements/score-breakdown) |
| `agent-plan` | Show an agent-authored plan and active step | [Agent plan](https://www.assistant-ui.com/elements/agent-plan) |
| `subagent-list` | Summarize visible delegated work | [Subagent list](https://www.assistant-ui.com/elements/subagent-list) |
| `recommendation-card` | Present a recommendation and round-trip the user's choice to the conductor | [Recommendation card](https://www.assistant-ui.com/elements/recommendation-card) |
| `handoff` | Explain a transfer between agents or harnesses | [Agent handoff](https://www.assistant-ui.com/elements/agent-handoff) |
| `schedule` | Present workflow trigger state and recent runs | [Schedule card](https://www.assistant-ui.com/elements/schedule-card) |
| `checkpoints` | Show persisted run or workspace checkpoints | [Checkpoint history](https://www.assistant-ui.com/elements/checkpoint-history) |
| `cost-meter` | Present attributed run/session usage | [Cost meter](https://www.assistant-ui.com/elements/cost-meter) |
| `tool-timeline` | Condense native tool activity and file statistics | [Elements catalog](https://www.assistant-ui.com/elements) |
| `generative-ui` | Let the model compose an ad hoc layout from the shipped 27-component vocabulary | [Generative UI vocabulary](https://www.assistant-ui.com/elements/vocabulary) |

The generic `generative-ui` surface is constrained to `styledGenerativeUILibrary`: component names are allowlisted and resolved by lookup, with no `eval` or dynamic import. The specialized surfaces remain useful when a stable information contract is preferable to a model-composed layout.

## Runtime observability

The Run details Trace tab maps the durable run and agent graph into `SpanData` and renders it through the headless [react-o11y primitives](https://www.assistant-ui.com/docs/utilities/react-o11y). Parent relationships, status, timing, collapse state, and waterfall bars therefore update from Symphony's real run projection rather than a frontend-only diagram.

## Transport contract

An authenticated agent calls:

```json
{
  "kind": "agent-plan",
  "data": {
    "steps": ["Inspect", "Implement", "Verify"],
    "activeIndex": 1
  }
}
```

The MCP or Pi tool posts this to `/v1/agents/:id/present`. The daemon verifies the calling agent token, resolves its chat workflow, appends a named `data` part, and emits `chat.ui.presented`. Unknown surface kinds are rejected. Normal prose remains the default; `present_ui` is for information that materially benefits from structure.

The `generative-ui` kind carries a `tree` using assistant-ui's `$type` vocabulary. It is separate from assistant-ui's backend `generative-ui` primitive format; Symphony deliberately uses one durable data-part transport for both the fixed elements and the allowlisted composed vocabulary. See assistant-ui's [pattern comparison](https://www.assistant-ui.com/docs/tools/generative-ui) and [backend primitive](https://www.assistant-ui.com/docs/tools/generative-ui-primitive).
