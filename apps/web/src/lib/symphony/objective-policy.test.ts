import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ObjectiveBudgetLedgerRecordSchema,
  ObjectiveBudgetReservationRecordSchema,
  ObjectivePolicySnapshotSchema,
  ObjectiveRunRecordSchema,
} from "../../../../../packages/protocol/src/index.js";
import { ObjectivePolicyRail } from "@/components/symphony/objective-policy-rail";
import { formatObjectiveBudgetPair, formatObjectiveExpiry, formatObjectiveLimit } from "@/lib/symphony/format";
import { projectObjectiveRun } from "@/lib/symphony/objective-project";

const now = "2026-09-01T00:00:00.000Z";
const policy = ObjectivePolicySnapshotSchema.parse({
  version: 1, policyVersion: 1, policyHash: "policy-hash-1", runId: "policy-run-1", objectiveId: "policy-objective-1",
  workflowId: "policy-workflow-1", workflowRevision: 1, workflowHash: "policy-workflow-hash-1",
  actor: { type: "user", id: "user-1" }, effectivePermission: "read-only", allowedCapabilities: ["read"],
  workspace: { path: "/tmp/policy-workspace", dirtyPolicy: "require-clean" },
  budget: { maxCostUsd: 2, maxTotalTokens: 100, maxConcurrentAgents: 2, maxWallTimeSeconds: 900 },
  sideEffectClassCeiling: "read", approvalPolicy: { mode: "never" }, expiresAt: "2026-09-01T02:00:00.000Z", createdAt: now,
});
const run = ObjectiveRunRecordSchema.parse({
  version: 1, runId: "policy-run-1", objectiveId: "policy-objective-1", workflowId: "policy-workflow-1", workflowRevision: 1,
  workflowHash: "policy-workflow-hash-1", conductorAgentId: null, policy, policyHash: policy.policyHash, pauseReason: null,
  spec: { id: "policy-objective-1", statement: "Inspect the policy envelope.", criteria: [], approvalPolicy: { mode: "never" }, maxReplans: 1 },
  state: "executing", activePlanRevision: 0, latestCheckpointId: null, pendingApprovalId: null, replanCount: 0, tasks: [], context: {},
  output: null, error: null, requestKey: "policy-run-request-1", createdAt: now, updatedAt: now, startedAt: now, finishedAt: null,
});
const ledger = ObjectiveBudgetLedgerRecordSchema.parse({
  version: 1, runId: run.runId, objectiveId: run.objectiveId, policyHash: policy.policyHash, limits: policy.budget,
  reserved: { costUsd: 0.25, totalTokens: 20 }, consumed: { costUsd: 0.5, inputTokens: 20, outputTokens: 30, totalTokens: 50, modelCalls: 2, toolCalls: 3, wallTimeSeconds: 120 },
  status: "active", pauseReason: null, revision: 1, requestKey: "policy-ledger-request-1", createdAt: now, updatedAt: now,
});
const reservation = ObjectiveBudgetReservationRecordSchema.parse({
  version: 1, id: "reservation-1", runId: run.runId, objectiveId: run.objectiveId, policyHash: policy.policyHash,
  reservationKey: "reservation-key-1", attemptId: "attempt-1", agentId: "agent-1", amount: { costUsd: 0.25, totalTokens: 20, toolCalls: 1 },
  state: "reserved", revision: 0, requestKey: "reservation-request-1", createdAt: now, updatedAt: now, releasedAt: null,
});

describe("objective policy and budget web projection", () => {
  it("projects ceilings, measured consumption, and only active reservations", () => {
    const projection = projectObjectiveRun({ run, budgetLedger: ledger, reservations: [reservation, { ...reservation, id: "released", state: "released" }], debits: [] });
    expect(projection.policy).toMatchObject({ available: true, effectivePermission: "read-only", workspacePath: "/tmp/policy-workspace", expiresAt: policy.expiresAt });
    expect(projection.budget).toMatchObject({ available: true, status: "active", unknownCost: false, consumed: expect.objectContaining({ costUsd: 0.5, totalTokens: 50 }) });
    expect(projection.budget.activeReservations.map((item) => item.id)).toEqual(["reservation-1"]);
  });

  it("does not turn legacy absence into an implicit zero", () => {
    const legacy = projectObjectiveRun({ run: { ...run, policy: null, policyHash: null } });
    expect(legacy.policy).toMatchObject({ available: false, hash: null, workspacePath: null });
    expect(legacy.budget).toMatchObject({ available: false, limits: null, consumed: null, reserved: null, unknownCost: true });
  });

  it("formats unlimited, unknown, and expiry values explicitly", () => {
    expect(formatObjectiveLimit(null, true, "cost")).toBe("No limit");
    expect(formatObjectiveLimit(null, false, "cost")).toBe("Unknown");
    expect(formatObjectiveBudgetPair(null, 2, true, "cost", true)).toContain("Unknown / $2.00");
    expect(formatObjectiveExpiry(null)).toBe("No expiry");
    expect(formatObjectiveExpiry("not-a-date")).toBe("Unknown");
  });

  it("renders a read-only rail with attention and reservation facts", () => {
    const projection = projectObjectiveRun({
      run: { ...run, pauseReason: "budget-unknown-usage" },
      budgetLedger: { ...ledger, status: "paused", pauseReason: "budget-unknown-usage" }, reservations: [reservation], debits: [],
    });
    const html = renderToStaticMarkup(createElement(ObjectivePolicyRail, { projection }));
    expect(html).toContain("Policy &amp; budget");
    expect(html).toContain("budget-unknown-usage");
    expect(html).toContain("Unknown / $2.00");
    expect(html).toContain("Active reservations");
    expect(html).not.toContain("Approve");
  });
});
