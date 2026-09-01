import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDaemon, type SymphonyDaemon } from "../../apps/daemon/src/index.js";
import { SecretStore } from "../../packages/config/src/index.js";
import { DriverRegistry } from "../../packages/drivers/src/registry.js";
import type { ObjectiveControlPlan, WorkflowIr } from "../../packages/protocol/src/index.js";
import { WorkflowCompiler, compileObjectiveControlPlan, type WorkflowDefinition } from "../../packages/workflow/src/index.js";
import { TEST_DAEMON_SECRET } from "../setup.js";
import { DurabilityChaosDriver } from "../fixtures/durability-chaos-driver.js";

/**
 * Live, deterministic durability matrix.
 *
 * Every scenario below starts the real daemon, persists through its real
 * SQLite store, and talks to the public HTTP/SSE boundary. The only fake is
 * the native driver, whose delivery boundaries are explicit and reproducible.
 */

const temporary: string[] = [];
const seed = Number.parseInt(process.env.SYMPHONY_CHAOS_SEED ?? "1", 10) || 1;

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function writeConfig(root: string, port: number, maxConcurrent = 4): void {
  writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
    dataDirectory: ".symphony",
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 100 },
    conductor: { harness: "codex", model: "fixture" },
    agents: {
      maxDepth: null,
      maxConcurrent,
      defaultPermissions: "full-access",
      recoveryTimeoutMs: 250,
      startupTimeoutMs: 40,
      cancellationAcknowledgementTimeoutMs: 40,
      cancellationTerminationGraceMs: 40,
      recoveryConcurrency: 4,
    },
    harnesses: {
      codex: { enabled: true },
      claude: { enabled: false },
      cursor: { enabled: false },
      opencode: { enabled: false },
      pi: { enabled: false },
      acp: [],
    },
    router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
    observer: { provider: "deterministic" },
    plugins: { watch: false },
    workflows: { triggersEnabled: false, maxLoopIterations: 4, approvalExpiryScanMs: 100 },
  }));
}

function secretStore(): SecretStore {
  return new SecretStore(`dev.symphony.durability-chaos-${seed}`, {
    platform: "linux",
    environment: { SYMPHONY_DAEMON_SECRET: TEST_DAEMON_SECRET },
    nativeBackend: null,
  });
}

async function startFixture(root: string, port: number, driver: DurabilityChaosDriver, maxConcurrent = 4): Promise<SymphonyDaemon> {
  writeConfig(root, port, maxConcurrent);
  const registry = new DriverRegistry();
  registry.register(driver);
  return await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: registry, secretStore: secretStore(), credentialPlatform: "linux" });
}

async function waitFor(assertion: () => unknown | Promise<unknown>, timeout = 5_000): Promise<void> {
  await vi.waitFor(assertion, { timeout, interval: 15 });
}

async function jsonRequest(base: string, path: string, init: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { response, body };
}

async function ready(base: string): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "ready" });
  });
}

function registerControlWorkflow(daemon: SymphonyDaemon, root: string, id: string, signalExpiryMs = 2_000): WorkflowIr {
  const definition: WorkflowDefinition = {
    id,
    name: `Durability chaos ${id}`,
    mission: { statement: "Exercise a durable control boundary.", keyResults: ["Control identity survives faults."] },
    workspace: { path: root, dirtyPolicy: "local-only" },
    inputSchema: { type: "object", additionalProperties: true },
    output: "signal-gate",
    steps: [{
      id: "control-sequence",
      type: "sequence",
      steps: [
        // Keep the first frontier open long enough for a slow CI host to
        // observe it before the due callback races the HTTP assertions.
        { id: "timer-gate", type: "timer", durationMs: 500, expiresAfterMs: 1_500 },
        { id: "signal-gate", type: "signal", signalKey: "chaos.ready", expiresAfterMs: signalExpiryMs, payloadSchema: { status: "string" } },
      ],
    }],
    triggers: [{ id: "manual", type: "manual" }],
  };
  const workflow = new WorkflowCompiler().compile(definition, 1);
  daemon.workflows.register(workflow);
  return workflow;
}

function signalOnlyWorkflow(daemon: SymphonyDaemon, root: string, id: string, expiryMs: number): WorkflowIr {
  const definition: WorkflowDefinition = {
    id,
    name: `Durability chaos expiry ${id}`,
    mission: { statement: "Exercise signal expiry and cancellation.", keyResults: [] },
    workspace: { path: root, dirtyPolicy: "local-only" },
    inputSchema: { type: "object", additionalProperties: true },
    output: "signal-gate",
    steps: [{ id: "signal-gate", type: "signal", signalKey: "chaos.expire", expiresAfterMs: expiryMs, payloadSchema: {} }],
    triggers: [{ id: "manual", type: "manual" }],
  };
  const workflow = new WorkflowCompiler().compile(definition, 1);
  daemon.workflows.register(workflow);
  return workflow;
}

function objectiveBody(workflow: WorkflowIr, plan: ObjectiveControlPlan, root: string, runId: string, objectiveId = runId): Record<string, unknown> {
  return {
    runId,
    objectiveId,
    workflowId: workflow.definition.id,
    workflowRevision: workflow.revision,
    workflowHash: workflow.hash,
    workspace: { path: root, dirtyPolicy: "local-only" },
    policy: { budget: {} },
    spec: {
      id: objectiveId,
      statement: "A deterministic chaos-matrix objective.",
      criteria: [],
      approvalPolicy: { mode: "never" },
      maxReplans: 0,
    },
    context: { seed },
    controlPlan: plan,
  };
}

async function createObjective(base: string, body: Record<string, unknown>, key: string): Promise<{ response: Response; body: any }> {
  return await jsonRequest(base, "/v1/objectives", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

function waitingSuspension(daemon: SymphonyDaemon, runId: string, nodeId?: string): any {
  return daemon.store.listObjectiveControlSuspensions(runId, { status: "waiting" })
    .find((entry) => nodeId === undefined || entry.nodeId === nodeId) ?? null;
}

function events(daemon: SymphonyDaemon, runId: string): any[] {
  return daemon.store.recentEvents({ runId, limit: 2_000 });
}

function agentWorkOrder(root: string, id: string, runId = "chaos-agent-run"): Record<string, unknown> {
  return {
    id,
    workflowId: "chaos-agent-workflow",
    runId,
    parentAgentId: null,
    depth: 0,
    mission: { id: "chaos-mission", revision: 1, hash: "chaos-mission-hash", statement: "Exercise a native durability boundary.", keyResults: [] },
    objective: "Hold a deterministic native session for the chaos matrix.",
    model: "fixture",
    harness: "codex",
    permissions: "full-access",
    outputSchema: {},
    inputs: [],
    workspace: { path: root, dirtyPolicy: "local-only" },
    metadata: { chaosSeed: seed },
  };
}

describe("durability chaos matrix (live daemon)", () => {
  it("keeps a control frontier alive through SSE disconnect/restart and fences signal replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-durability-chaos-control-"));
    temporary.push(root);
    const port = await availablePort();
    const driver = new DurabilityChaosDriver();
    let daemon = await startFixture(root, port, driver);
    const base = `http://127.0.0.1:${port}`;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await ready(base);
      const workflow = registerControlWorkflow(daemon, root, "chaos-control-workflow");
      const plan = compileObjectiveControlPlan(workflow);
      const body = objectiveBody(workflow, plan, root, "chaos-control-run");
      const stream = await fetch(`${base}/v1/events?projection=ui`);
      expect(stream.status).toBe(200);
      reader = stream.body?.getReader();
      expect(reader).toBeDefined();
      expect((await reader!.read()).done).toBe(false);
      const created = await createObjective(base, body, "chaos-control-create");
      expect(created.response.status).toBe(201);
      const createReplay = await createObjective(base, body, "chaos-control-create");
      expect(createReplay.response.status).toBe(201);
      expect(createReplay.body).toEqual(created.body);
      const createConflict = await createObjective(base, { ...body, context: { seed, changed: true } }, "chaos-control-create");
      expect(createConflict.response.status).toBe(409);
      await waitFor(() => expect(waitingSuspension(daemon, "chaos-control-run", "timer-gate")).not.toBeNull());
      const timerBefore = waitingSuspension(daemon, "chaos-control-run", "timer-gate");
      expect(timerBefore.attemptId).toEqual(expect.any(String));
      const outOfOrderSignal = await jsonRequest(base, "/v1/objectives/chaos-control-run/signals", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-signal-out-of-order" },
        body: JSON.stringify({ signalKey: "chaos.ready", deliveryId: "delivery-before-wait", payload: { status: "ready" } }),
      });
      expect(outOfOrderSignal.response.status).toBe(409);
      await reader!.cancel();
      reader = undefined;
      expect(daemon.store.getObjectiveRun("chaos-control-run")?.state).toBe("executing");

      const cursorBeforeRestart = daemon.store.latestCursor();
      await daemon.close();
      daemon = await startFixture(root, port, new DurabilityChaosDriver());
      await ready(base);
      const restartReplay = await createObjective(base, body, "chaos-control-create");
      expect(restartReplay.response.status).toBe(201);
      expect(restartReplay.body).toEqual(created.body);
      await waitFor(() => expect(daemon.store.getObjectiveControlSnapshot("chaos-control-run", daemon.store.getObjectiveControlHead("chaos-control-run")!.latestSnapshotSequence)).not.toBeNull());
      await waitFor(() => expect(waitingSuspension(daemon, "chaos-control-run", "signal-gate")).not.toBeNull(), 6_000);
      const signal = waitingSuspension(daemon, "chaos-control-run", "signal-gate");
      expect(signal.subscriptionKey).toContain("chaos.ready");
      expect(daemon.store.latestCursor()).toBeGreaterThanOrEqual(cursorBeforeRestart);

      const wrongSubscription = await jsonRequest(base, "/v1/objectives/chaos-control-run/signals", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-signal-wrong" },
        body: JSON.stringify({ signalKey: "chaos.ready", subscriptionKey: "wrong-subscription", attemptId: signal.attemptId, deliveryId: "delivery-1", payload: { status: "ready" } }),
      });
      expect(wrongSubscription.response.status).toBe(403);

      const delivery = { signalKey: "chaos.ready", subscriptionKey: signal.subscriptionKey, attemptId: signal.attemptId, deliveryId: "delivery-1", payload: { status: "ready" } };
      const accepted = await jsonRequest(base, "/v1/objectives/chaos-control-run/signals", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-signal-accepted" },
        body: JSON.stringify(delivery),
      });
      expect(accepted.response.status).toBe(200);
      expect(accepted.body).toMatchObject({ status: "delivered", deliveryId: "delivery-1" });

      // The producer may retry with a different HTTP request key. The scoped
      // delivery receipt, not the HTTP connection, is the exactly-once fence.
      const replay = await jsonRequest(base, "/v1/objectives/chaos-control-run/signals", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-signal-retry" },
        body: JSON.stringify(delivery),
      });
      expect(replay.response.status).toBe(200);
      expect(replay.body).toMatchObject({ status: "replayed", deliveryId: "delivery-1" });
      const conflicting = await jsonRequest(base, "/v1/objectives/chaos-control-run/signals", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-signal-conflict" },
        body: JSON.stringify({ ...delivery, payload: { status: "different" } }),
      });
      expect(conflicting.response.status).toBe(409);
      await waitFor(() => expect(daemon.store.getObjectiveRun("chaos-control-run")?.state).toBe("succeeded"));
      const settled = daemon.store.listObjectiveControlSuspensions("chaos-control-run");
      expect(settled.find((entry) => entry.nodeId === "timer-gate")?.status).toBe("delivered");
      expect(settled.find((entry) => entry.nodeId === "signal-gate")?.status).toBe("delivered");
      expect(events(daemon, "chaos-control-run").map((event) => event.type)).toEqual(expect.arrayContaining([
        "objective.control.timer.scheduled",
        "objective.control.timer.due",
        "objective.control.signal.subscribed",
        "objective.control.signal.delivered",
      ]));
      const aggregate = await jsonRequest(base, "/v1/objectives/chaos-control-run/snapshot", { method: "GET" });
      expect(aggregate.response.status).toBe(200);
      expect(aggregate.body.events.every((event: any) => event.cursor <= aggregate.body.eventCursor)).toBe(true);
    } finally {
      if (reader) await reader.cancel();
      await daemon.close();
    }
  }, 30_000);

  it("expires and cancels signal suspensions through durable reducer paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-durability-chaos-suspension-"));
    temporary.push(root);
    const port = await availablePort();
    const daemon = await startFixture(root, port, new DurabilityChaosDriver());
    const base = `http://127.0.0.1:${port}`;
    try {
      await ready(base);
      const expiryWorkflow = signalOnlyWorkflow(daemon, root, "chaos-expiry-workflow", 100);
      const expiryPlan = compileObjectiveControlPlan(expiryWorkflow);
      const expiry = await createObjective(base, objectiveBody(expiryWorkflow, expiryPlan, root, "chaos-expiry-run"), "chaos-expiry-create");
      expect(expiry.response.status).toBe(201);
      await waitFor(() => expect(waitingSuspension(daemon, "chaos-expiry-run", "signal-gate")).not.toBeNull());
      await waitFor(() => expect(daemon.store.listObjectiveControlSuspensions("chaos-expiry-run").find((entry) => entry.nodeId === "signal-gate")?.status).toBe("expired"), 4_000);
      expect(events(daemon, "chaos-expiry-run").map((event) => event.type)).toContain("objective.control.signal.expired");

      const cancelWorkflow = signalOnlyWorkflow(daemon, root, "chaos-cancel-workflow", 2_000);
      const cancelPlan = compileObjectiveControlPlan(cancelWorkflow);
      const cancelled = await createObjective(base, objectiveBody(cancelWorkflow, cancelPlan, root, "chaos-cancel-run"), "chaos-cancel-create");
      expect(cancelled.response.status).toBe(201);
      await waitFor(() => expect(waitingSuspension(daemon, "chaos-cancel-run", "signal-gate")).not.toBeNull());
      const cancelledState = daemon.objectiveRuntime.cancelControlSuspensions("chaos-cancel-run", {
        actor: { type: "system", id: "durability-chaos" },
        permissionCeiling: "full-access",
      });
      expect(cancelledState).not.toBeNull();
      await waitFor(() => expect(daemon.store.listObjectiveControlSuspensions("chaos-cancel-run").find((entry) => entry.nodeId === "signal-gate")?.status).toBe("cancelled"));
      expect(events(daemon, "chaos-cancel-run").map((event) => event.type)).toContain("objective.control.suspension.cancelled");
    } finally {
      await daemon.close();
    }
  }, 20_000);

  it("fails closed for native startup uncertainty and restores a queued follow-up after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-durability-chaos-native-"));
    temporary.push(root);
    const port = await availablePort();
    const firstDriver = new DurabilityChaosDriver();
    firstDriver.hangNextStart = true;
    let daemon = await startFixture(root, port, firstDriver, 1);
    const base = `http://127.0.0.1:${port}`;
    try {
      await ready(base);
      const unknown = await jsonRequest(base, "/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-native-unknown" },
        body: JSON.stringify(agentWorkOrder(root, "chaos-unknown-agent", "chaos-unknown-run")),
      });
      expect(unknown.response.status).toBe(202);
      const unknownAgentId = unknown.body.id as string;
      await waitFor(() => expect(daemon.store.getAgent(unknownAgentId)?.status).toBe("interrupted"));
      expect(daemon.store.getAgent(unknownAgentId)?.error).toContain("will not retry");
      expect(events(daemon, "chaos-unknown-run").map((event) => event.type)).toContain("agent.interrupted");
      await daemon.close();

      const secondDriver = new DurabilityChaosDriver();
      daemon = await startFixture(root, port, secondDriver, 1);
      await ready(base);
      expect(daemon.store.getAgent(unknownAgentId)?.status).toBe("interrupted");
      expect(secondDriver.startedAgentIds).not.toContain(unknownAgentId);

      const retained = await jsonRequest(base, "/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-retained-create" },
        body: JSON.stringify(agentWorkOrder(root, "chaos-retained-agent", "chaos-follow-up-run")),
      });
      expect(retained.response.status).toBe(202);
      const retainedAgentId = retained.body.id as string;
      await waitFor(() => expect(daemon.store.getAgent(retainedAgentId)?.status).toBe("running"));
      const followUp = await daemon.agents.message(retainedAgentId, "Continue after the daemon restarts.", { attemptId: "chaos-follow-up-1" });
      expect(followUp).toMatchObject({ queued: true, receiptId: "chaos-follow-up-1" });
      expect(daemon.store.getMetadata<any>(`agent-follow-up:${retainedAgentId}`)).toMatchObject({ state: "queued", attemptId: "chaos-follow-up-1" });
      await daemon.close();

      const thirdDriver = new DurabilityChaosDriver();
      thirdDriver.resumeStates.set(retainedAgentId, "idle");
      daemon = await startFixture(root, port, thirdDriver, 1);
      await ready(base);
      await waitFor(() => expect(thirdDriver.resumedAgentIds).toContain(retainedAgentId));
      const followUpRequestId = `symphony:message:${retainedAgentId}:chaos-follow-up-1`;
      await waitFor(() => expect(thirdDriver.messages.filter((message) => message.requestId === followUpRequestId)).toHaveLength(1));
      const followUpMetadata = daemon.store.getMetadata<any>(`agent-follow-up:${retainedAgentId}`);
      expect(followUpMetadata).toMatchObject({ attemptId: "chaos-follow-up-1" });
      expect(["dispatching", "delivered", "settled"]).toContain(followUpMetadata?.state);
      thirdDriver.release(retainedAgentId, "completed");
      await waitFor(() => expect(daemon.store.getAgent(retainedAgentId)?.status).toBe("completed"));
      expect(thirdDriver.messages.filter((message) => message.requestId === followUpRequestId)).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  }, 30_000);

  it("replays attention resolution and fences artifact/checkpoint evidence at one event cursor", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-durability-chaos-evidence-"));
    temporary.push(root);
    const port = await availablePort();
    const daemon = await startFixture(root, port, new DurabilityChaosDriver());
    const base = `http://127.0.0.1:${port}`;
    try {
      await ready(base);
      const workflow = signalOnlyWorkflow(daemon, root, "chaos-evidence-workflow", 2_000);
      const plan = compileObjectiveControlPlan(workflow);
      const created = await createObjective(base, objectiveBody(workflow, plan, root, "chaos-evidence-run"), "chaos-evidence-create");
      expect(created.response.status).toBe(201);
      const policyHash = created.body.policyHash as string;

      const attention = await jsonRequest(base, "/v1/objectives/chaos-evidence-run/attentions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-attention-request" },
        body: JSON.stringify({
          operationId: "chaos-approval-operation",
          reason: "A deterministic evidence run needs a durable decision.",
          consequence: "The run remains held until the decision is recorded.",
          risk: "low",
          urgency: "normal",
          confidence: 1,
          blockedResource: { kind: "other", id: "chaos", description: "Chaos matrix" },
          proposedAction: "Continue",
          authorityBoundary: { permission: "full-access", sideEffectClass: "local", capability: null, resource: "objective://chaos-evidence-run", description: "Resume the evidence run." },
          evidenceRefs: [],
          alternatives: [],
          nodeId: null,
          attemptId: null,
          expiresAt: null,
        }),
      });
      expect(attention.response.status).toBe(201);
      const attentionId = attention.body.attention.id as string;
      // Generic attention intentionally cannot be resolved by a made-up UI
      // decision; create a bound approval to exercise resolution replay.
      const approval = await jsonRequest(base, "/v1/objectives/chaos-evidence-run/approvals", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-approval-request" },
        body: JSON.stringify({
          kind: "plan",
          question: "Approve evidence publication.",
          scope: { runId: "chaos-evidence-run" },
          operationId: "chaos-approval-operation",
          requestHash: "chaos-approval-request-hash",
          policyHash,
          sideEffectClass: "local",
          canonicalTarget: "objective://chaos-evidence-run/evidence",
          expiresAt: null,
        }),
      });
      expect(approval.response.status).toBe(200);
      const approvalId = approval.body.pendingApprovalId as string;
      const resolved = await jsonRequest(base, `/v1/objectives/chaos-evidence-run/attentions/${attentionId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-attention-resolve" },
        body: JSON.stringify({ status: "resolved", decision: { approved: true } }),
      });
      expect(resolved.response.status).toBe(200);
      const replay = await jsonRequest(base, `/v1/objectives/chaos-evidence-run/attentions/${attentionId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-attention-resolve" },
        body: JSON.stringify({ status: "resolved", decision: { approved: true } }),
      });
      expect(replay.response.status).toBe(200);
      expect(replay.body).toMatchObject({ status: "replayed", replayed: true, attention: resolved.body.attention });
      const conflictingReplay = await jsonRequest(base, `/v1/objectives/chaos-evidence-run/attentions/${attentionId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-attention-resolve" },
        body: JSON.stringify({ status: "resolved", decision: { approved: false } }),
      });
      expect(conflictingReplay.response.status).toBe(409);
      expect((await jsonRequest(base, `/v1/objectives/chaos-evidence-run/attentions/${attentionId}`, { method: "GET" })).response.status).toBe(200);

      const evidenceCursor = daemon.store.latestCursor();
      const checkpointBody = { eventCursor: evidenceCursor, context: { checkpoint: true }, reason: "Persist chaos evidence." };
      const artifactBody = {
        version: 1,
        planRevision: 0,
        kind: "chaos.evidence",
        name: "durability-chaos.json",
        mediaType: "application/json",
        content: { seed, runId: "chaos-evidence-run", invariant: "cursor-fenced" },
        evidence: { eventCursor: evidenceCursor, eventIds: events(daemon, "chaos-evidence-run").map((event) => event.id), observationIds: [] },
        taskId: null,
        attemptId: null,
        controlNodeId: null,
        lineage: [],
        policyHash,
      };
      const artifact = await jsonRequest(base, "/v1/objectives/chaos-evidence-run/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-artifact-publish" },
        body: JSON.stringify(artifactBody),
      });
      expect(artifact.response.status).toBe(201);
      const artifactReplay = await jsonRequest(base, "/v1/objectives/chaos-evidence-run/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-artifact-publish" },
        body: JSON.stringify(artifactBody),
      });
      expect(artifactReplay.response.status).toBe(201);
      expect(artifactReplay.body).toMatchObject({ status: "replayed", artifact: { id: artifact.body.artifact.id } });
      const artifactConflict = await jsonRequest(base, "/v1/objectives/chaos-evidence-run/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-artifact-publish" },
        body: JSON.stringify({ ...artifactBody, content: { changed: true } }),
      });
      expect(artifactConflict.response.status).toBe(409);

      const checkpoint = await jsonRequest(base, "/v1/objectives/chaos-evidence-run/checkpoints", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-checkpoint-commit" },
        body: JSON.stringify(checkpointBody),
      });
      expect(checkpoint.response.status).toBe(200);
      const checkpointReplay = await jsonRequest(base, "/v1/objectives/chaos-evidence-run/checkpoints", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "chaos-checkpoint-commit" },
        body: JSON.stringify(checkpointBody),
      });
      expect(checkpointReplay.response.status).toBe(200);
      expect(checkpointReplay.body).toEqual(checkpoint.body);
      const aggregate = await jsonRequest(base, "/v1/objectives/chaos-evidence-run/snapshot", { method: "GET" });
      expect(aggregate.response.status).toBe(200);
      expect(aggregate.body.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ name: "durability-chaos.json" })]));
      expect(aggregate.body.checkpoints.length).toBeGreaterThanOrEqual(1);
      expect(aggregate.body.events.every((event: any) => event.cursor <= aggregate.body.eventCursor)).toBe(true);
      expect(aggregate.body.eventCursor).toBeGreaterThanOrEqual(evidenceCursor);
    } finally {
      await daemon.close();
    }
  }, 30_000);
});
