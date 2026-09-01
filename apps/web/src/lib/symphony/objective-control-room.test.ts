import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ObjectiveControlRoom } from "@/components/symphony/objective-control-room";
import type { ObjectiveProjection } from "./objective-project";
import type { ObjectiveWorkspaceProjection } from "./objective-snapshot";
import { buildControlRoomViewModel, classifyControlRoomLane, projectControlRoomObjective } from "./objective-control-room";

const baseProjection = (overrides: Partial<ObjectiveProjection> = {}): ObjectiveProjection => ({
  runId: "run-1",
  objectiveId: "objective-1",
  workflowId: "workflow-1",
  mission: { statement: "Make the system observable.", criteria: [], revision: 2, hash: "workflow-hash-1" },
  state: "executing",
  policy: { available: false, hash: null, effectivePermission: null, sideEffectClassCeiling: null, workspacePath: null, dirtyPolicy: null, expiresAt: null },
  budget: { available: true, status: "active", pauseReason: null, limits: null, consumed: { costUsd: 0.42, inputTokens: 10, outputTokens: 20, totalTokens: 30, modelCalls: 1, toolCalls: 2, wallTimeSeconds: 4, outputBytes: 0, storageBytes: 0, loopIterations: 0 }, reserved: { costUsd: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, wallTimeSeconds: 0, outputBytes: 0, storageBytes: 0, loopIterations: 0 }, activeReservations: [], reservationsAvailable: true, debits: [], debitsAvailable: true, unknownCost: false },
  terminal: false,
  terminalReason: null,
  error: null,
  output: null,
  planRevision: 3,
  replanCount: 1,
  planRevisions: [],
  frontier: [],
  packets: [],
  approvals: [],
  pendingApproval: null,
  checkpoints: [],
  latestCheckpoint: null,
  evidence: { eventCursor: 0, eventCount: 0, checkpointCount: 0, linkedEventCount: 0 },
  progress: { completed: 0, total: 0, active: 0, blocked: 0, failed: 0, pendingApproval: 0 },
  events: [],
  ...overrides,
});

describe("objective control room projection", () => {
  it("classifies live work and preserves durable identity and measured budget", () => {
    const projection = baseProjection({
      packets: [{
        id: "task-1", objective: "Inspect runtime", state: "running", attemptId: "attempt-1", agentId: "agent-1",
        agent: { name: "Inspect runtime", harness: "codex", model: "gpt-5.6-luna", status: "running" }, dependencies: [], blockedBy: [], requiresApproval: false,
        outputPresent: false, error: null, startedAt: "2026-09-01T00:00:00.000Z", finishedAt: null, latestEvent: null,
      }],
      progress: { completed: 0, total: 1, active: 1, blocked: 0, failed: 0, pendingApproval: 0 },
      events: [{ id: "event-1", cursor: 9, type: "objective.task.dispatched", at: "2026-09-01T00:01:00.000Z", title: "objective · task · dispatched", detail: "Agent dispatched", agentId: "agent-1", taskId: "task-1", attemptId: "attempt-1", planRevision: 3 }],
    });
    const card = projectControlRoomObjective(projection);
    expect(card).toMatchObject({ runId: "run-1", objectiveId: "objective-1", lane: "working", live: true, strategy: { label: "Objective plan", workflowId: "workflow-1", planRevision: 3 }, budget: { label: "$0.42", unknownCost: false } });
    expect(card.agents).toMatchObject({ total: 1, assignedTasks: 1, active: 1 });
    expect(card.latestEvent).toMatchObject({ cursor: 9, taskId: "task-1" });
  });

  it("prioritizes decisions and failures over generic run state", () => {
    expect(classifyControlRoomLane(baseProjection({
      state: "awaiting-approval",
      pendingApproval: {
        id: "approval-1", operationId: "op-1", requestHash: "request-hash-1", policyHash: "policy-hash-1",
        sideEffectClass: "local", canonicalTarget: "/tmp/project", kind: "completion", planRevision: 1, taskId: null,
        question: "Approve completion?", status: "requested", requestedBy: { type: "user", id: "user-1" },
        requestedAt: "2026-09-01T00:00:00.000Z", expiresAt: null, resolvedAt: null, isExpired: false, isPending: true,
      },
    }))).toBe("needs-input");
    expect(classifyControlRoomLane(baseProjection({ state: "failed", terminal: true, error: "Harness crashed" }))).toBe("blocked");
    expect(classifyControlRoomLane(baseProjection({ state: "succeeded", terminal: true }))).toBe("completed");
  });

  it("sorts multiple objectives by latest authoritative evidence with a stable tie break", () => {
    const older = baseProjection({ runId: "run-b", objectiveId: "objective-b" });
    const newer = baseProjection({ runId: "run-a", objectiveId: "objective-a", events: [{ id: "event-a", cursor: 2, type: "objective.updated", at: "2026-09-01T00:02:00.000Z", title: "objective · updated", detail: "Updated", agentId: null, taskId: null, attemptId: null, planRevision: null }] });
    const model = buildControlRoomViewModel([older, newer]);
    expect(model.cards.map((card) => card.runId)).toEqual(["run-a", "run-b"]);
    expect(model.totals).toMatchObject({ objectives: 2, working: 2, liveAgents: 0 });
    expect(model.lanes["needs-input"]).toHaveLength(0);
  });

  it("renders lane labels, empty states, and daemon identities without inventing data", () => {
    const html = renderToStaticMarkup(createElement(ObjectiveControlRoom, { projections: [baseProjection()] }));
    expect(html).toContain("Objectives in motion");
    expect(html).toContain("Needs input");
    expect(html).toContain("No decisions are waiting.");
    expect(html).toContain("run run-1");
    expect(html).toContain("Make the system observable.");
  });

  it("keeps aggregate recovery and stop controls wired to supplied callbacks", () => {
    const workspace = {
      objectiveId: "objective-aggregate",
      objective: { objectiveId: "objective-aggregate", statement: "Recover the release", state: "active" },
      snapshot: { approvals: [] },
      runs: [{ runId: "run-aggregate", state: "executing" }],
      currentRuns: [{ runId: "run-aggregate", state: "executing" }],
      frontier: [{ runId: "run-aggregate", id: "build", kind: "task", taskId: "build", status: "failed", attemptId: "attempt-1", label: "Build" }],
      checkpoints: [{ runId: "run-aggregate", id: "checkpoint-1", sequence: 3 }],
      attentions: [],
      artifacts: [],
      eventCursor: 12,
    } as unknown as ObjectiveWorkspaceProjection;
    const html = renderToStaticMarkup(createElement(ObjectiveControlRoom, {
      workspaces: [workspace],
      onResumeObjective: () => undefined,
      onRetryObjective: () => undefined,
      onStopObjective: () => undefined,
    }));

    expect(html).toContain("Retry");
    expect(html).toContain("Stop");
    expect(html).not.toContain(">Pause<");
  });
});
