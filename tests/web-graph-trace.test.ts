import { describe, expect, it } from "vitest";
import { buildTraceModel } from "../apps/web/src/components/symphony/run-trace.js";
import {
  fitGraphTransform,
  graphBounds,
} from "../apps/web/src/components/symphony/workflow-graph.js";
import {
  isActivelyWorkingAgent,
  isSettledAgent,
} from "../apps/web/src/lib/symphony/format.js";
import { progressCopy } from "../apps/web/src/lib/symphony/project.js";
import type {
  Agent,
  EventEnvelope,
  RunSnapshot,
  WorkNode,
} from "../apps/web/src/lib/symphony/contracts.js";

const baseAgent: Agent = {
  id: "agent-1",
  depth: 0,
  name: "Conductor",
  objective: "Run the durable trace",
  model: "fixture",
  harness: "Codex",
  access: "read-only",
  state: "succeeded",
  elapsed: "30s",
  cost: 0,
  lastActivity: "now",
  startedAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:30.000Z",
  finishedAt: "2026-08-30T00:00:30.000Z",
};

function snapshot(agent: Agent, traceEvents: EventEnvelope[] = []): RunSnapshot {
  return {
    runId: "run-1",
    workflowId: "workflow-1",
    workspace: "/workspace",
    mode: "live",
    mission: { statement: "Trace the run", revision: 1, keyResults: [] },
    phase: "Ready",
    cost: { amount: 0, currency: "USD", provenance: "unavailable" },
    agents: [agent],
    nodes: [],
    edges: [],
    events: [],
    traceEvents,
    runStatus: agent.state === "succeeded" ? "completed" : "running",
  };
}

function toolEvent(cursor: number, type: string, occurredAt: string, payload: EventEnvelope["payload"]): EventEnvelope {
  return {
    id: `event-${cursor}`,
    cursor,
    type,
    workflowId: "workflow-1",
    runId: "run-1",
    agentId: "agent-1",
    occurredAt,
    payload,
    provenance: { source: "driver", nativeEventId: `native-${cursor}` },
  };
}

describe("trace timing", () => {
  it("keeps all settled span timestamps stable across observations and refreshes", () => {
    const events = [
      toolEvent(1, "driver.tool.started", "2026-08-30T00:00:05.000Z", {
        toolCallId: "tool-1",
        toolName: "bash",
        startTime: "2026-08-30T00:00:04.000Z",
      }),
      toolEvent(2, "driver.tool.failed", "2026-08-30T00:00:12.000Z", {
        toolCallId: "tool-1",
        endTime: "2026-08-30T00:00:13.000Z",
      }),
    ];
    const earlier = buildTraceModel(snapshot(baseAgent, events), Date.parse("2026-08-30T01:00:00.000Z"));
    const later = buildTraceModel(snapshot({ ...baseAgent }, [...events]), Date.parse("2026-09-01T01:00:00.000Z"));

    expect(later.range).toEqual(earlier.range);
    expect(later.spans).toEqual(earlier.spans);
    expect(later.spans.find((span) => span.type === "tool")).toMatchObject({
      status: "failed",
      startedAt: Date.parse("2026-08-30T00:00:04.000Z"),
      endedAt: Date.parse("2026-08-30T00:00:13.000Z"),
    });
  });

  it("only advances the visible range for a live run", () => {
    const liveAgent = { ...baseAgent, state: "running" as const, finishedAt: null };
    const earlier = buildTraceModel(snapshot(liveAgent), Date.parse("2026-08-30T00:01:00.000Z"));
    const later = buildTraceModel(snapshot({ ...liveAgent }), Date.parse("2026-08-30T00:02:00.000Z"));
    const timestamps = (model: ReturnType<typeof buildTraceModel>) => model.spans.map(({ id, startedAt, endedAt }) => ({ id, startedAt, endedAt }));

    expect(timestamps(later)).toEqual(timestamps(earlier));
    expect(earlier.range.max).toBe(Date.parse("2026-08-30T00:01:00.000Z"));
    expect(later.range.max).toBe(Date.parse("2026-08-30T00:02:00.000Z"));
  });

  it("keeps an idle native session bounded at its first idle recovery", () => {
    const idleAgent = {
      ...baseAgent,
      state: "waiting" as const,
      nativeStatus: "idle" as const,
      finishedAt: null,
      updatedAt: "2026-08-30T04:00:00.000Z",
    };
    const firstRecovery = toolEvent(1, "agent.recovered", "2026-08-30T00:00:40.000Z", {
      previousStatus: "running",
      resumedState: "idle",
      recoveredStatus: "idle",
      continuity: "session-restored",
    });
    const laterRecovery = toolEvent(2, "agent.recovered", "2026-08-30T04:00:00.000Z", {
      previousStatus: "idle",
      resumedState: "idle",
      recoveredStatus: "idle",
      continuity: "session-restored",
    });

    const earlier = buildTraceModel(snapshot(idleAgent, [firstRecovery]), Date.parse("2026-08-30T04:00:00.000Z"));
    const later = buildTraceModel(snapshot(idleAgent, [firstRecovery, laterRecovery]), Date.parse("2026-08-30T08:00:00.000Z"));
    const earlierAgent = earlier.spans.find((span) => span.id === idleAgent.id);
    const laterAgent = later.spans.find((span) => span.id === idleAgent.id);

    expect(isActivelyWorkingAgent(idleAgent.state)).toBe(false);
    expect(isSettledAgent(idleAgent.state, idleAgent.nativeStatus)).toBe(true);
    expect(later.range).toEqual(earlier.range);
    expect(laterAgent).toEqual(earlierAgent);
    expect(laterAgent).toMatchObject({
      status: "skipped",
      endedAt: Date.parse("2026-08-30T00:00:40.000Z"),
      latencyMs: 40_000,
    });
  });

  it("uses the first legacy active-to-idle recovery when old events lack resumed state", () => {
    const idleAgent = {
      ...baseAgent,
      state: "waiting" as const,
      nativeStatus: "idle" as const,
      finishedAt: null,
      updatedAt: "2026-08-30T06:00:00.000Z",
    };
    const firstRecovery = toolEvent(1, "agent.recovered", "2026-08-30T00:00:45.000Z", {
      previousStatus: "running",
      nativeSessionId: "legacy-session",
    });
    const laterRecovery = toolEvent(2, "agent.recovered", "2026-08-30T06:00:00.000Z", {
      previousStatus: "idle",
      nativeSessionId: "legacy-session",
    });

    const earlier = buildTraceModel(snapshot(idleAgent, [firstRecovery]), Date.parse("2026-08-30T06:00:00.000Z"));
    const later = buildTraceModel(snapshot(idleAgent, [firstRecovery, laterRecovery]), Date.parse("2026-08-30T08:00:00.000Z"));
    const laterAgent = later.spans.find((span) => span.id === idleAgent.id);

    expect(later.range).toEqual(earlier.range);
    expect(laterAgent).toEqual(earlier.spans.find((span) => span.id === idleAgent.id));
    expect(laterAgent).toMatchObject({
      endedAt: Date.parse("2026-08-30T00:00:45.000Z"),
      latencyMs: 45_000,
    });
  });

  it("keeps durable waiting work open without animating it as active work", () => {
    const waitingAgent = {
      ...baseAgent,
      state: "waiting" as const,
      nativeStatus: "waiting" as const,
      finishedAt: null,
    };
    const startedTool = toolEvent(1, "driver.tool.started", "2026-08-30T00:00:05.000Z", {
      toolCallId: "tool-waiting",
      toolName: "bash",
    });
    const observedAt = Date.parse("2026-08-30T00:01:00.000Z");
    const model = buildTraceModel(snapshot(waitingAgent, [startedTool]), observedAt);

    expect(isActivelyWorkingAgent(waitingAgent.state)).toBe(false);
    expect(isSettledAgent(waitingAgent.state, waitingAgent.nativeStatus)).toBe(false);
    expect(model.range.max).toBe(observedAt);
    expect(model.spans.find((span) => span.type === "run")).toMatchObject({ status: "running", endedAt: null });
    expect(model.spans.find((span) => span.id === waitingAgent.id)).toMatchObject({ status: "running", endedAt: null });
    expect(model.spans.find((span) => span.type === "tool")).toMatchObject({ status: "running", endedAt: null });
  });

  it("counts terminal and idle work as settled but not native waiting work", () => {
    const waitingAgent = { ...baseAgent, id: "waiting", state: "waiting" as const, nativeStatus: "waiting" as const, finishedAt: null };
    const idleAgent = { ...baseAgent, id: "idle", state: "waiting" as const, nativeStatus: "idle" as const, finishedAt: null };
    const completedAgent = { ...baseAgent, id: "done", state: "succeeded" as const, nativeStatus: "completed" as const };
    const progressSnapshot: RunSnapshot = {
      ...snapshot(waitingAgent),
      agents: [waitingAgent, idleAgent, completedAgent],
      nodes: [waitingAgent, idleAgent, completedAgent].map((agent, index) => ({
        id: agent.id,
        agentId: agent.id,
        label: agent.name,
        detail: agent.objective,
        state: agent.state,
        x: index * 100,
        y: 0,
      })),
    };

    expect(progressCopy(progressSnapshot)).toBe("2 / 3 settled");
  });
});

describe("workflow graph viewport", () => {
  it("centers arbitrary graph coordinates and fits every edge inside the viewport", () => {
    const nodes: WorkNode[] = [
      { id: "left", label: "Left", detail: "", state: "running", x: -500, y: -300 },
      { id: "right", label: "Right", detail: "", state: "waiting", x: 99_500, y: 49_700 },
    ];
    const bounds = graphBounds(nodes);
    const viewport = { width: 1_200, height: 800 };
    const transform = fitGraphTransform(bounds, viewport);
    const graphCenterX = (bounds.minX + bounds.maxX) / 2;
    const graphCenterY = (bounds.minY + bounds.maxY) / 2;

    expect(transform.x + graphCenterX * transform.scale).toBeCloseTo(viewport.width / 2, 8);
    expect(transform.y + graphCenterY * transform.scale).toBeCloseTo(viewport.height / 2, 8);
    expect(transform.x + bounds.minX * transform.scale).toBeGreaterThanOrEqual(0);
    expect(transform.y + bounds.minY * transform.scale).toBeGreaterThanOrEqual(0);
    expect(transform.x + bounds.maxX * transform.scale).toBeLessThanOrEqual(viewport.width);
    expect(transform.y + bounds.maxY * transform.scale).toBeLessThanOrEqual(viewport.height);
  });
});
