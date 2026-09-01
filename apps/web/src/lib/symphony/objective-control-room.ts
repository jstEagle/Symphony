import type { ObjectiveProjection } from "./objective-project";

export const CONTROL_ROOM_LANES = ["needs-input", "working", "blocked", "completed"] as const;
export type ControlRoomLane = (typeof CONTROL_ROOM_LANES)[number];

export type ControlRoomAgentSummary = {
  id: string;
  name: string;
  harness: string;
  model: string;
  state: string;
  live: boolean;
};

export type ControlRoomObjectiveCard = {
  objectiveId: string;
  runId: string;
  statement: string;
  lane: ControlRoomLane;
  state: ObjectiveProjection["state"];
  stateLabel: string;
  terminal: boolean;
  live: boolean;
  strategy: {
    source: "workflow" | "objective";
    label: string;
    workflowId: string;
    revision: number;
    hash: string;
    planRevision: number;
  };
  agents: {
    total: number;
    assignedTasks: number;
    unassignedTasks: number;
    active: number;
    waiting: number;
    blocked: number;
    failed: number;
    completed: number;
  };
  agentList: ControlRoomAgentSummary[];
  tasks: {
    total: number;
    completed: number;
    active: number;
  };
  budget: {
    available: boolean;
    unknownCost: boolean;
    costUsd: number | null;
    reservedCostUsd: number | null;
    status: string | null;
    label: string;
  };
  checkpoint: {
    id: string;
    sequence: number;
    reason: string;
    at: string;
    eventCursor: number;
  } | null;
  latestEvent: {
    id: string;
    type: string;
    title: string;
    detail: string;
    at: string;
    cursor: number;
    agentId: string | null;
    taskId: string | null;
  } | null;
  attention: string | null;
  pendingApproval: {
    id: string;
    question: string;
    expiresAt: string | null;
  } | null;
  actions: {
    canPause: boolean;
    canResume: boolean;
    canRetry: boolean;
    canStop: boolean;
    canApprove: boolean;
  };
};

export type ControlRoomViewModel = {
  cards: ControlRoomObjectiveCard[];
  lanes: Record<ControlRoomLane, ControlRoomObjectiveCard[]>;
  totals: {
    objectives: number;
    needsInput: number;
    working: number;
    blocked: number;
    completed: number;
    liveAgents: number;
  };
};

const liveRunStates = new Set<ObjectiveProjection["state"]>([
  "planning",
  "executing",
  "evaluating",
  "replanning",
]);

const failedRunStates = new Set<ObjectiveProjection["state"]>(["failed", "cancelled", "interrupted"]);
const failedTaskStates = new Set(["failed", "blocked"]);
const waitingTaskStates = new Set(["waiting-approval"]);

/**
 * Assign one authoritative objective projection to the operational lane that
 * needs attention first. This is deliberately pure: it never infers state
 * from wall-clock time or client events and never mutates a projection.
 */
export function classifyControlRoomLane(projection: ObjectiveProjection): ControlRoomLane {
  if (projection.pendingApproval || projection.progress.pendingApproval > 0 || projection.state === "awaiting-approval") {
    return "needs-input";
  }

  const hasFailure = failedRunStates.has(projection.state)
    || Boolean(projection.error)
    || projection.progress.failed > 0
    || projection.progress.blocked > 0
    || projection.packets.some((task) => failedTaskStates.has(task.state));
  if (hasFailure) return "blocked";

  if (projection.state === "succeeded" || (projection.terminal && !failedRunStates.has(projection.state))) {
    return "completed";
  }

  return "working";
}

/** Build an immutable, display-ready card from daemon-authoritative facts. */
export function projectControlRoomObjective(projection: ObjectiveProjection): ControlRoomObjectiveCard {
  const lane = classifyControlRoomLane(projection);
  const assignedPackets = projection.packets.filter((task) => task.agentId !== null);
  const agentList = dedupeAgents(projection);
  const active = projection.packets.filter((task) => task.state === "running").length;
  const waiting = projection.packets.filter((task) => waitingTaskStates.has(task.state)).length;
  const blocked = projection.packets.filter((task) => task.state === "blocked").length;
  const failed = projection.packets.filter((task) => task.state === "failed").length;
  const completed = projection.packets.filter((task) => task.state === "completed").length;
  const live = !projection.terminal
    && (active > 0 || (liveRunStates.has(projection.state) && projection.progress.active > 0));
  const latestEvent = projection.events.at(-1) ?? null;
  const checkpoint = projection.latestCheckpoint;
  const costUsd = projection.budget.consumed?.costUsd ?? null;
  const reservedCostUsd = projection.budget.reserved?.costUsd ?? null;

  return {
    objectiveId: projection.objectiveId,
    runId: projection.runId,
    statement: projection.mission.statement,
    lane,
    state: projection.state,
    stateLabel: projection.state.replaceAll("-", " "),
    terminal: projection.terminal,
    live,
    strategy: {
      source: projection.planRevisions.length > 0 ? "workflow" : "objective",
      label: projection.planRevisions.length > 0 ? "Workflow revision" : "Objective plan",
      workflowId: projection.workflowId,
      revision: projection.mission.revision,
      hash: projection.mission.hash,
      planRevision: projection.planRevision,
    },
    agents: {
      total: agentList.length,
      assignedTasks: assignedPackets.length,
      unassignedTasks: projection.packets.length - assignedPackets.length,
      active,
      waiting,
      blocked,
      failed,
      completed,
    },
    agentList,
    tasks: {
      total: projection.packets.length,
      completed,
      active: projection.progress.active,
    },
    budget: {
      available: projection.budget.available,
      unknownCost: projection.budget.unknownCost,
      costUsd,
      reservedCostUsd,
      status: projection.budget.status,
      label: budgetLabel(projection.budget.available, projection.budget.unknownCost, costUsd),
    },
    checkpoint: checkpoint
      ? {
        id: checkpoint.id,
        sequence: checkpoint.sequence,
        reason: checkpoint.reason,
        at: checkpoint.createdAt,
        eventCursor: checkpoint.eventCursor,
      }
      : null,
    latestEvent: latestEvent
      ? {
        id: latestEvent.id,
        type: latestEvent.type,
        title: latestEvent.title,
        detail: latestEvent.detail,
        at: latestEvent.at,
        cursor: latestEvent.cursor,
        agentId: latestEvent.agentId,
        taskId: latestEvent.taskId,
      }
      : null,
    attention: projection.error
      ?? projection.pendingApproval?.question
      ?? (blocked > 0 ? `${blocked} task${blocked === 1 ? "" : "s"} blocked` : null)
      ?? (failed > 0 ? `${failed} task${failed === 1 ? "" : "s"} failed` : null),
    pendingApproval: projection.pendingApproval
      ? {
        id: projection.pendingApproval.id,
        question: projection.pendingApproval.question,
        expiresAt: projection.pendingApproval.expiresAt,
      }
      : null,
    actions: {
      canPause: !projection.terminal && projection.state !== "awaiting-approval",
      canResume: !projection.terminal && projection.state === "awaiting-approval",
      canRetry: projection.state === "failed" || failed > 0 || blocked > 0,
      canStop: !projection.terminal,
      canApprove: projection.pendingApproval !== null,
    },
  };
}

/**
 * Group cards into stable lanes. Sorting is newest authoritative evidence
 * first, with the durable run ID as a deterministic tie breaker.
 */
export function buildControlRoomViewModel(
  projections: readonly ObjectiveProjection[],
): ControlRoomViewModel {
  const cards = projections
    .map(projectControlRoomObjective)
    .sort(compareCards);
  const lanes = Object.fromEntries(CONTROL_ROOM_LANES.map((lane) => [
    lane,
    cards.filter((card) => card.lane === lane),
  ])) as Record<ControlRoomLane, ControlRoomObjectiveCard[]>;

  return {
    cards,
    lanes,
    totals: {
      objectives: cards.length,
      needsInput: lanes["needs-input"].length,
      working: lanes.working.length,
      blocked: lanes.blocked.length,
      completed: lanes.completed.length,
      liveAgents: cards.reduce((total, card) => total + card.agents.active, 0),
    },
  };
}

function dedupeAgents(projection: ObjectiveProjection): ControlRoomAgentSummary[] {
  const byId = new Map<string, ControlRoomAgentSummary>();
  for (const task of projection.packets) {
    if (!task.agentId || !task.agent) continue;
    const live = task.state === "running";
    const current = byId.get(task.agentId);
    if (current) {
      current.live ||= live;
      continue;
    }
    byId.set(task.agentId, {
      id: task.agentId,
      name: task.agent.name,
      harness: task.agent.harness,
      model: task.agent.model,
      state: task.state,
      live,
    });
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function compareCards(left: ControlRoomObjectiveCard, right: ControlRoomObjectiveCard): number {
  const leftAt = latestEvidenceAt(left);
  const rightAt = latestEvidenceAt(right);
  const byActivity = Date.parse(rightAt) - Date.parse(leftAt);
  if (Number.isFinite(byActivity) && byActivity !== 0) return byActivity;
  return left.runId.localeCompare(right.runId);
}

function latestEvidenceAt(card: ControlRoomObjectiveCard): string {
  return card.latestEvent?.at ?? card.checkpoint?.at ?? "";
}

function budgetLabel(available: boolean, unknownCost: boolean, costUsd: number | null): string {
  if (!available || unknownCost || costUsd === null || !Number.isFinite(costUsd)) return "Unknown cost";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: costUsd > 0 && costUsd < 0.01 ? 4 : 2 }).format(costUsd);
}
