import type { AgentWorkOrder, JsonValue } from "@symphony/protocol";

export function isConductor(workOrder: AgentWorkOrder): boolean {
  const metadata = workOrder.metadata;
  return workOrder.depth === 0
    && metadata !== undefined
    && metadata !== null
    && typeof metadata === "object"
    && !Array.isArray(metadata)
    && typeof metadata.threadId === "string";
}

export function hasStructuredOutputSchema(workOrder: AgentWorkOrder): boolean {
  return Object.keys(workOrder.outputSchema).length > 0;
}

export function buildSymphonyOperatingContract(
  workOrder: AgentWorkOrder,
  options: { agentId?: string; canCreate?: boolean } = {},
): string {
  const conductor = isConductor(workOrder);
  const identity = conductor
    ? "You are the user-facing conductor for a chat running through Symphony."
    : "You are a worker inside a workflow running through Symphony.";
  const creation = options.canCreate === false
    ? "This agent is at the configured delegation boundary, so Symphony's create_agent tool is intentionally unavailable."
    : "When create_agent is exposed, you may create child agents in Symphony's durable agent graph.";
  return [
    "SYMPHONY OPERATING CONTRACT (authoritative)",
    identity,
    options.agentId ? `Your Symphony agent id is ${options.agentId}.` : "",
    "The native harness is your execution environment, not the top-level product. Do not present yourself as Codex, Claude Code, Cursor, OpenCode, Pi, or another native harness when explaining Symphony coordination.",
    "Symphony coordination tools are supplied by the MCP server named `symphony`. Their discovered names may be prefixed, such as `symphony.create_agent` or `mcp__symphony__create_agent`; use the exact discovered tool name.",
    "Available Symphony primitives include list_agents, create_agent (when delegation depth permits), send_message, observe_agent, get_session_logs, cancel_agent, present_ui, and workflow tools.",
    creation,
    "Use Symphony create_agent for durable or cross-harness delegation: parallel work, model or harness specialization, work the user should observe or steer, structured workflow outputs, and persistence beyond the current native turn.",
    "Native harness subagents remain available for short-lived, tightly coupled, harness-local assistance whose identity, progress, and result do not need to appear in Symphony's graph.",
    "If the user explicitly asks you to create, spawn, or delegate to an agent, default to Symphony create_agent when it is available. Do not substitute a native-only subagent merely because the native harness has one.",
    "Before saying a Symphony capability is unavailable, inspect the tools actually exposed to this session. When asked about orchestration, distinguish Symphony tools from native harness tools.",
    "When a Symphony agent fails, stalls, or behaves unexpectedly, inspect get_session_logs before diagnosing the harness or changing Symphony.",
    "Symphony does not prescribe roles, review stages, tests, scores, or loop shapes. Create only the agents and workflow control flow that the user's objective actually calls for.",
    "Keep child objectives concise and concrete. The immutable workflow mission is inherited by Symphony children automatically; do not paraphrase or recursively relay it as if it were a new mission.",
  ].filter(Boolean).join("\n");
}

export function buildConductorTurnPrompt(message: string): string {
  return [
    "[Symphony conductor turn]",
    "You are still operating as the user-facing Symphony conductor. Use Symphony MCP coordination for durable, observable, cross-harness delegation; reserve native subagents for ephemeral harness-local assistance. If the user asks to spawn an agent, use Symphony create_agent when exposed. Do not impose review stages, tests, scores, roles, or loop shapes unless the user's objective calls for them.",
    "",
    "User message:",
    message,
  ].join("\n");
}

export function buildAgentPrompt(workOrder: AgentWorkOrder): string {
  const conductor = isConductor(workOrder);
  const structuredOutput = !conductor && hasStructuredOutputSchema(workOrder);
  const inputs = workOrder.inputs.length
    ? JSON.stringify(workOrder.inputs, null, 2)
    : "No explicit input references.";
  const keyResults = workOrder.mission.keyResults.length
    ? workOrder.mission.keyResults.map((value, index) => `${index + 1}. ${value}`).join("\n")
    : "No separate key results.";
  return [
    buildSymphonyOperatingContract(workOrder),
    "",
    "Workflow mission (immutable for this run):",
    workOrder.mission.statement,
    "",
    "Key results:",
    keyResults,
    `Mission revision: ${workOrder.mission.revision}; mission hash: ${workOrder.mission.hash}`,
    "",
    "Your objective:",
    workOrder.objective,
    "",
    "Inputs:",
    inputs,
    "",
    conductor || !structuredOutput ? "Response contract:" : "Required final output JSON Schema:",
    conductor
      ? "Respond naturally to the user. Symphony streams this response into the chat as it is produced."
      : structuredOutput
        ? JSON.stringify(workOrder.outputSchema, null, 2)
        : "No structured output schema was requested. Return the clearest useful final response for the objective.",
    "",
    conductor
      ? "Complete the objective in the specified workspace and give the user a direct response."
      : structuredOutput
        ? "Complete the objective in the specified workspace. Your final response must satisfy the output schema."
        : "Complete the objective in the specified workspace and return a direct final response.",
    "Use Symphony's coordination tools when useful: list_agents, create_agent, send_message, observe_agent, get_session_logs, and present_ui. Use present_ui only when a structured surface materially improves the user's understanding.",
    "Keep delegated objectives short and preserve the workflow mission. Do not invent a role or rewrite the mission.",
  ].join("\n");
}

export function extractStructuredOutput(text: string): JsonValue {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  for (const candidate of [trimmed, fenced]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as JsonValue;
    } catch {
      // Preserve native text when a harness did not produce valid JSON.
    }
  }
  return { text };
}
