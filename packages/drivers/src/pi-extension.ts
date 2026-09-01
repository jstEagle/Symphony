import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const daemonUrl = process.env.SYMPHONY_DAEMON_URL;
const agentId = process.env.SYMPHONY_AGENT_ID;
const token = process.env.SYMPHONY_AGENT_TOKEN;
const canCreate = process.env.SYMPHONY_AGENT_CAN_CREATE === "true";

async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  if (!daemonUrl || !agentId || !token) throw new Error("Symphony coordination environment is incomplete.");
  const response = await fetch(new URL(path, daemonUrl), {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-symphony-agent-id": agentId,
      "x-symphony-agent-token": token,
      ...options.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return text ? JSON.parse(text) as unknown : null;
}

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

function mutation(tool: string, toolCallId: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "idempotency-key": `pi:${agentId}:${tool}:${toolCallId}` },
    body: JSON.stringify(body),
  };
}

// Pi receives Symphony coordination through this extension rather than the
// MCP server. Keep these TypeBox shapes aligned with the daemon/MCP boundary;
// identity and idempotency remain authenticated request metadata, not tool
// arguments.
const id = () => Type.String({ minLength: 1 });
const jsonObject = () => Type.Record(Type.String(), Type.Unknown());
const objectiveTask = Type.Object({
  id: id(),
  objective: Type.String({ minLength: 1 }),
  dependsOn: Type.Optional(Type.Array(id())),
  outputSchema: Type.Optional(jsonObject()),
  model: Type.Optional(Type.String({ minLength: 1 })),
  harness: Type.Optional(Type.Union([
    Type.Literal("auto"), Type.Literal("codex"), Type.Literal("claude"),
    Type.Literal("cursor"), Type.Literal("opencode"), Type.Literal("pi"), Type.Literal("acp"),
  ])),
  permissions: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("full-access")])),
  inputs: Type.Optional(Type.Array(Type.Unknown())),
  routing: Type.Optional(jsonObject()),
  workspace: Type.Optional(jsonObject()),
  requiresApproval: Type.Optional(Type.Boolean()),
});
const objectiveSpec = Type.Object({
  id: id(),
  statement: Type.String({ minLength: 1 }),
  criteria: Type.Optional(Type.Array(jsonObject())),
  approvalPolicy: Type.Optional(Type.Object({
    mode: Type.Union([Type.Literal("never"), Type.Literal("on-replan"), Type.Literal("before-completion")]),
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
  })),
  maxReplans: Type.Optional(Type.Number({ minimum: 0 })),
});
const objectiveTaskUpdate = Type.Object({
  taskId: id(),
  state: Type.Union([
    Type.Literal("queued"), Type.Literal("waiting-approval"), Type.Literal("running"),
    Type.Literal("completed"), Type.Literal("failed"),
  ]),
  attemptId: Type.Optional(Type.Union([id(), Type.Null()])),
  agentId: Type.Optional(Type.Union([id(), Type.Null()])),
  output: Type.Optional(Type.Union([Type.Unknown(), Type.Null()])),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  startedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  finishedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export default function symphonyPiExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "list_agents",
    label: "List Symphony agents",
    description: "List durable agents in the Symphony graph with objectives, parents, models, and states. This is the cross-harness Symphony projection; ephemeral native Pi subagents may not appear here.",
    parameters: Type.Object({ activeOnly: Type.Optional(Type.Boolean({ default: false })) }),
    async execute(_id, params) { return response(await api(`/v1/agents?active=${String(params.activeOnly ?? false)}`)); },
  });

  if (canCreate) pi.registerTool({
    name: "create_agent",
    label: "Create Symphony agent",
    description: "Create a durable, observable Symphony child for parallel, cross-harness, specialized, or structured work. Mission, depth, parent, and permission ceilings are injected by Symphony; use native Pi subagents only for ephemeral, tightly coupled local tactics.",
    parameters: Type.Object({
      objective: Type.String(),
      harness: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("codex"), Type.Literal("claude"), Type.Literal("cursor"), Type.Literal("opencode"), Type.Literal("pi"), Type.Literal("acp")], { default: "auto" })),
      model: Type.Optional(Type.String({ default: "auto" })),
      permissions: Type.Optional(Type.Union([Type.Literal("full-access"), Type.Literal("read-only")])),
      outputSchema: Type.Record(Type.String(), Type.Unknown()),
    }),
    async execute(id, params) { return response(await api("/v1/agents", mutation("create-agent", id, params))); },
  });

  pi.registerTool({
    name: "list_objectives",
    label: "List Symphony objectives",
    description: "Inspect durable Symphony objectives across native harnesses before deciding how to orchestrate. This is read-only durable state; ephemeral native Pi subagents remain harness-local assistance and may not appear in this projection.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, default: 50 })),
      state: Type.Optional(Type.Array(Type.Union([
        Type.Literal("planning"), Type.Literal("executing"), Type.Literal("evaluating"),
        Type.Literal("awaiting-approval"), Type.Literal("replanning"), Type.Literal("succeeded"),
        Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("interrupted"),
      ]))),
      runId: Type.Optional(id()),
      workflowId: Type.Optional(id()),
    }),
    async execute(_id, params) {
      const query = new URLSearchParams({ limit: String(params.limit ?? 50) });
      if (params.state?.length) query.set("state", params.state.join(","));
      if (params.runId) query.set("runId", params.runId);
      if (params.workflowId) query.set("workflowId", params.workflowId);
      return response(await api(`/v1/objectives?${query.toString()}`));
    },
  });

  pi.registerTool({
    name: "get_objective",
    label: "Get Symphony objective",
    description: "Inspect one durable Symphony objective's plan revisions, frontier, checkpoints, approvals, and event history. Use this to recover cross-harness context; native Pi subagents do not replace the durable objective record or its authority boundary.",
    parameters: Type.Object({
      runId: id(),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2_000, default: 500 })),
      after: Type.Optional(Type.Number({ minimum: 0, default: 0 })),
    }),
    async execute(_id, params) {
      const query = new URLSearchParams({ limit: String(params.limit ?? 500) });
      if (params.after !== undefined) query.set("after", String(params.after));
      return response(await api(`/v1/objectives/${encodeURIComponent(params.runId)}?${query.toString()}`));
    },
  });

  if (canCreate) {
    pi.registerTool({
      name: "create_objective",
      label: "Create Symphony objective",
      description: "Start a durable Symphony objective with immutable intent and optional initial tasks. Use for long-lived cross-harness work that needs a plan, recovery checkpoints, evaluation evidence, or approvals; native Pi subagents are local implementation tactics, not substitutes for this record.",
      parameters: Type.Object({
        runId: Type.Optional(id()),
        objectiveId: Type.Optional(id()),
        workflowId: id(),
        workflowRevision: Type.Number({ minimum: 1 }),
        workflowHash: Type.String({ minLength: 8 }),
        conductorAgentId: Type.Optional(Type.Union([id(), Type.Null()])),
        spec: objectiveSpec,
        tasks: Type.Optional(Type.Array(objectiveTask)),
        context: Type.Optional(jsonObject()),
      }),
      async execute(toolCallId, params) {
        return response(await api("/v1/objectives", mutation("create-objective", toolCallId, params)));
      },
    });

    pi.registerTool({
      name: "commit_objective_plan",
      label: "Commit Symphony objective plan",
      description: "Append a revision to a durable Symphony objective plan using compare-and-swap. Use for a durable strategy change; native Pi subagents may help with one local tactic but do not own the shared objective plan.",
      parameters: Type.Object({
        runId: id(),
        expectedPlanRevision: Type.Number({ minimum: 0 }),
        tasks: Type.Array(objectiveTask, { minItems: 1, maxItems: 128 }),
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
      }),
      async execute(toolCallId, params) {
        const { runId, ...body } = params;
        return response(await api(`/v1/objectives/${encodeURIComponent(runId)}/plans`, mutation("commit-objective-plan", toolCallId, body)));
      },
    });

    pi.registerTool({
      name: "checkpoint_objective",
      label: "Checkpoint Symphony objective",
      description: "Commit durable Symphony objective progress, task state, context, and evidence cursor. Checkpoints are recovery boundaries across native harnesses; they do not rewind an opaque native subagent process.",
      parameters: Type.Object({
        runId: id(),
        eventCursor: Type.Number({ minimum: 0 }),
        context: Type.Optional(jsonObject()),
        taskUpdates: Type.Optional(Type.Array(objectiveTaskUpdate, { maxItems: 128 })),
        reason: Type.String({ minLength: 1, maxLength: 2_000 }),
      }),
      async execute(toolCallId, params) {
        const { runId, ...body } = params;
        return response(await api(`/v1/objectives/${encodeURIComponent(runId)}/checkpoints`, mutation("checkpoint-objective", toolCallId, body)));
      },
    });

    pi.registerTool({
      name: "request_objective_approval",
      label: "Request Symphony objective approval",
      description: "Create a durable approval request for a Symphony objective plan, task, or completion boundary. This requests attention but does not resolve approval; use the shared cross-harness decision record rather than a native Pi subagent conversation.",
      parameters: Type.Object({
        runId: id(),
        kind: Type.Union([Type.Literal("plan"), Type.Literal("task"), Type.Literal("completion")]),
        taskId: Type.Optional(Type.Union([id(), Type.Null()])),
        question: Type.String({ minLength: 1, maxLength: 2_000 }),
        scope: Type.Optional(jsonObject()),
        operationId: id(),
        requestHash: Type.String({ minLength: 8, maxLength: 256 }),
        policyHash: Type.String({ minLength: 8, maxLength: 256 }),
        sideEffectClass: Type.Union([Type.Literal("read"), Type.Literal("local"), Type.Literal("external"), Type.Literal("irreversible")]),
        canonicalTarget: Type.String({ minLength: 1, maxLength: 2_000 }),
        expiresAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      async execute(toolCallId, params) {
        const { runId, ...body } = params;
        return response(await api(`/v1/objectives/${encodeURIComponent(runId)}/approvals`, mutation("request-objective-approval", toolCallId, body)));
      },
    });
  }

  pi.registerTool({
    name: "present_ui",
    label: "Present Symphony UI",
    description: "Present optional structured UI in the current Symphony chat. Supported kinds include speaker identity, diagrams, flow graphs, spec sheets, timelines, job progress, score breakdowns, plans, subagent lists, recommendations, handoffs, schedules, checkpoints, cost meters, tool timelines, and allowlisted generative UI. Include the durable agentId on any real Symphony agent or agent-specific job so users can open its native conversation.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("speaker-identity"), Type.Literal("diagram"), Type.Literal("flow-graph"), Type.Literal("spec-sheet"), Type.Literal("timeline"), Type.Literal("job-progress"), Type.Literal("score-breakdown"), Type.Literal("agent-plan"), Type.Literal("subagent-list"), Type.Literal("recommendation-card"), Type.Literal("handoff"), Type.Literal("schedule"), Type.Literal("checkpoints"), Type.Literal("cost-meter"), Type.Literal("tool-timeline"), Type.Literal("generative-ui")]),
      data: Type.Record(Type.String(), Type.Unknown()),
    }),
    async execute(_id, params) { return response(await api(`/v1/agents/${encodeURIComponent(agentId ?? "")}/present`, { method: "POST", body: JSON.stringify(params) })); },
  });

  pi.registerTool({
    name: "send_message",
    label: "Message Symphony agent",
    description: "Steer or follow up with an existing durable Symphony agent. This message crosses native-harness boundaries only through the authenticated Symphony graph; it does not make an ephemeral Pi subagent durable.",
    parameters: Type.Object({ targetAgentId: Type.String(), content: Type.String() }),
    async execute(id, params) {
      return response(await api(
        `/v1/agents/${encodeURIComponent(params.targetAgentId)}/messages`,
        mutation("send-message", id, { content: params.content }),
      ));
    },
  });

  pi.registerTool({
    name: "observe_agent",
    label: "Observe Symphony agent",
    description: "Passively summarize another durable Symphony agent without interrupting its native harness. Native Pi subagent context is not silently promoted into the Symphony graph.",
    parameters: Type.Object({
      targetAgentId: Type.String(),
      level: Type.Optional(Type.Union([Type.Literal("tldr"), Type.Literal("paragraph"), Type.Literal("full")], { default: "tldr" })),
    }),
    async execute(_id, params) { return response(await api(`/v1/agents/${encodeURIComponent(params.targetAgentId)}/observe?level=${params.level ?? "tldr"}`)); },
  });

  pi.registerTool({
    name: "get_session_logs",
    label: "Inspect Symphony session logs",
    description: "Read durable native lifecycle logs for a Symphony agent without interrupting it. Use this to diagnose failures or stalled sessions.",
    parameters: Type.Object({
      targetAgentId: Type.String(),
      after: Type.Optional(Type.Number({ minimum: 0, default: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2000, default: 500 })),
    }),
    async execute(_id, params) { return response(await api(`/v1/agents/${encodeURIComponent(params.targetAgentId)}/logs?after=${params.after ?? 0}&limit=${params.limit ?? 500}`)); },
  });

  pi.registerTool({
    name: "cancel_agent",
    label: "Cancel Symphony agent",
    description: "Cancel an active Symphony agent in its native harness.",
    parameters: Type.Object({ targetAgentId: Type.String() }),
    async execute(id, params) {
      await api(`/v1/agents/${encodeURIComponent(params.targetAgentId)}/cancel`, mutation("cancel-agent", id, {}));
      return response({ cancelled: true, targetAgentId: params.targetAgentId });
    },
  });

  pi.registerTool({
    name: "list_workflows",
    label: "List Symphony workflows",
    description: "List registered dynamic Symphony workflows and their immutable revisions.",
    parameters: Type.Object({}),
    async execute() { return response(await api("/v1/workflows")); },
  });

  pi.registerTool({
    name: "run_workflow",
    label: "Run Symphony workflow",
    description: "Start a registered durable workflow with JSON input. Read-only callers cannot start workflows.",
    parameters: Type.Object({ workflowId: Type.String(), input: Type.Optional(Type.Unknown({ default: {} })) }),
    async execute(id, params) {
      return response(await api(
        `/v1/workflows/${encodeURIComponent(params.workflowId)}/runs`,
        mutation("run-workflow", id, params.input ?? {}),
      ));
    },
  });

  pi.registerTool({
    name: "cancel_run",
    label: "Cancel Symphony workflow run",
    description: "Request cancellation of a durable Symphony workflow run.",
    parameters: Type.Object({ runId: Type.String() }),
    async execute(id, params) {
      return response(await api(
        `/v1/runs/${encodeURIComponent(params.runId)}/cancel`,
        mutation("cancel-run", id, {}),
      ));
    },
  });

  pi.registerTool({
    name: "list_plugin_tools",
    label: "List Symphony plugin tools",
    description: "List tools contributed by trusted, currently active local Symphony plugins.",
    parameters: Type.Object({}),
    async execute() { return response(await api("/v1/plugin-tools")); },
  });

  pi.registerTool({
    name: "call_plugin_tool",
    label: "Call Symphony plugin tool",
    description: "Call a trusted local plugin tool. Read-only callers cannot invoke plugin tools.",
    parameters: Type.Object({ name: Type.String(), arguments: Type.Optional(Type.Unknown({ default: {} })) }),
    async execute(id, params) {
      return response(await api(
        `/v1/plugin-tools/${encodeURIComponent(params.name)}`,
        mutation("call-plugin-tool", id, params.arguments ?? {}),
      ));
    },
  });
}
