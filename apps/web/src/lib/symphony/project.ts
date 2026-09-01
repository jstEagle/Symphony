import type {
  ActivityEvent,
  Agent,
  AgentRecord,
  BootstrapEnvelope,
  ChatThreadRecord,
  ConversationDirectory,
  ConversationGroup,
  ConversationMessage,
  ConversationState,
  ConversationSummary,
  CostSummary,
  EventEnvelope,
  InboxItem,
  JsonValue,
  RunSnapshot,
  WorkflowMission,
} from "./contracts";
import {
  agentDisplayName,
  compactAgentState,
  formatClock,
  formatElapsed,
  harnessTitle,
  isActivelyWorkingAgent,
  isLiveAgentState,
  isSettledAgent,
  loaderForHarness,
  relativeTime,
} from "./format";
import { layoutFromAgents } from "./graph-projection";

export { layoutFromAgents } from "./graph-projection";

const INBOX_GROUP_ID = "inbox";
const ACTIVITY_EVENT_TYPES = new Set([
  "agent.queued",
  "agent.routed",
  "agent.message.sent",
  "agent.cancelled",
  "agent.failed",
  "agent.recovered",
  "agent.recovery.continued",
  "agent.cancel.reissued",
  "agent.interrupted",
  "driver.run.started",
  "driver.tool.started",
  "driver.usage.recorded",
  "driver.output.completed",
  "driver.run.completed",
  "driver.run.failed",
]);

export function projectDirectory(
  threads: ChatThreadRecord[],
  agents: AgentRecord[],
  extraGroups: Array<{ id: string; title: string }>,
  pinnedIds: ReadonlySet<string>,
  activeConversationId: string | null,
  unreadIds: ReadonlySet<string>,
): ConversationDirectory {
  const visible = threads.filter((thread) => !thread.archived);
  const groups = new Map<string, ConversationGroup>();

  const ensureGroup = (id: string, title: string) => {
    const existing = groups.get(id);
    if (existing) return existing;
    const created: ConversationGroup = { id, title, conversations: [] };
    groups.set(id, created);
    return created;
  };

  for (const extra of extraGroups) ensureGroup(extra.id, extra.title);

  for (const thread of visible) {
    const groupId = thread.groupId?.trim() || INBOX_GROUP_ID;
    const group = ensureGroup(groupId, groupId === INBOX_GROUP_ID ? "Inbox" : groupId);
    group.conversations.push(
      threadToSummary(thread, agents, pinnedIds.has(thread.id), unreadIds.has(thread.id)),
    );
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.id === INBOX_GROUP_ID) return 1;
    if (b.id === INBOX_GROUP_ID) return -1;
    return a.title.localeCompare(b.title);
  });

  for (const group of ordered) {
    group.conversations.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  const active =
    activeConversationId && visible.some((thread) => thread.id === activeConversationId)
      ? activeConversationId
      : (visible[0]?.id ?? null);

  return { activeConversationId: active, groups: ordered };
}

export function threadToSummary(
  thread: ChatThreadRecord,
  agents: AgentRecord[],
  pinned: boolean,
  unread: boolean,
): ConversationSummary {
  const related = agentsForThread(thread, agents);
  const conductor = related.find((agent) => agent.id === thread.conductorAgentId) ?? related.find((agent) => agent.depth === 0);
  const live = related.filter((agent) => isActivelyWorkingAgent(compactAgentState(agent.status)));
  const failed = related.some((agent) => compactAgentState(agent.status) === "failed");
  const cancellationPending = related.some((agent) => agent.status === "cancel-requested");
  const state: ConversationState = live.length
    ? "running"
    : failed || cancellationPending
      ? "attention"
      : related.some((agent) => agent.status === "completed") && related.every((agent) => !isLiveAgentState(compactAgentState(agent.status)))
        ? "completed"
        : "idle";
  const harness = conductor?.harness ?? conductor?.requestedHarness ?? "pi";
  return {
    id: thread.id,
    groupId: thread.groupId?.trim() || INBOX_GROUP_ID,
    title: thread.title,
    updatedLabel: relativeTime(thread.updatedAt),
    updatedAt: thread.updatedAt,
    state,
    pinned,
    unread,
    loader: state === "running" ? loaderForHarness(harness) : undefined,
    conductorAgentId: thread.conductorAgentId,
    workspacePath: thread.workspacePath,
    archived: thread.archived,
  };
}

export function snapshotForThread(
  thread: ChatThreadRecord | undefined,
  envelope: BootstrapEnvelope,
  events: EventEnvelope[],
): RunSnapshot {
  if (!thread) return emptySnapshot(envelope);
  const relatedAgents = agentsForThread(thread, envelope.agents).map((record) =>
    recordToAgent(record, envelope.agentCosts[record.id]),
  );
  const run = envelope.runs.find((item) => item.id === `chat-run:${thread.id}`)
    ?? envelope.runs.find((item) => item.workflowId === `chat:${thread.id}` || item.workflowId === thread.id);
  const mission = readMission(thread.mission);
  const { nodes, edges } = layoutFromAgents(relatedAgents);
  const liveCount = relatedAgents.filter((agent) => isActivelyWorkingAgent(agent.state)).length;
  const chatRunId = `chat-run:${thread.id}`;
  const chatWorkflowId = `chat:${thread.id}`;
  const relatedAgentIds = new Set(relatedAgents.map((agent) => agent.id));
  const relatedRunIds = new Set<string>([chatRunId]);
  const relatedWorkflowIds = new Set<string>([chatWorkflowId]);
  if (run) {
    relatedRunIds.add(run.id);
    relatedWorkflowIds.add(run.workflowId);
  }
  for (const agent of relatedAgents) {
    if (agent.runId) relatedRunIds.add(agent.runId);
    if (agent.workflowId) relatedWorkflowIds.add(agent.workflowId);
  }
  const traceEvents = events.filter((event) => isEventLinkedToThread(
    event,
    relatedAgentIds,
    relatedRunIds,
    relatedWorkflowIds,
    chatRunId,
    chatWorkflowId,
  ));
  const activity = eventsToActivity(traceEvents, relatedAgents);
  return {
    runId: run?.id ?? `chat-run:${thread.id}`,
    workflowId: run?.workflowId ?? `chat:${thread.id}`,
    workspace: thread.workspacePath,
    mode: envelope.mode === "preview" ? "preview" : "live",
    mission,
    phase: phaseForChat(relatedAgents, liveCount),
    cost: run ? (envelope.runCosts[run.id] ?? unavailableCost()) : unavailableCost(),
    agents: relatedAgents,
    nodes,
    edges,
    events: activity,
    traceEvents,
    cancelRequested: run?.cancelRequested,
  };
}

function isEventLinkedToThread(
  event: EventEnvelope,
  relatedAgentIds: ReadonlySet<string>,
  relatedRunIds: ReadonlySet<string>,
  relatedWorkflowIds: ReadonlySet<string>,
  chatRunId: string,
  chatWorkflowId: string,
): boolean {
  if (event.agentId !== null && relatedAgentIds.has(event.agentId)) return true;
  if (event.runId === chatRunId) return true;
  if (event.workflowId === chatWorkflowId && (event.runId === null || event.runId === chatRunId)) return true;

  const matchesRun = event.runId !== null && relatedRunIds.has(event.runId);
  const matchesWorkflow = event.workflowId !== null && relatedWorkflowIds.has(event.workflowId);
  if (matchesRun && matchesWorkflow) return true;
  // Registration events identify a workflow but have no run yet. They are
  // safe to include only when that workflow was linked from this agent tree.
  return event.type.startsWith("workflow.") && event.runId === null && matchesWorkflow;
}

export function projectInbox(
  threads: ChatThreadRecord[],
  agents: AgentRecord[],
  events: EventEnvelope[],
  readIds: ReadonlySet<string>,
): InboxItem[] {
  const items: InboxItem[] = [];
  for (const agent of agents) {
    if (agent.status === "failed" || agent.status === "lost" || agent.status === "interrupted") {
      const thread = threadForAgent(threads, agent);
      items.push({
        id: `agent-${agent.id}-${agent.status}`,
        conversationId: thread?.id,
        agentId: agent.id,
        title: `${agentDisplayName(agent.objective, agent.depth)} ${agent.status}`,
        detail: agent.error ?? agent.objective,
        at: relativeTime(agent.updatedAt),
        severity: "failure",
        read: readIds.has(`agent-${agent.id}-${agent.status}`),
      });
    }
  }
  for (const event of events.slice(-40)) {
    if (!isHighSignal(event.type)) continue;
    const thread = event.agentId
      ? threadForAgent(threads, agents.find((agent) => agent.id === event.agentId))
      : threads.find((item) => item.id === event.workflowId?.replace(/^chat:/u, ""));
    items.push({
      id: event.id,
      conversationId: thread?.id,
      agentId: event.agentId ?? undefined,
      title: eventTitle(event),
      detail: eventDetail(event),
      at: formatClock(event.occurredAt),
      severity: event.type.includes("fail") ? "failure" : "attention",
      read: readIds.has(event.id),
    });
  }
  return dedupeInbox(items).slice(0, 30);
}

export function agentsForThread(thread: ChatThreadRecord, agents: AgentRecord[]): AgentRecord[] {
  return agents.filter(
    (agent) =>
      agent.workflowId === `chat:${thread.id}` ||
      agent.runId === `chat-run:${thread.id}` ||
      agent.id === thread.conductorAgentId ||
      (thread.conductorAgentId !== null && belongsToConductor(agent, thread.conductorAgentId, agents)),
  );
}

function belongsToConductor(agent: AgentRecord, conductorId: string, agents: AgentRecord[]): boolean {
  let current: AgentRecord | undefined = agent;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.id === conductorId) return true;
    seen.add(current.id);
    current = agents.find((item) => item.id === current?.parentAgentId);
  }
  return false;
}

function threadForAgent(threads: ChatThreadRecord[], agent: AgentRecord | undefined): ChatThreadRecord | undefined {
  if (!agent) return undefined;
  return threads.find(
    (thread) =>
      thread.conductorAgentId === agent.id ||
      agent.workflowId === `chat:${thread.id}` ||
      agent.runId === `chat-run:${thread.id}`,
  );
}

export function recordToAgent(record: AgentRecord, cost?: CostSummary): Agent {
  const harness = harnessTitle(record.harness ?? record.requestedHarness);
  const objective = sanitizeLegacyAgentObjective(record.objective);
  return {
    id: record.id,
    logicalAgentId: record.logicalAgentId,
    parentId: record.parentAgentId ?? undefined,
    depth: record.depth,
    name: agentDisplayName(objective, record.depth),
    objective,
    model: record.model ?? record.requestedModel,
    harness,
    access: record.permissions,
    state: compactAgentState(record.status),
    nativeStatus: record.status,
    elapsed: formatElapsed(record.startedAt, record.finishedAt),
    cost: cost?.knownTotal ?? cost?.amount ?? 0,
    lastActivity: relativeTime(record.updatedAt),
    nativeSessionId: record.nativeSessionId,
    nativeRunId: record.nativeRunId,
    workspacePath: record.workspacePath,
    output: record.output,
    error: record.error,
    runId: record.runId,
    workflowId: record.workflowId,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    finishedAt: record.finishedAt,
  };
}

function readMission(value: JsonValue): WorkflowMission {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { statement: "Help the user accomplish the evolving objective in this conversation.", keyResults: [], revision: 1 };
  }
  const record = value as Record<string, JsonValue>;
  const statement = typeof record.statement === "string" ? record.statement : DEFAULT_CHAT_MISSION;
  if (statement === LEGACY_CHAT_MISSION) {
    return {
      id: typeof record.id === "string" ? record.id : undefined,
      statement: DEFAULT_CHAT_MISSION,
      keyResults: [],
      revision: typeof record.revision === "number" || typeof record.revision === "string" ? record.revision : 1,
      hash: typeof record.hash === "string" ? record.hash : undefined,
    };
  }
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    statement,
    keyResults: Array.isArray(record.keyResults) ? record.keyResults.filter((item): item is string => typeof item === "string") : [],
    revision: typeof record.revision === "number" || typeof record.revision === "string" ? record.revision : 1,
    hash: typeof record.hash === "string" ? record.hash : undefined,
  };
}

const DEFAULT_CHAT_MISSION = "Help the user accomplish the evolving objective in this conversation.";
const LEGACY_CHAT_MISSION = "Help the user accomplish the evolving objective in this conversation by delegating focused work to the best native agents and synthesizing verified results.";
const LEGACY_REVIEW_DIRECTIVE = "Observe delegated work without interrupting it, request independent review when warranted, and return a concise synthesis to the user.";
const NEUTRAL_COORDINATION_DIRECTIVE = "Observe delegated work without interrupting it and return a concise synthesis to the user.";

function sanitizeLegacyAgentObjective(objective: string): string {
  return objective.replace(LEGACY_REVIEW_DIRECTIVE, NEUTRAL_COORDINATION_DIRECTIVE);
}

function eventsToActivity(events: EventEnvelope[], agents: Agent[]): ActivityEvent[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return events
    .filter((event) => (event.agentId ? byId.has(event.agentId) : false) || event.type.startsWith("workflow."))
    .filter((event) => isActivityEvent(event.type))
    .slice(-32)
    .reverse()
    .map((event) => ({
      id: event.id,
      at: formatClock(event.occurredAt),
      occurredAt: event.occurredAt,
      kind: activityKind(event.type),
      title: activityTitle(event, event.agentId ? byId.get(event.agentId) : undefined),
      detail: activityDetail(event),
      agentId: event.agentId ?? undefined,
      source: activitySource(event),
      cursor: event.cursor,
    }));
}

function isActivityEvent(type: string): boolean {
  return type.startsWith("workflow.") || ACTIVITY_EVENT_TYPES.has(type);
}

function activityTitle(event: EventEnvelope, agent: Agent | undefined): string {
  const name = agent?.name ?? "Agent";
  switch (event.type) {
    case "agent.queued": return `${name} queued`;
    case "agent.routed": return `${name} routed`;
    case "agent.message.sent": return "Follow-up delivered";
    case "agent.cancelled": return `${name} cancelled`;
    case "agent.recovered": return `${name} recovered`;
    case "agent.recovery.continued": return `${name} recovery continued`;
    case "agent.cancel.reissued": return `${name} cancellation reissued`;
    case "agent.interrupted": return `${name} interrupted`;
    case "agent.failed":
    case "driver.run.failed": return `${name} failed`;
    case "driver.run.started": return `${name} started`;
    case "driver.tool.started": return `Used ${payloadString(event, "name") ?? "native tool"}`;
    case "driver.usage.recorded": return "Usage recorded";
    case "driver.output.completed": return "Response validated";
    case "driver.run.completed": return `${name} finished`;
    default: return eventTitle(event);
  }
}

function activityDetail(event: EventEnvelope): string {
  switch (event.type) {
    case "agent.queued":
      return "Added to the orchestration graph.";
    case "agent.routed": {
      const harness = payloadString(event, "harness");
      const model = payloadString(event, "model");
      return [harness ? harnessTitle(harness) : null, model].filter(Boolean).join(" · ") || "Native harness selected.";
    }
    case "agent.message.sent":
      return "Sent to the agent's active native session.";
    case "agent.recovered": {
      const continuity = payloadString(event, "continuity");
      const recoveredStatus = payloadString(event, "recoveredStatus");
      switch (continuity) {
        case "native-run-reattached":
          return "Reattached to the active native run after the daemon restarted.";
        case "checkpoint-continuation":
          return "Restored the native session and continued from its durable checkpoint.";
        case "session-restored":
          return "Restored the reusable native session after the daemon restarted.";
        case "cancellation-reissued":
          return "Restored the native run and reissued its pending cancellation request.";
        case "cancellation-settled":
          return "Recovered the native session and confirmed its cancellation.";
        case "terminal-event-observed":
          return `Recovered after observing the native terminal event${recoveredStatus ? ` · ${recoveredStatus}` : ""}.`;
        case "native-terminal-state":
          return `Recovered the native terminal state${recoveredStatus ? ` · ${recoveredStatus}` : ""}.`;
        default:
          return recoveredStatus ? `Recovered native session · ${recoveredStatus}.` : "Recovered the native session after the daemon restarted.";
      }
    }
    case "agent.recovery.continued":
      return payloadRecord(event)?.queued === true
        ? "Queued a checkpoint-aware continuation in the recovered native session."
        : "Delivered a checkpoint-aware continuation to the recovered native session.";
    case "agent.cancel.reissued":
      return "Reissued the durable cancellation request to the recovered native run.";
    case "agent.interrupted":
      return clipDetail(payloadString(event, "error") ?? "The native run could not be recovered safely.");
    case "driver.run.started": {
      const model = payloadString(event, "model");
      const toolCount = payloadArrayLength(event, "tools");
      return [model, toolCount === null ? null : `${toolCount} native tools available`].filter(Boolean).join(" · ") || "Native run started.";
    }
    case "driver.tool.started":
      return payloadString(event, "name") === "StructuredOutput"
        ? "Returned the requested structured response."
        : "The native harness invoked this tool.";
    case "driver.usage.recorded": {
      const amount = payloadNumber(event, "costAmount");
      return amount === null ? "Provider usage evidence was recorded." : `$${amount.toFixed(amount < 0.01 ? 4 : 2)} reported by the harness.`;
    }
    case "driver.output.completed":
      return "Validated output was committed to the conversation.";
    case "driver.run.completed": {
      const turns = payloadNumber(event, "turns");
      return turns === null ? "Native run completed." : `${turns} native turn${turns === 1 ? "" : "s"}.`;
    }
    default:
      return clipDetail(eventDetail(event));
  }
}

function payloadRecord(event: EventEnvelope): Record<string, JsonValue> | null {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, JsonValue>
    : null;
}

function payloadString(event: EventEnvelope, key: string): string | null {
  const value = payloadRecord(event)?.[key];
  return typeof value === "string" ? value : null;
}

function payloadNumber(event: EventEnvelope, key: string): number | null {
  const value = payloadRecord(event)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function payloadArrayLength(event: EventEnvelope, key: string): number | null {
  const value = payloadRecord(event)?.[key];
  return Array.isArray(value) ? value.length : null;
}

function clipDetail(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function activityKind(type: string): ActivityEvent["kind"] {
  if (type.includes("observ")) return "observation";
  if (type.includes("message") || type.includes("steer")) return "message";
  if (type.includes("tool") || type.startsWith("driver.")) return "tool";
  if (type.includes("create") || type.includes("agent.")) return "delegation";
  return "system";
}

function activitySource(event: EventEnvelope): ActivityEvent["source"] {
  return event.provenance?.source === "driver"
    || event.provenance?.source === "observer"
    || event.provenance?.source === "daemon"
    || event.provenance?.source === "workflow"
    ? "runtime-observed"
    : "agent-reported";
}

function eventTitle(event: EventEnvelope): string {
  return event.type.replaceAll(".", " · ").replaceAll("_", " ");
}

function eventDetail(event: EventEnvelope): string {
  const payload = event.payload;
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, JsonValue>;
    if (typeof record.summary === "string") return record.summary;
    if (typeof record.text === "string") return record.text;
    if (typeof record.error === "string") return record.error;
    if (typeof record.objective === "string") return record.objective;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return event.type;
  }
}

function isHighSignal(type: string): boolean {
  return /fail|cancel|lost|interrupt|blocked|approval/i.test(type);
}

function dedupeInbox(items: InboxItem[]): InboxItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function phaseForChat(agents: Agent[], liveCount: number): string {
  const total = agents.length;
  if (liveCount > 0) return `${liveCount} active · ${total} agents`;
  if (agents.some((agent) => agent.nativeStatus === "cancel-requested")) return "Cancellation requested";
  if (agents.some((agent) => agent.state === "failed")) return "Needs attention";
  if (total > 0) return "Ready";
  return "Ready";
}

function emptySnapshot(envelope: BootstrapEnvelope): RunSnapshot {
  return emptyRunSnapshot(envelope.mode === "preview" ? "preview" : "live", envelope.costs);
}

function unavailableCost(): CostSummary {
  return { amount: 0, currency: "USD", provenance: "unavailable" };
}

export function emptyRunSnapshot(
  mode: RunSnapshot["mode"],
  cost: CostSummary = { amount: 0, currency: "USD", provenance: "unavailable" },
): RunSnapshot {
  return {
    runId: "none",
    workspace: "",
    mode,
    mission: { statement: "Start a conversation with the conductor.", keyResults: [], revision: 1 },
    phase: "Ready",
    cost,
    agents: [],
    nodes: [],
    edges: [],
    events: [],
    traceEvents: [],
  };
}

export function messagesForThread(
  threadId: string,
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.filter((message) => message.threadId === threadId);
}

export function progressCopy(snapshot: RunSnapshot): string {
  const live = snapshot.agents.filter((agent) => isActivelyWorkingAgent(agent.state)).length;
  const total = snapshot.agents.length;
  if (total === 0 && snapshot.nodes.length <= 1) {
    return snapshot.phase === "Ready" ? "Ready" : snapshot.phase;
  }
  if (snapshot.nodes.length > 1) {
    const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    const settled = snapshot.nodes.filter((node) => {
      const agent = node.agentId ? agentsById.get(node.agentId) : agentsById.get(node.id);
      return isSettledAgent(agent?.state ?? node.state, agent?.nativeStatus);
    }).length;
    return `${settled} / ${snapshot.nodes.length} settled`;
  }
  return [`${live} live`, total ? `${total} agents` : null]
    .filter(Boolean)
    .join(" · ");
}

export { type CostSummary };
