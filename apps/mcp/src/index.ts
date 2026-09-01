#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import {
  IdSchema,
  IsoDateSchema,
  JsonValueSchema,
  ObjectiveControlNodeSchema,
  ObjectiveControlPlanSchema,
  ObjectiveControlSignalDeliveryInputSchema,
  ObjectiveSideEffectClassSchema,
  ObjectiveSpecSchema,
  ObjectiveTaskSchema,
  ObjectiveArtifactKindSchema,
  ObjectiveArtifactEvidenceSchema,
  ObjectiveHandoffCreateInputSchema,
  ObjectiveHandoffAcceptanceInputSchema,
  AgentMessageInputSchema,
  CapabilityDefinitionSchema,
  CapabilityIdSchema,
  CapabilityProvenanceSchema,
  CapabilityVersionSchema,
  CapabilityCompatibilityTargetSchema,
  CapabilityTriggerBindingSchema,
} from "@symphony/protocol";

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

function mutation(tool: string, requestId: string | number, body: unknown): RequestInit {
  // MCP request IDs are stable across a retry of one logical tool call and
  // unique between calls. Keeping the key derived from that ID lets the
  // daemon replay a retry without creating a second durable action.
  const requestKey = `mcp:${agentId}:${tool}:${String(requestId)}`;
  if (requestKey.length < 8) throw new Error("MCP mutations require a fresh request ID.");
  return {
    method: "POST",
    headers: { "idempotency-key": requestKey },
    body: JSON.stringify(body),
  };
}

/**
 * Objective mutation inputs intentionally omit actor and request-key fields.
 * The daemon derives both from the authenticated Symphony agent capability and
 * the Idempotency-Key header, respectively.
 */
const ObjectiveCreateInputSchema = z.object({
  runId: IdSchema.optional().describe("Optional stable durable run ID; omit to let the daemon generate one."),
  objectiveId: IdSchema.optional().describe("Optional stable objective ID; defaults to spec.id."),
  workflowId: IdSchema.describe("The registered workflow whose revision anchors this run."),
  workflowRevision: z.number().int().positive(),
  workflowHash: z.string().min(8),
  conductorAgentId: IdSchema.nullable().optional().describe("Optional conductor agent identity for an explicitly owned run; the daemon verifies it against the caller."),
  spec: ObjectiveSpecSchema,
  tasks: z.array(ObjectiveTaskSchema).max(128).default([]),
  context: z.record(z.string(), JsonValueSchema).default({}),
  controlPlan: ObjectiveControlPlanSchema.nullable().optional().describe("Optional initial tree-shaped objective strategy; the daemon pins and validates it during admission. Control fanout nodes are executable durable map steps: source resolves a runtime array, itemTemplate receives item/itemIndex/itemKey bindings, concurrency is a positive integer or null for unlimited, and results reduce deterministically."),
}).strict();

const ObjectivePlanCommitInputSchema = z.object({
  runId: IdSchema.describe("The durable objective run to extend."),
  expectedPlanRevision: z.number().int().nonnegative(),
  tasks: z.array(ObjectiveTaskSchema).min(1).max(128),
  reason: z.string().min(1).max(2_000).optional(),
}).strict();

const ObjectiveTaskUpdateSchema = z.object({
  taskId: IdSchema,
  state: z.enum(["queued", "waiting-approval", "running", "completed", "failed"]),
  attemptId: IdSchema.nullable().optional(),
  agentId: IdSchema.nullable().optional(),
  output: JsonValueSchema.nullable().optional(),
  error: z.string().nullable().optional(),
  startedAt: IsoDateSchema.nullable().optional(),
  finishedAt: IsoDateSchema.nullable().optional(),
}).strict();

const ObjectiveCheckpointInputSchema = z.object({
  runId: IdSchema.describe("The durable objective run to checkpoint."),
  eventCursor: z.number().int().nonnegative(),
  context: z.record(z.string(), JsonValueSchema).optional(),
  taskUpdates: z.array(ObjectiveTaskUpdateSchema).max(128).default([]),
  reason: z.string().min(1).max(2_000),
}).strict();

const ObjectiveCheckpointResumeInputSchema = z.object({
  runId: IdSchema,
  checkpointId: IdSchema,
  expectedSequence: z.number().int().positive().optional(),
  attemptId: IdSchema.nullable().optional(),
}).strict();
const ObjectiveCheckpointRetryInputSchema = z.object({
  runId: IdSchema,
  checkpointId: IdSchema,
  activity: z.object({
    kind: z.enum(["task", "control"]),
    id: IdSchema,
    attemptId: IdSchema.nullable().optional(),
  }).strict(),
  expectedSequence: z.number().int().positive().optional(),
}).strict();
const ObjectiveCheckpointForkInputSchema = z.object({
  runId: IdSchema,
  checkpointId: IdSchema,
  newRunId: IdSchema.optional(),
  occurrenceKey: z.string().min(1).max(512).optional(),
  reason: z.string().min(1).max(2_000),
}).strict();

const ObjectiveApprovalRequestInputSchema = z.object({
  runId: IdSchema.describe("The durable objective run that must wait for this decision."),
  kind: z.enum(["plan", "task", "completion"]),
  taskId: IdSchema.nullable().optional(),
  question: z.string().min(1).max(2_000),
  scope: z.record(z.string(), JsonValueSchema).default({}),
  operationId: IdSchema,
  requestHash: z.string().min(8).max(256),
  policyHash: z.string().min(8).max(256),
  sideEffectClass: ObjectiveSideEffectClassSchema,
  canonicalTarget: z.string().min(1).max(2_000),
  expiresAt: IsoDateSchema.nullable().optional(),
}).strict().superRefine((input, context) => {
  if (input.kind === "task" && (input.taskId === undefined || input.taskId === null)) {
    context.addIssue({ code: "custom", path: ["taskId"], message: "Task approvals require a task id." });
  }
  if (input.kind !== "task" && input.taskId !== undefined && input.taskId !== null) {
    context.addIssue({ code: "custom", path: ["taskId"], message: "Only task approvals may identify a task." });
  }
  if ((input.sideEffectClass === "external" || input.sideEffectClass === "irreversible") && (input.expiresAt === undefined || input.expiresAt === null)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: `Approval expiry is required for ${input.sideEffectClass} operations.` });
  }
});

// MCP transports expose object-shaped JSON schemas more consistently than a
// top-level discriminated union. The daemon performs the authoritative typed
// variant parse after binding run identity, actor, and request key.
const ObjectiveStrategyMutationInputSchema = z.object({
  runId: IdSchema.describe("The durable objective run whose strategy is being revised."),
  type: z.enum(["insert-node", "replace-node", "set-loop-bound", "remove-subtree", "rewire-dependencies", "insert-branch", "replace-branch", "insert-evaluate", "insert-evaluator", "insert-timer", "insert-signal", "insert-checkpoint", "insert-artifact"]),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().min(1).max(2_000),
  evidence: z.object({
    eventCursor: z.number().int().nonnegative(),
    eventIds: z.array(IdSchema).max(256).default([]),
    summary: z.string().max(2_000).optional(),
  }).strict().default({ eventCursor: 0, eventIds: [] }),
  parentId: IdSchema.optional(),
  slot: z.enum(["steps", "then", "else"]).optional(),
  position: z.number().int().nonnegative().optional(),
  nodeId: IdSchema.optional(),
  branchNodeId: IdSchema.optional(),
  branch: z.enum(["then", "else"]).optional(),
  dependsOn: z.array(IdSchema).max(256).optional(),
  cancellationIntent: z.object({
    type: z.literal("cancel-active-attempts"),
    reason: z.string().min(1).max(2_000),
    preserveLineage: z.literal(true),
  }).strict().optional(),
  maxIterations: z.number().int().positive().optional(),
  node: ObjectiveControlNodeSchema.optional().describe("Typed strategy node. A fanout node is an executable durable map: it resolves a runtime array at source, runs itemTemplate with item/itemIndex/itemKey bindings, accepts a positive concurrency cap or null for unlimited concurrency, and reduces results as an array, keyed object, or merged object."),
}).strict();

const ObjectiveSignalDeliveryInputSchema = z.object({
  runId: IdSchema.describe("The durable objective run waiting for this signal."),
  ...ObjectiveControlSignalDeliveryInputSchema.shape,
}).strict();

const ObjectiveArtifactPublishInputSchema = z.object({
  planRevision: z.number().int().nonnegative().describe("The objective plan revision that produced this artifact."),
  kind: ObjectiveArtifactKindSchema.describe("Stable semantic artifact kind, for example test-result, diff, or evidence."),
  name: z.string().min(1).max(500),
  mediaType: z.string().min(1).max(200),
  content: JsonValueSchema.describe("Bounded inline JSON content; file bytes and filesystem paths are not accepted."),
  evidence: ObjectiveArtifactEvidenceSchema,
  taskId: IdSchema.nullable().optional(),
  attemptId: IdSchema.nullable().optional(),
  controlNodeId: IdSchema.nullable().optional(),
  lineage: z.array(IdSchema).max(128).default([]),
  supersedes: IdSchema.nullable().default(null),
  policyHash: z.string().min(8).max(256).optional(),
}).strict();

/**
 * Capability and message mutations are intentionally caller-shaped rather
 * than storage-shaped. The daemon binds the authenticated actor and the
 * Idempotency-Key header; MCP callers must not be able to impersonate either.
 */
const CapabilityCreateInputSchema = z.object({
  capabilityId: CapabilityIdSchema.describe("Stable capability identifier."),
  version: CapabilityVersionSchema.optional().describe("Optional explicit contiguous version; omit for the next version."),
  definition: CapabilityDefinitionSchema,
  provenance: CapabilityProvenanceSchema,
}).strict();

const CapabilityVersionInputSchema = z.object({
  capabilityId: CapabilityIdSchema,
  version: CapabilityVersionSchema,
}).strict();

const CapabilityActivationInputSchema = z.object({
  capabilityId: CapabilityIdSchema,
  version: CapabilityVersionSchema,
  parameters: JsonValueSchema.optional().describe("Concrete typed capability parameters; declarative defaults are applied when omitted.") ,
  triggers: z.array(CapabilityTriggerBindingSchema).max(256).optional().describe("Daemon-validated trigger bindings for this activation."),
  target: CapabilityCompatibilityTargetSchema.optional(),
}).strict();

const CapabilityPrepareInputSchema = z.object({
  capabilityId: CapabilityIdSchema,
  version: CapabilityVersionSchema,
  parameters: z.json(),
  target: CapabilityCompatibilityTargetSchema.optional(),
}).strict();

// AgentMessageInputSchema has cross-field refinements, so Zod 4 disallows
// `.omit()` on it. Reusing its exact field shapes keeps MCP's object schema
// aligned while intentionally removing only the daemon-owned request key.
const { requestKey: _agentMessageRequestKey, ...agentMessageSendShape } = AgentMessageInputSchema.shape;
const AgentMessageSendInputSchema = z.object(agentMessageSendShape).strict();
const AgentMessageIdInputSchema = z.object({ messageId: z.string().min(1).max(512) }).strict();
const AgentMessageListInputSchema = z.object({
  afterCursor: z.number().int().min(0).optional(),
  beforeCursor: z.number().int().positive().optional(),
  senderId: z.string().min(1).max(512).optional(),
  recipientId: z.string().min(1).max(512).optional(),
  objectiveId: z.string().min(1).max(512).optional(),
  runId: z.string().min(1).max(512).optional(),
  kind: z.enum(["finding", "question", "status", "handoff", "control-request"]).optional(),
  limit: z.number().int().min(1).max(2_000).default(500),
}).strict();
const AgentMessageReceiptInputSchema = z.object({
  reason: z.string().max(4_000).optional(),
}).strict();
const AgentMessageDeliveryInputSchema = AgentMessageReceiptInputSchema.extend({
  state: z.enum(["delivered", "failed"]).default("delivered"),
}).strict();
const AgentMessageUnknownInputSchema = z.object({ reason: z.string().min(1).max(4_000) }).strict();
const AgentMessageHandleInputSchema = z.object({
  decision: z.enum(["acknowledged", "accepted", "rejected", "deferred", "cancelled"]),
  reason: z.string().max(4_000).optional(),
}).strict();
const SessionDiagnosticsInputSchema = z.object({
  targetAgentId: z.string().min(1).max(512),
}).strict();

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
}, async (input, extra) => result(await api("/v1/agents", mutation("create-agent", extra.requestId, input))));

server.registerTool("present_ui", {
  description: "Present structured information in the Symphony chat when a visual surface materially improves comprehension. Kinds and core data shapes: speaker-identity {turns}; diagram {title,content}; flow-graph {nodes,edges,visibleCount}; spec-sheet {title,subtitle,rows}; timeline {events}; job-progress {title,stages,stageIndex,stageProgress,eta,agentId?}; score-breakdown {verdict,total,outOf,criteria}; agent-plan {steps,activeIndex}; subagent-list {agents:[{agentId,name,model}],completedCount,progress,showSummary,summaryAgent}; recommendation-card {question,body,confidenceLabel}; handoff {from,to,reason,carried,settled}; schedule {name,cadence,nextRun,enabled,history}; checkpoints {checkpoints,currentId}; cost-meter {runCost,sessionCost,lines}; tool-timeline {steps,stats,streaming}; generative-ui {tree} where tree uses the allowlisted assistant-ui $type vocabulary. Always include the durable agentId for a surface that represents a real Symphony agent so the user can open it. This is optional presentation, not a workflow instruction.",
  inputSchema: {
    kind: z.enum(["speaker-identity", "diagram", "flow-graph", "spec-sheet", "timeline", "job-progress", "score-breakdown", "agent-plan", "subagent-list", "recommendation-card", "handoff", "schedule", "checkpoints", "cost-meter", "tool-timeline", "generative-ui"]),
    data: z.record(z.string(), z.unknown()),
  },
}, async (input, extra) => result(await api(
  `/v1/agents/${encodeURIComponent(agentId)}/present`,
  mutation("present-ui", extra.requestId, input),
)));

server.registerTool("send_message", {
  description: "Steer or follow up with an existing durable Symphony agent without creating a new graph node.",
  inputSchema: { targetAgentId: z.string().min(1), content: z.string().min(1) },
}, async ({ targetAgentId, content }, extra) => result(await api(
  `/v1/agents/${encodeURIComponent(targetAgentId)}/messages`,
  mutation("send-message", extra.requestId, { content }),
)));

server.registerTool("observe_agent", {
  description: "Passively summarize an agent's native event history without interrupting it. Use tldr for one sentence, paragraph for status context, or full for an evidence-linked breakdown.",
  inputSchema: { targetAgentId: z.string().min(1), level: z.enum(["tldr", "paragraph", "full"]).default("tldr") },
}, async ({ targetAgentId, level }) => result(await api(`/v1/agents/${encodeURIComponent(targetAgentId)}/observe?level=${level}`)));

server.registerTool("get_session_logs", {
  description: "Read structured, durable native lifecycle logs for a Symphony agent without interrupting it. Use this to diagnose a failed, stalled, or unexpected session before proposing a Symphony fix.",
  inputSchema: {
    targetAgentId: z.string().min(1),
    after: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(2_000).default(500),
  },
}, async ({ targetAgentId, after, limit }) => result(await api(`/v1/agents/${encodeURIComponent(targetAgentId)}/logs?after=${after}&limit=${limit}`)));

server.registerTool("get_session_diagnostics", {
  description: "Read a bounded, secret-free diagnostic bundle for one durable Symphony agent session. This is daemon evidence for diagnosing native harness liveness, exits, command receipts, event cursors, and recovery eligibility; it does not expose or replace the native harness transcript, and native ephemeral subagents may not have a durable bundle.",
  inputSchema: SessionDiagnosticsInputSchema.shape,
}, async ({ targetAgentId }) => result(await api(
  `/v1/agents/${encodeURIComponent(targetAgentId)}/diagnostics`,
)));

server.registerTool("cancel_agent", {
  description: "Request cancellation of an active agent in its native harness.",
  inputSchema: { targetAgentId: z.string().min(1) },
}, async ({ targetAgentId }, extra) => {
  await api(`/v1/agents/${encodeURIComponent(targetAgentId)}/cancel`, mutation("cancel-agent", extra.requestId, {}));
  return result({ cancelled: true, targetAgentId });
});

server.registerTool("list_workflows", {
  description: "List registered dynamic Symphony workflows and their immutable revisions. Inspect a definition before running it: workflows are agent-authored orchestration programs and may include durable fanout/map steps that resolve a runtime array, execute one itemTemplate per item with bounded or null/unlimited concurrency, expose item/itemIndex/itemKey bindings, and aggregate results as an array, keyed object, or merged object.",
  inputSchema: {},
}, async () => result(await api("/v1/workflows")));

server.registerTool("list_capabilities", {
  description: "List the daemon-backed, versioned Symphony capability library. This is a read-only projection of durable capability definitions and provenance; it is separate from native ephemeral subagent tools and does not infer or execute a capability.",
  inputSchema: { capabilityId: CapabilityIdSchema.optional() },
}, async ({ capabilityId }) => {
  const query = capabilityId === undefined ? "" : `?capabilityId=${encodeURIComponent(capabilityId)}`;
  return result(await api(`/v1/capabilities${query}`));
});

server.registerTool("get_capability", {
  description: "Read one exact daemon-backed Symphony capability-library version, including its immutable definition, state, hash, and provenance. Read-only; native ephemeral subagents do not change this durable registry.",
  inputSchema: CapabilityVersionInputSchema.shape,
}, async ({ capabilityId, version }) => result(await api(
  `/v1/capabilities/${encodeURIComponent(capabilityId)}/${version}`,
)));

server.registerTool("prepare_capability_execution", {
  description: "Ask the daemon to validate parameters and resolve compatibility/defaults for one capability version. This is a read-only preparation projection: it does not execute the capability, mutate the library, or create a native subagent.",
  inputSchema: CapabilityPrepareInputSchema.shape,
}, async ({ capabilityId, version, parameters, target }) => result(await api(
  `/v1/capabilities/${encodeURIComponent(capabilityId)}/${version}/prepare`,
  { method: "POST", body: JSON.stringify({ parameters, ...(target === undefined ? {} : { target }) }) },
)));

if (canCreate) server.registerTool("create_capability", {
  description: "Register one immutable, versioned capability definition in Symphony's daemon-backed capability library. This is durable registry state, not a native ephemeral subagent or a prompt-local tool; the daemon binds actor identity and the MCP idempotency key.",
  inputSchema: CapabilityCreateInputSchema.shape,
}, async (input, extra) => result(await api(
  "/v1/capabilities",
  mutation("create-capability", extra.requestId, input),
)));

server.registerTool("activate_capability", {
  description: "Request activation of one exact capability-library version through the Symphony daemon. Typed parameters and trigger bindings are validated and durably admitted with the activation; invalid inputs are rejected. Activation does not launch a native agent or execute the capability.",
  inputSchema: CapabilityActivationInputSchema.shape,
}, async ({ capabilityId, version, parameters, triggers, target }, extra) => result(await api(
  `/v1/capabilities/${encodeURIComponent(capabilityId)}/${version}/activate`,
  mutation("activate-capability", extra.requestId, { ...(parameters === undefined ? {} : { parameters }), ...(triggers === undefined ? {} : { triggers }), ...(target === undefined ? {} : { target }) }),
)));

server.registerTool("deprecate_capability", {
  description: "Request deprecation of one exact capability-library version through the Symphony daemon. This durable registry mutation is authorization- and idempotency-checked; it does not alter native ephemeral subagents.",
  inputSchema: CapabilityVersionInputSchema.shape,
}, async ({ capabilityId, version }, extra) => result(await api(
  `/v1/capabilities/${encodeURIComponent(capabilityId)}/${version}/deprecate`,
  mutation("deprecate-capability", extra.requestId, {}),
)));

server.registerTool("list_agent_messages", {
  description: "List semantic messages from Symphony's durable cross-agent message bus. Results are daemon-backed, cursorable, and scoped by daemon authority; they are not native harness transcripts, and native ephemeral subagent messages may not appear here.",
  inputSchema: AgentMessageListInputSchema.shape,
}, async (input) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined) {
    const daemonKey = key === "afterCursor" ? "after" : key === "beforeCursor" ? "before" : key;
    params.set(daemonKey, Array.isArray(value) ? value.join(",") : String(value));
  }
  return result(await api(`/v1/agent-messages?${params.toString()}`));
});

server.registerTool("replay_agent_messages", {
  description: "Replay semantic messages after a durable Symphony message-bus cursor. Use this to reconnect a cross-harness consumer without relying on native ephemeral subagent context; the daemon remains the sole source of message state.",
  inputSchema: AgentMessageListInputSchema.shape,
}, async (input) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined) {
    const daemonKey = key === "afterCursor" ? "after" : key === "beforeCursor" ? "before" : key;
    params.set(daemonKey, Array.isArray(value) ? value.join(",") : String(value));
  }
  return result(await api(`/v1/agent-messages/replay?${params.toString()}`));
});

server.registerTool("get_agent_message_cursor", {
  description: "Read the daemon-backed high-water cursors for Symphony's durable agent message bus. Persist this cursor with the consumer and use replay_agent_messages after reconnect; it does not describe native ephemeral subagent transcript state.",
  inputSchema: {},
}, async () => result(await api("/v1/agent-messages/cursor")));

server.registerTool("get_agent_message", {
  description: "Read one durable semantic Symphony agent message and its delivery receipts. This is an authority-scoped message-bus projection, never a native harness transcript or an ephemeral subagent context.",
  inputSchema: AgentMessageIdInputSchema.shape,
}, async ({ messageId }) => result(await api(
  `/v1/agent-messages/${encodeURIComponent(messageId)}`,
)));

server.registerTool("send_agent_message", {
  description: "Append one typed semantic packet to Symphony's durable cross-harness agent message bus. Use this for findings, questions, status, handoffs, or control requests that must survive reconnects and be observable across native harnesses. This does not create a native ephemeral subagent and the daemon binds the request idempotency key.",
  inputSchema: AgentMessageSendInputSchema.shape,
}, async (input, extra) => result(await api(
  "/v1/agent-messages",
  mutation("send-agent-message", extra.requestId, input),
)));

server.registerTool("deliver_agent_message", {
  description: "Record a durable delivery outcome for one Symphony message-bus packet. The daemon records delivered or failed explicitly; unknown delivery must use mark_agent_message_unknown and is never treated as success.",
  inputSchema: { ...AgentMessageIdInputSchema.shape, ...AgentMessageDeliveryInputSchema.shape },
}, async ({ messageId, state, reason }, extra) => result(await api(
  `/v1/agent-messages/${encodeURIComponent(messageId)}/deliver`,
  mutation("deliver-agent-message", extra.requestId, { state, ...(reason === undefined ? {} : { reason }) }),
)));

server.registerTool("mark_agent_message_unknown", {
  description: "Persist an explicit unknown delivery outcome for one durable Symphony message. Use when the provider or process outcome cannot be proven; the daemon will not treat this as delivered or resend it implicitly.",
  inputSchema: { ...AgentMessageIdInputSchema.shape, ...AgentMessageUnknownInputSchema.shape },
}, async ({ messageId, reason }, extra) => result(await api(
  `/v1/agent-messages/${encodeURIComponent(messageId)}/unknown`,
  mutation("mark-agent-message-unknown", extra.requestId, { reason }),
)));

server.registerTool("read_agent_message", {
  description: "Record a durable read receipt for one Symphony message-bus packet. This is a daemon-backed semantic receipt and is independent of whether a native ephemeral subagent has seen a local transcript entry.",
  inputSchema: AgentMessageIdInputSchema.shape,
}, async ({ messageId }, extra) => result(await api(
  `/v1/agent-messages/${encodeURIComponent(messageId)}/read`,
  mutation("read-agent-message", extra.requestId, {}),
)));

server.registerTool("handle_agent_message", {
  description: "Record an explicit parent decision for one durable Symphony message-bus packet. Handling requires a decision and daemon authority; it is not a native subagent follow-up or transcript mutation.",
  inputSchema: { ...AgentMessageIdInputSchema.shape, ...AgentMessageHandleInputSchema.shape },
}, async ({ messageId, decision, reason }, extra) => result(await api(
  `/v1/agent-messages/${encodeURIComponent(messageId)}/handled`,
  mutation("handle-agent-message", extra.requestId, { decision, ...(reason === undefined ? {} : { reason }) }),
)));

server.registerTool("cancel_agent_message", {
  description: "Record cancellation of one durable Symphony message-bus packet when the daemon authorizes it. This changes a message receipt state only; it does not cancel a native ephemeral subagent process.",
  inputSchema: { ...AgentMessageIdInputSchema.shape, ...AgentMessageReceiptInputSchema.shape },
}, async ({ messageId, reason }, extra) => result(await api(
  `/v1/agent-messages/${encodeURIComponent(messageId)}/cancel`,
  mutation("cancel-agent-message", extra.requestId, { ...(reason === undefined ? {} : { reason }) }),
)));

server.registerTool("expire_agent_message", {
  description: "Record expiry of one durable Symphony message-bus packet when the daemon authorizes it. Expiry is explicit durable receipt state and does not imply native ephemeral subagent cancellation.",
  inputSchema: { ...AgentMessageIdInputSchema.shape, ...AgentMessageReceiptInputSchema.shape },
}, async ({ messageId, reason }, extra) => result(await api(
  `/v1/agent-messages/${encodeURIComponent(messageId)}/expire`,
  mutation("expire-agent-message", extra.requestId, { ...(reason === undefined ? {} : { reason }) }),
)));

server.registerTool("list_objectives", {
  description: "Inspect durable Symphony objectives before deciding how to orchestrate. Symphony is the cross-harness conductor: use this projection to find living objectives, their frontier, and their current state across native harnesses. Native harness subagents remain appropriate for ephemeral, local assistance inside one agent session. This tool is read-only and does not create or mutate work.",
  inputSchema: {
    limit: z.number().int().min(1).max(200).default(50).describe("Maximum number of objectives to return."),
    state: z.array(z.enum(["planning", "executing", "evaluating", "awaiting-approval", "replanning", "succeeded", "failed", "cancelled", "interrupted"])).max(9).optional().describe("Only return objectives in these durable states."),
    runId: z.string().min(1).optional().describe("Return one objective run by durable run ID."),
    workflowId: z.string().min(1).optional().describe("Only return objectives belonging to this workflow."),
  },
}, async ({ limit, state, runId, workflowId }) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (state?.length) params.set("state", state.join(","));
  if (runId) params.set("runId", runId);
  if (workflowId) params.set("workflowId", workflowId);
  return result(await api(`/v1/objectives?${params.toString()}`));
});

server.registerTool("list_objective_attentions", {
  description: "List the daemon's durable cross-objective attention inbox. Items are risk/urgency ranked and bound to an objective run, node, and attempt when applicable; native harness subagents cannot widen this scope.",
  inputSchema: {
    objectiveId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    attemptId: z.string().min(1).optional(),
    status: z.array(z.enum(["open", "resolved", "expired", "cancelled"])).max(4).optional(),
    assigneeId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(2_000).default(200),
  },
}, async ({ objectiveId, runId, nodeId, attemptId, status, assigneeId, limit }) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (objectiveId) params.set("objectiveId", objectiveId);
  if (runId) params.set("runId", runId);
  if (nodeId) params.set("nodeId", nodeId);
  if (attemptId) params.set("attemptId", attemptId);
  if (status?.length) params.set("status", status.join(","));
  if (assigneeId) params.set("assigneeId", assigneeId);
  return result(await api(`/v1/attentions?${params.toString()}`));
});

server.registerTool("get_objective_attention", {
  description: "Read one immutable attention record and its resolution receipt from the daemon, scoped to the exact objective run.",
  inputSchema: {
    runId: z.string().min(1),
    attentionId: z.string().min(1),
  },
}, async ({ runId, attentionId }) => result(await api(
  `/v1/objectives/${encodeURIComponent(runId)}/attentions/${encodeURIComponent(attentionId)}`,
)));

server.registerTool("resolve_objective_attention", {
  description: "Resolve one durable attention item through the objective conductor authority boundary. Resolution is idempotent and records the exact decision, evidence, actor, and receipt; stale or cross-objective resolutions are rejected by the daemon.",
  inputSchema: {
    runId: z.string().min(1),
    attentionId: z.string().min(1),
    status: z.enum(["resolved", "expired", "cancelled"]),
    decision: z.unknown().nullable().optional(),
    evidenceRefs: z.array(z.union([
      z.string().min(1),
      z.object({ kind: z.string().min(1), id: z.string().min(1), cursor: z.number().int().nonnegative().optional(), description: z.string().optional() }),
    ])).max(128).default([]),
  },
}, async ({ runId, attentionId, status, decision, evidenceRefs }, extra) => result(await api(
  `/v1/objectives/${encodeURIComponent(runId)}/attentions/${encodeURIComponent(attentionId)}/resolve`,
  mutation("resolve-objective-attention", extra.requestId, {
    status,
    ...(decision === undefined ? {} : { decision }),
    evidenceRefs,
  }),
)));

server.registerTool("get_objective", {
  description: "Inspect one durable Symphony objective in detail: its immutable plan revisions, current frontier/checkpoints, approval decisions, and run-scoped event history. Use this to recover context after reconnects and to understand what the Symphony conductor is actually doing before delegating more work. Read-only; native harness subagents do not replace this durable cross-harness record.",
  inputSchema: {
    runId: z.string().min(1).describe("The durable objective run ID."),
    limit: z.number().int().min(1).max(2_000).default(500).describe("Maximum number of recent run events to return."),
    after: z.number().int().min(0).optional().describe("Only return events after this durable event cursor."),
  },
}, async ({ runId, limit, after }) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (after !== undefined) params.set("after", String(after));
  return result(await api(`/v1/objectives/${encodeURIComponent(runId)}?${params.toString()}`));
});

server.registerTool("get_objective_checkpoint", {
  description: "Read one durable objective checkpoint, including portable recovery evidence and explicit resume/retry/fork capabilities. Legacy checkpoints remain readable but are marked non-portable.",
  inputSchema: { runId: IdSchema, checkpointId: IdSchema },
}, async ({ runId, checkpointId }) => result(await api(
  `/v1/objectives/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}`,
)));

server.registerTool("list_objective_checkpoints", {
  description: "Read the append-only checkpoint history for one objective run, including legacy and portable recovery boundaries.",
  inputSchema: { runId: IdSchema },
}, async ({ runId }) => result(await api(
  `/v1/objectives/${encodeURIComponent(runId)}/checkpoints`,
)));

server.registerTool("list_objective_handoffs", {
  description: "Read immutable, data-only Symphony handoff envelopes for a durable objective. Envelopes carry checkpoint, evidence, workspace, authority, and native-continuity references; they never copy native transcripts or imply process rewind.",
  inputSchema: { runId: IdSchema },
}, async ({ runId }) => result(await api(
  `/v1/objectives/${encodeURIComponent(runId)}/handoffs`,
)));

server.registerTool("get_objective_handoff", {
  description: "Read one portable multi-harness handoff and its append-only acceptance/execution projection. The daemon fails closed when evidence, authority, capability, or native continuity no longer verifies.",
  inputSchema: { runId: IdSchema, handoffId: IdSchema },
}, async ({ runId, handoffId }) => result(await api(
  `/v1/objectives/${encodeURIComponent(runId)}/handoffs/${encodeURIComponent(handoffId)}`,
)));

server.registerTool("list_objective_artifacts", {
  description: "Read immutable, content-addressed inline-JSON artifacts for a durable objective run. The daemon scopes this projection to the authenticated agent lineage; hashes, review state, evidence, and producer identity come from daemon truth.",
  inputSchema: {
    runId: IdSchema.describe("The durable objective run ID."),
    limit: z.number().int().min(1).max(2_000).default(500),
  },
}, async ({ runId, limit }) => result(await api(`/v1/objectives/${encodeURIComponent(runId)}/artifacts?limit=${limit}`)));

server.registerTool("get_objective_artifact", {
  description: "Read one durable objective artifact and its append-only review history. Artifact content is inline JSON only; no filesystem bytes or browser-local authority is exposed.",
  inputSchema: {
    runId: IdSchema.describe("The durable objective run ID."),
    artifactId: IdSchema.describe("The daemon-issued artifact ID."),
  },
}, async ({ runId, artifactId }) => result(await api(`/v1/objectives/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`)));

server.registerTool("publish_objective_artifact", {
  description: "Publish one bounded inline-JSON artifact to a durable objective. The daemon computes the canonical SHA-256, binds objective/run/plan/producer/evidence lineage, enforces policy and workspace authority, and records an idempotent receipt. Never supply or trust a caller-computed hash or actor.",
  inputSchema: {
    runId: IdSchema.describe("The durable objective run that owns this artifact."),
    ...ObjectiveArtifactPublishInputSchema.shape,
  },
}, async ({ runId, ...input }, extra) => result(await api(
  `/v1/objectives/${encodeURIComponent(runId)}/artifacts`,
  mutation("publish-objective-artifact", extra.requestId, input),
)));

server.registerTool("get_objective_strategy", {
  description: "Read the current durable control strategy for an objective run: its immutable control-plan head and revision, execution snapshot, and append-only mutation history. Symphony owns this cross-harness strategy; native harness subagents are ephemeral implementation tactics. Fanout nodes are executable durable maps; inspect their source, itemTemplate, concurrency, stable item bindings, reducer, materialized child scopes, and join state. The daemon scopes the result to the authenticated agent's objective lineage.",
  inputSchema: {
    runId: z.string().min(1).describe("The durable objective run ID."),
  },
}, async ({ runId }) => result(await api(`/v1/objectives/${encodeURIComponent(runId)}/strategy`)));

server.registerTool("deliver_objective_signal", {
  description: "Deliver one data-only external event to the exact durable signal subscription of an objective. The daemon verifies conductor/objective authority, subscription and attempt identity, and records an exactly-once delivery receipt; reusing a delivery ID with different payload is rejected.",
  inputSchema: ObjectiveSignalDeliveryInputSchema,
}, async ({ runId, ...input }, extra) => result(await api(
  `/v1/objectives/${encodeURIComponent(runId)}/signals`,
  mutation("deliver-objective-signal", extra.requestId, input),
)));

server.registerTool("revise_objective_strategy", {
  description: "Submit one typed compare-and-swap mutation to an objective's durable Symphony strategy. The daemon binds the authenticated actor and idempotency key, derives the resulting revision and snapshot server-side, and emits a semantic invalidation event. Fanout nodes are executable agent-authored maps with a runtime source, itemTemplate, positive or null/unlimited concurrency, stable item bindings, and an optional array/object/merge reducer; the supervisor materializes child scopes, enforces capacity, cancels siblings on failure, and joins results deterministically. Never send or rely on a caller-computed resulting plan/snapshot; rebase after a deterministic revision conflict.",
  inputSchema: ObjectiveStrategyMutationInputSchema,
}, async ({ runId, ...input }, extra) => result(await api(
  `/v1/objectives/${encodeURIComponent(runId)}/strategy`,
  mutation("revise-objective-strategy", extra.requestId, input),
)));

server.registerTool("preview_objective_strategy", {
  description: "Compute an authenticated deterministic preview for one objective strategy mutation. Returns candidate plan, node/edge/frontier/attempt/authority/workspace/capability/budget/loop impact, policy errors, and supporting evidence without advancing the plan CAS head. Fanout previews preserve the runtime source, itemTemplate, reducer, and concurrency policy but do not materialize child executions.",
  inputSchema: ObjectiveStrategyMutationInputSchema,
}, async ({ runId, ...input }, extra) => result(await api(
  `/v1/objectives/${encodeURIComponent(runId)}/strategy/preview`,
  mutation("preview-objective-strategy", extra.requestId, input),
)));

if (canCreate) {
  server.registerTool("create_objective", {
    description: "Start a durable Symphony objective run with an immutable intent and optional initial tasks. Symphony is the cross-harness conductor for durable cross-harness orchestration: this creates work that can survive disconnected clients and coordinate native harnesses. Native harness subagents are local implementation tactics inside a session, not substitutes for an objective's durable plan, frontier, checkpoints, or evidence.",
    inputSchema: ObjectiveCreateInputSchema,
  }, async (input, extra) => result(await api(
    "/v1/objectives",
    mutation("create-objective", extra.requestId, input),
  )));

  server.registerTool("commit_objective_plan", {
    description: "Append a new revision to a durable Symphony objective plan using compare-and-swap. Use this when cross-harness work needs a durable strategy change; include the current expected plan revision and rebase after a revision conflict. Native harness subagents may help implement one local tactic, but they do not own the shared objective plan.",
    inputSchema: ObjectivePlanCommitInputSchema,
  }, async ({ runId, expectedPlanRevision, tasks, reason }, extra) => result(await api(
    `/v1/objectives/${encodeURIComponent(runId)}/plans`,
    mutation("commit-objective-plan", extra.requestId, { expectedPlanRevision, tasks, ...(reason === undefined ? {} : { reason }) }),
  )));

  server.registerTool("checkpoint_objective", {
    description: "Commit durable objective progress, task state, context, and evidence cursor. Checkpoints are recovery and evaluation boundaries owned by Symphony across native harnesses; they do not imply that an opaque native subagent process can be rewound.",
    inputSchema: ObjectiveCheckpointInputSchema,
  }, async ({ runId, eventCursor, context, taskUpdates, reason }, extra) => result(await api(
    `/v1/objectives/${encodeURIComponent(runId)}/checkpoints`,
    mutation("checkpoint-objective", extra.requestId, {
      eventCursor,
      ...(context === undefined ? {} : { context }),
      taskUpdates,
      reason,
    }),
  )));

  server.registerTool("offer_objective_handoff", {
    description: "Create an immutable, portable Symphony handoff at a committed checkpoint. Use this to transfer an objective task across native Codex, Claude, Cursor, OpenCode, Pi, or ACP harnesses. The envelope carries references only; it does not serialize transcripts or claim process rewind. Missing checkpoint/evidence/policy/capability authority is rejected.",
    inputSchema: {
      runId: IdSchema.describe("The durable objective run that owns the handoff."),
      ...ObjectiveHandoffCreateInputSchema.shape,
    },
  }, async (input, extra) => {
    const { runId, ...handoff } = input as Record<string, unknown> & { runId: string };
    return result(await api(
      `/v1/objectives/${encodeURIComponent(runId)}/handoffs`,
      mutation("offer-objective-handoff", extra.requestId, handoff),
    ));
  });

  server.registerTool("accept_objective_handoff", {
    description: "Accept a portable Symphony handoff after validating the target native harness, model, permission, capability ceiling, evidence references, and continuity claim. Returns a driver-neutral new-attempt or proven same-native-session plan; native loops remain owned by their driver.",
    inputSchema: {
      runId: IdSchema.describe("The durable objective run that owns the handoff."),
      ...ObjectiveHandoffAcceptanceInputSchema.shape,
    },
  }, async (input, extra) => {
    const { runId, ...acceptance } = input as Record<string, unknown> & { runId: string };
    const envelopeId = typeof acceptance.envelopeId === "string" ? acceptance.envelopeId : "";
    if (!envelopeId) throw new Error("accept_objective_handoff requires envelopeId.");
    return result(await api(
      `/v1/objectives/${encodeURIComponent(runId)}/handoffs/${encodeURIComponent(envelopeId)}/accept`,
      mutation("accept-objective-handoff", extra.requestId, acceptance),
    ));
  });

  server.registerTool("resume_objective_checkpoint", {
    description: "Request same-native-session recovery from a portable checkpoint. Accepted only when Symphony has proven native session continuity; never rewinds a process. Use retry for named activity re-execution or fork for a new run.",
    inputSchema: ObjectiveCheckpointResumeInputSchema,
  }, async ({ runId, checkpointId, expectedSequence, attemptId }, extra) => result(await api(
    `/v1/objectives/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}/resume`,
    mutation("resume-objective-checkpoint", extra.requestId, {
      ...(expectedSequence === undefined ? {} : { expectedSequence }),
      ...(attemptId === undefined ? {} : { attemptId }),
    }),
  )));

  server.registerTool("retry_objective_checkpoint_activity", {
    description: "Re-execute exactly one named task or control activity/attempt from committed checkpoint state. This schedules a new execution and never implies process rewind.",
    inputSchema: ObjectiveCheckpointRetryInputSchema,
  }, async ({ runId, checkpointId, activity, expectedSequence }, extra) => result(await api(
    `/v1/objectives/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}/retry`,
    mutation("retry-objective-checkpoint", extra.requestId, {
      activity,
      ...(expectedSequence === undefined ? {} : { expectedSequence }),
    }),
  )));

  server.registerTool("fork_objective_checkpoint", {
    description: "Create a new objective run and occurrence from committed checkpoint state. The source checkpoint and objective lineage remain immutable; this is a fork, never a process rewind.",
    inputSchema: ObjectiveCheckpointForkInputSchema,
  }, async ({ runId, checkpointId, newRunId, occurrenceKey, reason }, extra) => result(await api(
    `/v1/objectives/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}/fork`,
    mutation("fork-objective-checkpoint", extra.requestId, {
      ...(newRunId === undefined ? {} : { newRunId }),
      ...(occurrenceKey === undefined ? {} : { occurrenceKey }),
      reason,
    }),
  )));

  server.registerTool("request_objective_approval", {
    description: "Create a durable approval request for a Symphony objective plan, task, or completion boundary. The daemon records the authenticated actor and exact operation identity; this tool requests attention but does not resolve approval. Use Symphony's cross-harness decision record for shared work, while native harness subagents remain local implementation tactics.",
    inputSchema: ObjectiveApprovalRequestInputSchema,
  }, async ({ runId, kind, taskId, question, scope, operationId, requestHash, policyHash, sideEffectClass, canonicalTarget, expiresAt }, extra) => result(await api(
    `/v1/objectives/${encodeURIComponent(runId)}/approvals`,
    mutation("request-objective-approval", extra.requestId, {
      kind,
      ...(taskId === undefined ? {} : { taskId }),
      question,
      scope,
      operationId,
      requestHash,
      policyHash,
      sideEffectClass,
      canonicalTarget,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }),
  )));

  server.registerTool("register_workflow", {
    description: "Register an immutable revision of a custom Symphony workflow. Use sequence, parallel, fanout, if, while, set, evaluate, timer, signal, and agent steps to express the orchestration strategy that best serves the mission. A fanout step maps the array resolved by source through an itemTemplate, binds item/itemIndex/itemKey for interpolation, runs items with a positive concurrency cap or null/unlimited concurrency, and reduces results as an array, keyed object, or merged object. Reusing the same request is idempotent; changing a definition registers a new revision. This does not start a run.",
    inputSchema: {
      definition: z.record(z.string(), z.unknown()).describe("A complete Symphony workflow definition with id, name, mission, workspace, steps, optional output, and optional triggers."),
    },
  }, async ({ definition }, extra) => result(await api(
    "/v1/workflows",
    mutation("register-workflow", extra.requestId, definition),
  )));

  server.registerTool("run_workflow", {
    description: "Start a registered dynamic workflow with JSON input. The daemon owns durable execution and recovery, including fanout/map materialization, per-item scopes, stable item keys, concurrency, and deterministic aggregation; use the workflow run projection to observe progress after starting it.",
    inputSchema: { workflowId: z.string().min(1), input: z.unknown().default({}) },
  }, async ({ workflowId, input }, extra) => result(await api(
    `/v1/workflows/${encodeURIComponent(workflowId)}/runs`,
    mutation("run-workflow", extra.requestId, input),
  )));

  server.registerTool("activate_workflow", {
    description: "Promote your own pending Symphony workflow schedule after inspecting its immutable definition. User-authored schedules are already active; agent-authored cron triggers remain pending until explicitly activated.",
    inputSchema: { workflowId: z.string().min(1) },
  }, async ({ workflowId }, extra) => result(await api(
    `/v1/workflows/${encodeURIComponent(workflowId)}/activate`,
    mutation("activate-workflow", extra.requestId, {}),
  )));

  server.registerTool("deactivate_workflow", {
    description: "Pause your own Symphony workflow schedule without deleting its immutable definition or affecting other workflows. It can be reactivated later.",
    inputSchema: { workflowId: z.string().min(1) },
  }, async ({ workflowId }, extra) => result(await api(
    `/v1/workflows/${encodeURIComponent(workflowId)}/deactivate`,
    mutation("deactivate-workflow", extra.requestId, {}),
  )));
}

server.registerTool("cancel_run", {
  description: "Request cancellation of a durable Symphony workflow run.",
  inputSchema: { runId: z.string().min(1) },
}, async ({ runId }, extra) => result(await api(
  `/v1/runs/${encodeURIComponent(runId)}/cancel`,
  mutation("cancel-run", extra.requestId, {}),
)));

server.registerTool("list_plugin_tools", {
  description: "List tools contributed by trusted, currently active local Symphony/Pi-compatible plugins.",
  inputSchema: {},
}, async () => result(await api("/v1/plugin-tools")));

server.registerTool("call_plugin_tool", {
  description: "Call a tool contributed by a trusted local plugin. List tools first and pass the plugin tool's documented JSON arguments.",
  inputSchema: { name: z.string().min(1), arguments: z.unknown().default({}) },
}, async ({ name, arguments: toolArguments }, extra) => result(await api(
  `/v1/plugin-tools/${encodeURIComponent(name)}`,
  mutation("call-plugin-tool", extra.requestId, toolArguments),
)));

await server.connect(new StdioServerTransport());
