import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/symphony.config", () => ({
  symphonyConfig: { apiBasePath: "/v1" },
}), { virtual: true });

import {
  commitObjectiveCheckpoint,
  commitObjectivePlan,
  createObjective,
  fetchBootstrap,
  fetchObjectiveDetail,
  fetchObjectiveSnapshot,
  fetchObjectiveList,
  fetchAgentMessageProjection,
  replyToAgentMessage,
  markAgentMessageHandled,
  cancelAgentMessage,
  cancelObjectiveRun,
  requestObjectiveApproval,
  resolveObjectiveApproval,
  resumeObjectiveCheckpoint,
  retryObjectiveCheckpoint,
  RuntimeRequestError,
} from "../apps/web/src/lib/symphony/runtime-client.js";
import { previewEnvelope } from "../apps/web/src/lib/symphony/preview.js";
import type { WorkflowRevisionRecord } from "../apps/web/src/lib/symphony/contracts.js";

const workflow: WorkflowRevisionRecord = {
  id: "workflow-build",
  revision: 3,
  mission: { statement: "Build the release", keyResults: ["Ship it"] },
  definition: { steps: [{ id: "compile", run: "pnpm build" }] },
  ir: { nodes: ["compile"] },
  hash: "workflow-hash",
  createdAt: "2026-08-30T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web runtime bootstrap projection", () => {
  it("retains daemon workflows in the web bootstrap envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input === "/v1/bootstrap") {
        return new Response(JSON.stringify({
          cursor: 12,
          events: [],
          workflows: [workflow],
          runs: [],
          agents: [],
          messages: [],
          projects: [],
          costs: {},
          runCosts: {},
          agentCosts: {},
          plugins: [],
          settings: {},
          daemon: { version: "test", startedAt: "2026-08-30T00:00:00.000Z", noPlugins: true },
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }));

    const envelope = await fetchBootstrap("runtime");

    expect(envelope.workflows).toEqual([workflow]);
  });

  it("keeps preview bootstrap workflow-free by default", () => {
    expect(previewEnvelope().workflows).toEqual([]);
  });
});

describe("web objective projection client", () => {
  it("fetches the atomic objective snapshot by aggregate identity", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ version: 1, eventCursor: 18, objective: { objectiveId: "objective-1" } }), { status: 200 });
    }));

    const snapshot = await fetchObjectiveSnapshot(" objective/1 ");

    expect(calls).toEqual(["/v1/objectives/objective%2F1/snapshot"]);
    expect(snapshot.eventCursor).toBe(18);
  });

  it("fetches the authoritative list and detail contracts with bounded query parameters", async () => {
    const calls: string[] = [];
    const detail = {
      run: { runId: "objective-run-1" },
      planRevisions: [],
      checkpoints: [],
      approvals: [],
      events: [],
      eventCursor: 42,
      hasMore: false,
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify(url.includes("/objectives/objective-run-1") ? detail : {
        objectives: [detail.run],
        limit: 3,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const list = await fetchObjectiveList({ limit: 3, state: ["executing", "awaiting-approval"], workflowId: "workflow/a" });
    const fetchedDetail = await fetchObjectiveDetail("objective-run-1", { limit: 50, after: 12 });

    expect(calls[0]).toBe("/v1/objectives?limit=3&workflowId=workflow%2Fa&state=executing%2Cawaiting-approval");
    expect(calls[1]).toBe("/v1/objectives/objective-run-1?limit=50&after=12");
    expect(list.limit).toBe(3);
    expect(fetchedDetail.eventCursor).toBe(42);
    expect(fetchedDetail.hasMore).toBe(false);
  });

  it("preserves strict daemon errors for objective reads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("objective unavailable", { status: 503 })));

    await expect(fetchObjectiveList()).rejects.toBeInstanceOf(RuntimeRequestError);
    await expect(fetchObjectiveDetail("objective-run-1")).rejects.toMatchObject({ status: 503 });
  });

  it("sends every objective mutation to its typed route with an idempotency key", async () => {
    const calls: Array<{ url: string; method: string; key: string | null; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        key: new Headers(init?.headers).get("Idempotency-Key"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const task = {
      id: "build",
      objective: "Build the release",
      dependsOn: [],
      outputSchema: {},
      model: "auto",
      harness: "auto" as const,
      inputs: [],
      requiresApproval: false,
    };
    await createObjective({
      objectiveId: "objective-1",
      workflowId: "workflow-1",
      workflowRevision: 1,
      workflowHash: "workflow-hash",
      workspace: { path: "/work/release", dirtyPolicy: "require-clean" },
      policy: {
        effectivePermission: "read-only",
        allowedCapabilities: ["read"],
        budget: {
          maxCostUsd: null,
          maxInputTokens: null,
          maxOutputTokens: null,
          maxTotalTokens: 100,
          maxModelCalls: 2,
          maxToolCalls: null,
          maxWallTimeSeconds: null,
          maxOutputBytes: null,
          maxStorageBytes: null,
          maxLoopIterations: null,
          maxConcurrentAgents: 1,
          maxDepth: null,
        },
        sideEffectClassCeiling: "read",
        approvalPolicy: { mode: "never" },
        expiresAt: null,
      },
      spec: {
        id: "objective-1",
        statement: "Ship the release",
        criteria: [],
        approvalPolicy: { mode: "never" },
        maxReplans: 1,
      },
      tasks: [task],
    }, "objective-create-key");
    await commitObjectivePlan("run/1", { expectedPlanRevision: 0, tasks: [task], reason: "Replan" }, "objective-plan-key");
    await commitObjectiveCheckpoint("run/1", { eventCursor: 8, reason: "Build finished", taskUpdates: [{ taskId: "build", state: "completed" }] }, "objective-checkpoint-key");
    await requestObjectiveApproval("run/1", {
      kind: "task",
      taskId: "build",
      question: "Run the release?",
      operationId: "operation-1",
      requestHash: "request-hash",
      policyHash: "policy-hash",
      sideEffectClass: "local",
      canonicalTarget: "workspace://release",
    }, "objective-approval-key");
    await resolveObjectiveApproval("run/1", "approval/1", { status: "rejected", decision: "not yet" }, "objective-resolution-key");

    expect(calls.map(({ url, method, key }) => ({ url, method, key }))).toEqual([
      { url: "/v1/objectives", method: "POST", key: "objective-create-key" },
      { url: "/v1/objectives/run%2F1/plans", method: "POST", key: "objective-plan-key" },
      { url: "/v1/objectives/run%2F1/checkpoints", method: "POST", key: "objective-checkpoint-key" },
      { url: "/v1/objectives/run%2F1/approvals", method: "POST", key: "objective-approval-key" },
      { url: "/v1/objectives/run%2F1/approvals/approval%2F1/resolve", method: "POST", key: "objective-resolution-key" },
    ]);
    expect(calls[0]?.body).toMatchObject({
      objectiveId: "objective-1",
      workflowId: "workflow-1",
      workspace: { path: "/work/release", dirtyPolicy: "require-clean" },
      policy: { budget: { maxCostUsd: null, maxTotalTokens: 100, maxConcurrentAgents: 1 } },
    });
    expect(calls[0]?.body).not.toHaveProperty("requestKey");
    expect(calls[4]?.body).toEqual({ status: "rejected", decision: "not yet" });
  });

  it("uses checkpoint fences for recovery and the workflow cancellation route for stop", async () => {
    const calls: Array<{ url: string; method: string; key: string | null; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        key: new Headers(init?.headers).get("Idempotency-Key"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ status: "replayed", replayed: true }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await resumeObjectiveCheckpoint("run/1", "checkpoint/2", { expectedSequence: 2 }, "resume-key");
    await retryObjectiveCheckpoint("run/1", "checkpoint/2", {
      expectedSequence: 2,
      activity: { kind: "task", id: "build", attemptId: "attempt/1" },
    }, "retry-key");
    await cancelObjectiveRun("run/1", "stop-key");

    expect(calls).toEqual([
      { url: "/v1/objectives/run%2F1/checkpoints/checkpoint%2F2/resume", method: "POST", key: "resume-key", body: { expectedSequence: 2 } },
      { url: "/v1/objectives/run%2F1/checkpoints/checkpoint%2F2/retry", method: "POST", key: "retry-key", body: { expectedSequence: 2, activity: { kind: "task", id: "build", attemptId: "attempt/1" } } },
      { url: "/v1/runs/run%2F1/cancel", method: "POST", key: "stop-key", body: undefined },
    ]);
  });
});

describe("web agent message projection client", () => {
  it("uses the canonical durable projection route", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ actorId: null, messageCursor: 4, receiptCursor: 7, inbox: [], outbox: [] }), { status: 200 });
    }));

    const projection = await fetchAgentMessageProjection();

    expect(calls).toEqual(["/v1/agent-messages/projection"]);
    expect(projection).toMatchObject({ messageCursor: 4, receiptCursor: 7, inbox: [], outbox: [] });
  });

  it("keeps the caller-provided idempotency key on every message mutation", async () => {
    const calls: Array<{ url: string; key: string | null; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), key: new Headers(init?.headers).get("Idempotency-Key"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ status: "committed", receipt: null }), { status: 200 });
    }));

    await replyToAgentMessage("message/1", { summary: "Reply" }, "reply-key");
    await markAgentMessageHandled("message/1", "accepted", "handle-key");
    await cancelAgentMessage("message/1", "cancel-key");

    expect(calls).toEqual([
      { url: "/v1/agent-messages/message%2F1/reply", key: "reply-key", body: { summary: "Reply" } },
      { url: "/v1/agent-messages/message%2F1/handled", key: "handle-key", body: { decision: "accepted" } },
      { url: "/v1/agent-messages/message%2F1/cancel", key: "cancel-key", body: {} },
    ]);
  });
});
