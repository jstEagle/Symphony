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

export default function symphonyPiExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "list_agents",
    label: "List Symphony agents",
    description: "List durable agents in the Symphony graph with objectives, parents, models, and states. Native Pi subagents may not appear here.",
    parameters: Type.Object({ activeOnly: Type.Optional(Type.Boolean({ default: false })) }),
    async execute(_id, params) { return response(await api(`/v1/agents?active=${String(params.activeOnly ?? false)}`)); },
  });

  if (canCreate) pi.registerTool({
    name: "create_agent",
    label: "Create Symphony agent",
    description: "Create a durable, observable Symphony child for parallel, cross-harness, specialized, or structured work. Mission, depth, and parent are injected by Symphony.",
    parameters: Type.Object({
      objective: Type.String(),
      harness: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("codex"), Type.Literal("claude"), Type.Literal("cursor"), Type.Literal("opencode"), Type.Literal("pi"), Type.Literal("acp")], { default: "auto" })),
      model: Type.Optional(Type.String({ default: "auto" })),
      permissions: Type.Optional(Type.Union([Type.Literal("full-access"), Type.Literal("read-only")])),
      outputSchema: Type.Record(Type.String(), Type.Unknown()),
    }),
    async execute(_id, params) { return response(await api("/v1/agents", { method: "POST", body: JSON.stringify(params) })); },
  });

  pi.registerTool({
    name: "present_ui",
    label: "Present Symphony UI",
    description: "Present optional structured UI in the current Symphony chat. Supported kinds include speaker identity, diagrams, flow graphs, spec sheets, timelines, job progress, score breakdowns, plans, subagent lists, recommendations, handoffs, schedules, checkpoints, cost meters, tool timelines, and allowlisted generative UI.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("speaker-identity"), Type.Literal("diagram"), Type.Literal("flow-graph"), Type.Literal("spec-sheet"), Type.Literal("timeline"), Type.Literal("job-progress"), Type.Literal("score-breakdown"), Type.Literal("agent-plan"), Type.Literal("subagent-list"), Type.Literal("recommendation-card"), Type.Literal("handoff"), Type.Literal("schedule"), Type.Literal("checkpoints"), Type.Literal("cost-meter"), Type.Literal("tool-timeline"), Type.Literal("generative-ui")]),
      data: Type.Record(Type.String(), Type.Unknown()),
    }),
    async execute(_id, params) { return response(await api(`/v1/agents/${encodeURIComponent(agentId ?? "")}/present`, { method: "POST", body: JSON.stringify(params) })); },
  });

  pi.registerTool({
    name: "send_message",
    label: "Message Symphony agent",
    description: "Steer or follow up with an existing Symphony agent.",
    parameters: Type.Object({ targetAgentId: Type.String(), content: Type.String() }),
    async execute(_id, params) { return response(await api(`/v1/agents/${encodeURIComponent(params.targetAgentId)}/messages`, { method: "POST", body: JSON.stringify({ content: params.content }) })); },
  });

  pi.registerTool({
    name: "observe_agent",
    label: "Observe Symphony agent",
    description: "Passively summarize another agent without interrupting its native harness.",
    parameters: Type.Object({
      targetAgentId: Type.String(),
      level: Type.Optional(Type.Union([Type.Literal("tldr"), Type.Literal("paragraph"), Type.Literal("full")], { default: "tldr" })),
    }),
    async execute(_id, params) { return response(await api(`/v1/agents/${encodeURIComponent(params.targetAgentId)}/observe?level=${params.level ?? "tldr"}`)); },
  });

  pi.registerTool({
    name: "cancel_agent",
    label: "Cancel Symphony agent",
    description: "Cancel an active Symphony agent in its native harness.",
    parameters: Type.Object({ targetAgentId: Type.String() }),
    async execute(_id, params) {
      await api(`/v1/agents/${encodeURIComponent(params.targetAgentId)}/cancel`, { method: "POST" });
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
    async execute(_id, params) { return response(await api(`/v1/workflows/${encodeURIComponent(params.workflowId)}/runs`, { method: "POST", body: JSON.stringify(params.input ?? {}) })); },
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
    async execute(_id, params) { return response(await api(`/v1/plugin-tools/${encodeURIComponent(params.name)}`, { method: "POST", body: JSON.stringify(params.arguments ?? {}) })); },
  });
}
