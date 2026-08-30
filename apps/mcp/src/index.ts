#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

const daemonUrl = process.env.SYMPHONY_DAEMON_URL;
const agentId = process.env.SYMPHONY_AGENT_ID;
const agentToken = process.env.SYMPHONY_AGENT_TOKEN;
const canCreate = process.env.SYMPHONY_AGENT_CAN_CREATE === "true";

if (!daemonUrl || !agentId || !agentToken) {
  process.stderr.write("symphony-mcp requires SYMPHONY_DAEMON_URL, SYMPHONY_AGENT_ID, and SYMPHONY_AGENT_TOKEN.\n");
  process.exit(1);
}

const headers = {
  "content-type": "application/json",
  "x-symphony-agent-id": agentId,
  "x-symphony-agent-token": agentToken,
};

async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(new URL(path, daemonUrl), { ...options, headers: { ...headers, ...options.headers } });
  const text = await response.text();
  const value = text ? JSON.parse(text) as unknown : null;
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return value;
}

function result(value: unknown) {
  const structuredContent = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent };
}

const server = new McpServer({ name: "symphony", version: "0.1.0" });

server.registerTool("list_agents", {
  description: "List durable agents in the current Symphony graph. Use this to discover observable cross-harness work; native harness subagents may not appear here. Returns each agent's short objective, parent, depth, native harness/model, and state.",
  inputSchema: {
    activeOnly: z.boolean().default(false).describe("Only return agents that have not reached a terminal state."),
  },
}, async ({ activeOnly }) => result(await api(`/v1/agents?active=${String(activeOnly)}`)));

if (canCreate) server.registerTool("create_agent", {
  description: "Create a durable, observable child in Symphony's agent graph for parallel, cross-harness, specialized, or structured work. Symphony neutrally selects a native harness/model when they are auto. The workflow mission and parent relationship are injected by the daemon.",
  inputSchema: {
    objective: z.string().min(1).describe("A concise objective containing the process and concrete goal."),
    harness: z.enum(["auto", "codex", "claude", "cursor", "opencode", "pi", "acp"]).default("auto"),
    model: z.string().default("auto"),
    permissions: z.enum(["full-access", "read-only"]).optional().describe("Defaults to full-access, but cannot exceed a read-only parent's permission."),
    outputSchema: z.record(z.string(), z.unknown()).describe("JSON Schema for the child's final result."),
    routing: z.object({
      taskKind: z.enum(["frontend", "coding", "research", "summarization", "general"]).optional(),
      prioritize: z.array(z.enum(["human-preference", "intelligence", "coding-success", "agentic-success", "lowest-cost-per-task", "fewest-turns", "large-context"])).optional(),
    }).optional(),
  },
}, async (input) => result(await api("/v1/agents", { method: "POST", body: JSON.stringify(input) })));

server.registerTool("present_ui", {
  description: "Present structured information in the Symphony chat when a visual surface materially improves comprehension. Kinds and core data shapes: speaker-identity {turns}; diagram {title,content}; flow-graph {nodes,edges,visibleCount}; spec-sheet {title,subtitle,rows}; timeline {events}; job-progress {title,stages,stageIndex,stageProgress,eta}; score-breakdown {verdict,total,outOf,criteria}; agent-plan {steps,activeIndex}; subagent-list {agents,completedCount,progress,showSummary,summaryAgent}; recommendation-card {question,body,confidenceLabel}; handoff {from,to,reason,carried,settled}; schedule {name,cadence,nextRun,enabled,history}; checkpoints {checkpoints,currentId}; cost-meter {runCost,sessionCost,lines}; tool-timeline {steps,stats,streaming}; generative-ui {tree} where tree uses the allowlisted assistant-ui $type vocabulary. This is optional presentation, not a workflow instruction.",
  inputSchema: {
    kind: z.enum(["speaker-identity", "diagram", "flow-graph", "spec-sheet", "timeline", "job-progress", "score-breakdown", "agent-plan", "subagent-list", "recommendation-card", "handoff", "schedule", "checkpoints", "cost-meter", "tool-timeline", "generative-ui"]),
    data: z.record(z.string(), z.unknown()),
  },
}, async (input) => result(await api(`/v1/agents/${encodeURIComponent(agentId)}/present`, { method: "POST", body: JSON.stringify(input) })));

server.registerTool("send_message", {
  description: "Steer or follow up with an existing durable Symphony agent without creating a new graph node.",
  inputSchema: { targetAgentId: z.string().min(1), content: z.string().min(1) },
}, async ({ targetAgentId, content }) => result(await api(`/v1/agents/${encodeURIComponent(targetAgentId)}/messages`, { method: "POST", body: JSON.stringify({ content }) })));

server.registerTool("observe_agent", {
  description: "Passively summarize an agent's native event history without interrupting it. Use tldr for one sentence, paragraph for status context, or full for an evidence-linked breakdown.",
  inputSchema: { targetAgentId: z.string().min(1), level: z.enum(["tldr", "paragraph", "full"]).default("tldr") },
}, async ({ targetAgentId, level }) => result(await api(`/v1/agents/${encodeURIComponent(targetAgentId)}/observe?level=${level}`)));

server.registerTool("cancel_agent", {
  description: "Request cancellation of an active agent in its native harness.",
  inputSchema: { targetAgentId: z.string().min(1) },
}, async ({ targetAgentId }) => {
  await api(`/v1/agents/${encodeURIComponent(targetAgentId)}/cancel`, { method: "POST" });
  return result({ cancelled: true, targetAgentId });
});

server.registerTool("list_workflows", {
  description: "List registered dynamic Symphony workflows and their immutable revisions.",
  inputSchema: {},
}, async () => result(await api("/v1/workflows")));

server.registerTool("run_workflow", {
  description: "Start a registered dynamic workflow with JSON input.",
  inputSchema: { workflowId: z.string().min(1), input: z.unknown().default({}) },
}, async ({ workflowId, input }) => result(await api(`/v1/workflows/${encodeURIComponent(workflowId)}/runs`, { method: "POST", body: JSON.stringify(input) })));

server.registerTool("list_plugin_tools", {
  description: "List tools contributed by trusted, currently active local Symphony/Pi-compatible plugins.",
  inputSchema: {},
}, async () => result(await api("/v1/plugin-tools")));

server.registerTool("call_plugin_tool", {
  description: "Call a tool contributed by a trusted local plugin. List tools first and pass the plugin tool's documented JSON arguments.",
  inputSchema: { name: z.string().min(1), arguments: z.unknown().default({}) },
}, async ({ name, arguments: toolArguments }) => result(await api(`/v1/plugin-tools/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify(toolArguments) })));

await server.connect(new StdioServerTransport());
