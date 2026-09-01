# Long-running agent workflows: 2026 product research

_Research note · 1 September 2026_

## Scope and reading rule

This note compares first-party product documentation, engineering write-ups, and
maintainer documentation for long-running agent work. “Observed” means a vendor
documents the pattern as a supported use case or reports using it internally; it
does not mean that an independent survey establishes prevalence. Product pages
and vendor case studies are useful evidence of product shape, not neutral market
research.

## What advanced workflows are doing

The products converge on a loop that keeps the model replaceable and the work
inspectable:

| Observed use case | Evidence | Repeated design pattern |
| --- | --- | --- |
| Background triage and reporting | OpenAI describes scheduled Codex automations for issue triage, CI failures, release briefs, bug checks, and recurring Slack/Gmail/PR/deployment checks ([Codex app](https://openai.com/index/introducing-the-codex-app/), [Codex-maxxing](https://openai.com/index/codex-maxxing-long-running-work/)). GitHub documents issue triage, CI-failure, status-report, documentation, and test-coverage workflows ([agentic workflows](https://docs.github.com/en/copilot/concepts/agents/about-github-agentic-workflows)). | A timer or external event wakes a workflow; it prepares evidence or a draft, then stops at an approval boundary for consequential action. |
| Long builds that repair themselves | OpenAI’s 25-hour design-tool experiment repeatedly planned, edited, ran tests/builds/lint, observed failures, repaired, and updated status ([long-horizon Codex](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)). | Progress is a sequence of bounded milestones with a real feedback signal, not one giant prompt. |
| Evaluation-driven iteration | Anthropic’s long-running harness uses planner, generator, and separate evaluator agents with sprint contracts and hard thresholds; its evaluator interacted with a live app through Playwright for multiple iterations ([harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)). Anthropic’s eval guidance grades the final environment state and records the full multi-turn transcript ([demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). | “Done” is an independently checked outcome. Static tests, browser checks, LLM judges, and human calibration are complementary, not interchangeable. |
| Work that survives context loss | OpenAI recommends `Prompt.md`, `Plan.md`, a runbook, and a living status/decisions document; the artifact is an audit log that lets a person step away ([long-horizon Codex](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)). Anthropic’s harness uses progress files and a feature list whose test status survives context windows ([effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)). | The durable unit is a checkpoint plus artifact and next action, not a transcript that another harness is expected to understand. |
| Human attention on decisions and exceptions | OpenAI’s internal eval workflow pauses for plan approval, lets a user resolve alternatives, and records commands, dead ends, decisions, and results; the user monitors and nudges from a phone ([repetitive work](https://developers.openai.com/blog/automating-repetitive-work-at-openai-with-codex)). GitHub exposes live steering, session logs, tests, token usage, and stop/archive controls ([managing agent sessions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)). | Humans approve intent, risk, and ambiguity; agents execute routine steps and return a small review queue. |
| Parallel work with explicit isolation | Claude Code teams use independent contexts, shared tasks, and direct messaging for research/review, competing debugging hypotheses, and cross-layer features, while documenting token/coordination overhead ([agent teams](https://code.claude.com/docs/en/agent-teams)). T3 Code gives each agent thread a branch and brings Codex, Claude Code, OpenCode, Cursor, and Grok into one control plane ([T3 Code](https://t3.codes/)). GitHub agents likewise work in branches or ephemeral environments before review ([kick off a task](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/kick-off-a-task)). | Parallelize independent work, isolate files/branches, and make merge/review evidence first-class. |
| Durable waiting, interrupts, and external signals | Temporal persists workflow state and replays from event history; signals communicate with other executions ([Temporal workflow execution](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/workflow/workflow-execution/workflow-execution.mdx)). LangGraph checkpoints every step and supports indefinite human interrupts, resume, replay, and forks ([interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), [persistence](https://docs.langchain.com/oss/python/langgraph/persistence)). CrewAI Flows persist and resume, including human feedback and forked state ([Flows](https://github.com/crewAIInc/crewAI/blob/main/docs/v1.15.12/en/concepts/flows.mdx)). Vercel’s eve combines checkpointed sessions, approval waits, Slack/webhook channels, schedules, and eval gates ([eve](https://vercel.com/blog/introducing-eve)). | Waiting must consume no model process; a signal resumes a durable cursor with idempotent effects and provenance. |

The clearest common shape is therefore:

`objective → bounded step → artifact/checkpoint → independent evaluation → repair or approval → external signal / next step`

The native harness remains valuable inside a step. Claude subagents, for example,
deliberately receive fresh context for verbose research or test output and return
only a relevant summary; hooks can block unsafe tool calls ([subagents](https://code.claude.com/docs/en/sub-agents), [hooks](https://claude.com/blog/how-to-configure-hooks)). That is a useful local tactic, but it is not a durable cross-harness handoff contract.

## Recommendations for Symphony

Symphony already has the right boundary: native harnesses retain their own loop,
tools, authentication, context, and transcript; Symphony owns the cross-harness
graph, workflow state, event projection, routing, and cost evidence. The bets
below deepen that boundary rather than replacing native agents.

### Five product bets

1. **Closed-loop objective supervisor.** Add a first-class objective runner that
   makes `plan → execute → evaluate → repair` explicit, with dynamic `while`
   conditions, independent read-only evaluators, default-fail acceptance criteria,
   and bounded attempts/time/cost. Persist score and evidence trajectories so a
   user can see why the loop continued or stopped. This turns Symphony’s existing
   typed outputs and loop steps into an outcome contract, following the separate
   evaluator and final-state grading patterns above.

2. **Checkpoint and artifact ledger.** Commit a durable checkpoint after every
   accepted step: objective/constraints, input and output hashes, workspace
   revision, artifact references, tests/evaluation evidence, decisions, and the
   next action. Make the packet resumable, forkable, and readable by a fresh
   context; keep large files outside the event row and retain content hashes and
   provenance. This is the portable equivalent of OpenAI’s plan/status documents
   and Anthropic’s progress/feature artifacts.

3. **Signal-triggered wakeups.** Treat cron, CI, PR/issue events, webhooks, and
   approved Slack/Datadog signals as typed inputs to the same durable graph. Add
   deduplication keys, idempotency rules, retry/backoff, condition-based cadence,
   and “waiting” runs that hold no native process. The result should be safe to
   check repeatedly and explicit about which external signal caused a resume.

4. **Attention router and review queue.** Project only approvals, failed
   evaluations, ambiguous decisions, blocked workers, cost/risk thresholds, and
   merge conflicts into a unified queue. Include a compact evidence digest,
   one-click approve/revise/stop/nudge, escalation and snooze, and a mobile-safe
   summary; preserve the complete event/artifact trail behind it. This formalizes
   the human pattern already visible in OpenAI and GitHub workflows: people steer
   intent and exceptions while background agents do repetitive execution.

5. **Portable multi-harness handoff bus.** Define a versioned Handoff Envelope
   for every cross-harness edge: objective, constraints, output schema, artifact
   URIs/hashes, workspace/branch/revision, capabilities and permissions,
   continuation token (if supported), parent/run IDs, expiry, and provenance.
   Adapters may run Codex, Claude Code, T3, GitHub, or another native harness, but
   Symphony owns lineage and evidence. Negotiate capabilities and fail closed to a
   fresh context plus artifacts when a provider cannot prove resume; do not attempt
   transcript migration as a hidden compatibility promise.

## Architecture guardrails

- Keep SQLite/event projections authoritative for checkpoints, signals, review
  state, and cost evidence; native session output remains an implementation detail
  unless deliberately promoted into an artifact.
- Require structured results and acceptance evidence before a step can satisfy a
  loop condition. A model’s claim that it finished is never sufficient by itself.
- Preserve explicit workspace, branch, permission, and side-effect boundaries;
  parallelism is opt-in where writes can conflict.
- Make every external write (merge, message, deployment, ticket mutation, or
  credentialed action) a visible approval or policy decision with an audit trail.
- Treat provider-specific “agent teams” and “durable sessions” as capabilities,
  not assumptions. The Symphony graph must remain useful when a harness is
  unavailable, interrupted, or replaced.

These bets form one product: an objective can wait on a signal, resume from a
checkpoint, delegate an isolated step to the best available native harness,
iterate against an independent evaluator, and ask a person only for the next
decision that matters.

## Sources checked

Primary sources were checked on 1 September 2026. The links embedded above cover
the claims; the main product/runtime references are also listed here for quick
follow-up:

- [Codex app](https://openai.com/index/introducing-the-codex-app/) · [Codex-maxxing whitepaper](https://cdn.openai.com/pdf/8a9f00cf-d379-4e20-b06f-dd7ba5196a11/OAI_WhitePaper_Codex-maxxing26.pdf) · [OpenAI long-horizon Codex](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) · [Claude Code teams](https://code.claude.com/docs/en/agent-teams) · [Anthropic harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [GitHub Copilot agents](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents) · [GitHub agentic workflows](https://docs.github.com/en/copilot/concepts/agents/about-github-agentic-workflows)
- [T3 Code](https://t3.codes/) · [Temporal workflow execution](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/workflow/workflow-execution/workflow-execution.mdx) · [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [CrewAI Flows](https://github.com/crewAIInc/crewAI/blob/main/docs/v1.15.12/en/concepts/flows.mdx) · [Vercel eve](https://vercel.com/blog/introducing-eve) · [Vercel durable execution](https://vercel.com/blog/a-new-programming-model-for-durable-execution)
