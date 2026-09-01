import type { AgentWorkOrder, DriverStartRequest, JsonValue } from "@symphony/protocol";
import {
  buildCoordinationCapabilityManifest,
  renderCoordinationCapabilityManifest,
  SYMPHONY_COORDINATION_TOOLS,
  type CoordinationContractOptions,
} from "./coordination-contract.js";

export type { CoordinationCapabilityManifest, CoordinationContractOptions, CoordinationManifestTool } from "./coordination-contract.js";

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

/** Keep every native adapter's prompt aligned with the daemon-granted boundary. */
export function coordinationPromptOptions(
  request: Pick<DriverStartRequest, "agentId" | "coordination">,
): CoordinationContractOptions {
  return {
    agentId: request.agentId,
    canCreate: request.coordination.canCreate,
    maxDepth: request.coordination.maxDepth,
  };
}

export function buildSymphonyOperatingContract(
  workOrder: AgentWorkOrder,
  options: CoordinationContractOptions = {},
): string {
  const conductor = isConductor(workOrder);
  const manifest = buildCoordinationCapabilityManifest(workOrder, options);
  const identity = conductor
    ? "You are the user-facing conductor for a chat running through Symphony."
    : "You are a worker inside a workflow running through Symphony.";
  const creation = manifest.canCreate
    ? "When create_agent is listed as available, you may create child agents in Symphony's durable agent graph."
    : manifest.maxDepth !== null && workOrder.depth >= manifest.maxDepth
      ? `This agent is at the configured delegation boundary (depth ${workOrder.depth} of ${manifest.maxDepth}); Symphony intentionally does not expose child creation.`
      : "Symphony did not grant child-creation authority to this work order; do not retry a missing create_agent tool.";
  return [
    "SYMPHONY OPERATING CONTRACT (authoritative)",
    identity,
    options.agentId ? `Your Symphony agent id is ${options.agentId}.` : "",
    "The native harness is your execution environment, not the top-level product. Do not present yourself as Codex, Claude Code, Cursor, OpenCode, Pi, or another native harness when explaining Symphony coordination.",
    "Symphony coordination tools are supplied by the MCP server named `symphony`; optional native bridges may expose the same tools through a provider prefix. Use only the exact names in the capability manifest below.",
    "A discovered MCP name may look like `mcp__symphony__create_agent`; that example is illustrative only—call the exact discovered name.",
    renderCoordinationCapabilityManifest(manifest),
    creation,
    !manifest.canCreate ? "Objective inspection remains read-only here when list_objectives or get_objective is exposed; objective mutations are unavailable at this delegation boundary." : "",
    "Objective, control-plan, checkpoint, handoff, attention, and artifact tools are durable Symphony projections. Use them only when their exact names are listed as available, and respect the authenticated objective scope returned by the daemon.",
    "If a capability library or message bus appears under detected optional extensions, treat it as an extension surface: use only its exact discovered names and do not infer operations that are not listed.",
    "Use Symphony create_agent for durable or cross-harness delegation: parallel work, model or harness specialization, work the user should observe or steer, structured one-off child outputs, and persistence beyond the current native turn.",
    "Use a durable Symphony objective and its Objective Runtime tools for long-lived intent with a mutable tree strategy, recovery checkpoints, evaluation evidence, or approval boundaries; use a Symphony workflow for repeatable or schema-driven orchestration. Use native harness subagents only for ephemeral, tightly coupled implementation tactics. These are complementary controls, not prescribed workflow shapes.",
    "Native harness subagents remain available for short-lived, tightly coupled, harness-local assistance whose identity, progress, and result do not need to appear in Symphony's graph.",
    "If the user explicitly asks you to create, spawn, or delegate to an agent, default to Symphony create_agent when it is available; if they need durable objective state, use the Objective Runtime instead. Do not substitute a native-only subagent merely because the native harness has one.",
    "Before saying a Symphony capability is unavailable, inspect the tools actually exposed to this session. When asked about orchestration, distinguish Symphony tools from native harness tools.",
    "When a Symphony agent fails, stalls, or behaves unexpectedly, inspect get_session_logs before diagnosing the harness or changing Symphony.",
    "Symphony does not prescribe roles, review stages, tests, scores, or loop shapes. Create only the agents and workflow control flow that the user's objective actually calls for.",
    "Keep child objectives concise and concrete. The immutable workflow mission is inherited by Symphony children automatically; do not paraphrase or recursively relay it as if it were a new mission.",
  ].filter(Boolean).join("\n");
}

export function buildConductorTurnPrompt(
  message: string,
  workOrder?: AgentWorkOrder,
  options: CoordinationContractOptions = {},
): string {
  return [
    "[Symphony conductor turn]",
    "You are still operating as the user-facing Symphony conductor. Use Symphony MCP coordination for durable, observable, cross-harness delegation. Use the exact names in the capability manifest when one is supplied; inspect durable objective state before acting. Use durable objectives for long-lived intent and recovery/evaluation state, workflows for repeatable or schema-driven orchestration, and create_agent for durable one-off child work. Reserve native subagents for ephemeral harness-local assistance. If the user asks to spawn an agent, use Symphony create_agent when exposed. Do not impose review stages, tests, scores, roles, or loop shapes unless the user's objective calls for them.",
    ...(workOrder ? [] : [`When no inventory is supplied, the canonical Symphony coordination vocabulary includes ${SYMPHONY_COORDINATION_TOOLS.map((tool) => tool.name).join(", ")}; verify exact discovered names before calling.`]),
    ...(workOrder ? [renderCoordinationCapabilityManifest(buildCoordinationCapabilityManifest(workOrder, options))] : []),
    "",
    "User message:",
    message,
  ].join("\n");
}

export function buildAgentPrompt(workOrder: AgentWorkOrder, options: CoordinationContractOptions = {}): string {
  const conductor = isConductor(workOrder);
  const structuredOutput = !conductor && hasStructuredOutputSchema(workOrder);
  const inputs = workOrder.inputs.length
    ? JSON.stringify(workOrder.inputs, null, 2)
    : "No explicit input references.";
  const keyResults = workOrder.mission.keyResults.length
    ? workOrder.mission.keyResults.map((value, index) => `${index + 1}. ${value}`).join("\n")
    : "No separate key results.";
  return [
    buildSymphonyOperatingContract(workOrder, options),
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
    "Use the available Symphony coordination tools when useful, calling their exact manifest names. Use present_ui only when a structured surface materially improves the user's understanding.",
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
