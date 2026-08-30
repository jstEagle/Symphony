import { describe, expect, it } from "vitest";
import type {
  Agent,
  AgentRecord,
  BootstrapEnvelope,
  ChatThreadRecord,
  EventEnvelope,
  NativeAgentStatus,
} from "../apps/web/src/lib/symphony/contracts.js";
import { compactAgentState } from "../apps/web/src/lib/symphony/format.js";
import { resolveAgentReference } from "../apps/web/src/lib/symphony/agent-projection.js";
import {
  emptyRunSnapshot,
  layoutFromAgents,
  snapshotForThread,
  threadToSummary,
} from "../apps/web/src/lib/symphony/project.js";

function agent(id: string, parentId?: string): Agent {
  return {
    id,
    parentId,
    depth: parentId ? 1 : 0,
    name: id,
    objective: `Run ${id}`,
    model: "fixture",
    harness: "Codex",
    access: "read-only",
    state: "waiting",
    elapsed: "1s",
    cost: 0,
    lastActivity: "now",
    startedAt: `2026-08-30T00:00:0${id.slice(-1)}.000Z`,
  };
}

describe("workflow graph layout", () => {
  it("gives sibling agents distinct rows and a readable gap from their conductor", () => {
    const agents = [agent("root"), ...Array.from({ length: 6 }, (_, index) => agent(`child-${index}`, "root"))];
    const { nodes, edges } = layoutFromAgents(agents);
    const root = nodes.find((node) => node.id === "root");
    const children = nodes.filter((node) => node.id.startsWith("child-"));

    expect(nodes).toHaveLength(7);
    expect(edges).toHaveLength(6);
    expect(root?.x).toBe(0);
    expect(children.every((node) => node.x - (root?.x ?? 0) >= 350)).toBe(true);
    expect(new Set(children.map((node) => node.y)).size).toBe(6);
    expect(Math.min(...children.map((node) => node.y))).toBeGreaterThanOrEqual(0);
    expect(root?.y).toBe((Math.min(...children.map((node) => node.y)) + Math.max(...children.map((node) => node.y))) / 2);
  });

  it("keeps malformed parent cycles visible", () => {
    const { nodes } = layoutFromAgents([agent("a", "b"), agent("b", "a")]);
    expect(nodes.map((node) => node.id).sort()).toEqual(["a", "b"]);
  });
});

describe("authoritative agent references", () => {
  it("overrides historical running state with the exact current agent state", () => {
    const current = { ...agent("agent-current"), state: "succeeded" as const, nativeStatus: "completed" as const };

    expect(resolveAgentReference({ agentId: current.id, name: "Audit", state: "running" }, [current])).toMatchObject({
      agentId: current.id,
      state: "succeeded",
      nativeStatus: "completed",
      error: null,
    });
  });

  it("never fuzzy-binds an unknown explicit id to a similarly named newer agent", () => {
    const newer = { ...agent("newer-agent"), name: "Architecture audit", objective: "Audit the architecture" };

    expect(resolveAgentReference({ agentId: "retired-agent", name: "Architecture audit", state: "running" }, [newer])).toMatchObject({
      agentId: "retired-agent",
      state: "stale",
      nativeStatus: null,
      error: expect.stringContaining("not present"),
    });
  });

  it("uses unique legacy labels but leaves ambiguous historical rows stale", () => {
    const config = {
      ...agent("config-agent"),
      name: "Audit config, plugins, routing…",
      objective: "Audit config, plugins, routing, harness updates, and SDK boundaries.",
      state: "waiting" as const,
      nativeStatus: "idle" as const,
    };
    const duplicateOne = { ...agent("audit-one"), name: "Audit", objective: "Audit shared work one" };
    const duplicateTwo = { ...agent("audit-two"), name: "Audit", objective: "Audit shared work two" };

    expect(resolveAgentReference({ name: "Config and plugin audit", state: "running" }, [config])).toMatchObject({
      agentId: "config-agent",
      state: "waiting",
      nativeStatus: "idle",
    });
    expect(resolveAgentReference({ name: "Audit", state: "running" }, [duplicateOne, duplicateTwo])).toMatchObject({
      state: "stale",
      nativeStatus: null,
    });
  });
});

const thread: ChatThreadRecord = {
  id: "thread-1",
  title: "Durable chat",
  groupId: null,
  conductorAgentId: "agent-1",
  mission: { statement: "Keep helping", revision: 1 },
  workspacePath: "/workspace",
  archived: false,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:01:00.000Z",
};

function agentRecord(status: NativeAgentStatus): AgentRecord {
  return {
    id: "agent-1",
    logicalAgentId: "logical-agent-1",
    workflowId: "chat:thread-1",
    runId: "chat-run:thread-1",
    parentAgentId: null,
    depth: 0,
    objective: "Conduct the reusable chat",
    missionHash: "mission-1",
    requestedHarness: "codex",
    requestedModel: "gpt-test",
    harness: "codex",
    model: "gpt-test",
    permissions: "full-access",
    status,
    nativeSessionId: "native-session-1",
    nativeRunId: "native-run-1",
    workspacePath: "/workspace",
    output: null,
    error: status === "interrupted" || status === "lost" ? "Recovery failed safely." : null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:01:00.000Z",
    startedAt: "2026-08-30T00:00:10.000Z",
    finishedAt: ["completed", "failed", "cancelled", "interrupted", "lost"].includes(status)
      ? "2026-08-30T00:01:00.000Z"
      : null,
  };
}

function bootstrap(agent: AgentRecord, runStatus = "completed"): BootstrapEnvelope {
  return {
    mode: "runtime",
    agents: [agent],
    agentCosts: {},
    runs: [{
      id: "chat-run:thread-1",
      workflowId: "chat:thread-1",
      workflowRevision: 1,
      status: runStatus,
      input: {},
      output: null,
      error: null,
      startedAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:01:00.000Z",
      finishedAt: "2026-08-30T00:01:00.000Z",
      cancelRequested: false,
    }],
    runCosts: {},
    costs: { amount: 0, currency: "USD", provenance: "unavailable" },
  } as BootstrapEnvelope;
}

function event(cursor: number, type: string, payload: EventEnvelope["payload"]): EventEnvelope {
  return {
    id: `event-${cursor}`,
    cursor,
    type,
    workflowId: "chat:thread-1",
    runId: "chat-run:thread-1",
    agentId: "agent-1",
    occurredAt: `2026-08-30T00:00:${String(cursor).padStart(2, "0")}.000Z`,
    payload,
    provenance: { source: "daemon" },
  };
}

describe("durable chat projection", () => {
  it("classifies recovery failures and pending cancellation without marking them settled", () => {
    expect(compactAgentState("interrupted")).toBe("failed");
    expect(compactAgentState("lost")).toBe("failed");
    expect(compactAgentState("cancel-requested")).toBe("blocked");
    expect(compactAgentState("cancelled")).toBe("cancelled");
    expect(threadToSummary(thread, [agentRecord("interrupted")], false, false).state).toBe("attention");
    expect(threadToSummary(thread, [agentRecord("cancel-requested")], false, false).state).toBe("attention");
  });

  it("does not expose a reusable chat run's stale terminal workflow status", () => {
    const snapshot = snapshotForThread(thread, bootstrap(agentRecord("idle"), "completed"), []);

    expect(snapshot.phase).toBe("Ready");
    expect(snapshot.runStatus).toBeUndefined();
  });

  it("projects recovery, continuation, cancellation, and interruption activity", () => {
    const events = [
      event(1, "agent.recovered", {
        continuity: "native-run-reattached",
        previousStatus: "running",
        recoveredStatus: "running",
      }),
      event(2, "agent.recovery.continued", { queued: false }),
      event(3, "agent.cancel.reissued", { previousStatus: "cancel-requested" }),
      event(4, "agent.interrupted", { error: "Outcome was unknown, so Symphony did not retry." }),
    ];
    const snapshot = snapshotForThread(thread, bootstrap(agentRecord("interrupted"), "running"), events);

    expect(snapshot.events.map((item) => item.title)).toEqual([
      "Conductor interrupted",
      "Conductor cancellation reissued",
      "Conductor recovery continued",
      "Conductor recovered",
    ]);
    expect(snapshot.events.find((item) => item.id === "event-1")?.detail).toContain("Reattached");
    expect(snapshot.events.find((item) => item.id === "event-2")?.detail).toContain("Delivered");
    expect(snapshot.events.find((item) => item.id === "event-4")?.detail).toContain("Outcome was unknown");
    expect(snapshot.events.every((item) => item.source === "runtime-observed")).toBe(true);
  });
});
