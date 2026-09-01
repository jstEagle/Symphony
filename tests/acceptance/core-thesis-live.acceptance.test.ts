import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { SecretStore } from "../../packages/config/src/index.js";
import type {
  DriverDoctorResult,
  DriverEvent,
  DriverSession,
  DriverStartRequest,
  ModelDescriptor,
  WorkerDriver,
} from "../../packages/protocol/src/index.js";
import { capabilities } from "../../packages/drivers/src/common.js";
import { DriverRegistry } from "../../packages/drivers/src/registry.js";
import {
  compileObjectiveControlPlan,
  WorkflowCompiler,
  type WorkflowDefinition,
  type WorkflowIr,
} from "../../packages/workflow/src/index.js";
import { TEST_DAEMON_SECRET } from "../setup.js";

const FIXED_TIME = "2026-01-01T00:00:00.000Z";
const temporary: string[] = [];

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

function writeConfig(root: string, port: number): void {
  writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
    dataDirectory: ".symphony",
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 250 },
    conductor: { harness: "codex", model: "fixture" },
    agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access", recoveryTimeoutMs: 1_000 },
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
    workflows: { triggersEnabled: false },
  }));
}

function testSecretStore(): SecretStore {
  return new SecretStore("dev.symphony.core-thesis-live-acceptance", {
    platform: "linux",
    environment: { SYMPHONY_DAEMON_SECRET: TEST_DAEMON_SECRET },
    nativeBackend: null,
  });
}

type NativeOutcome = "completed" | "failed" | "unknown";

/**
 * Deterministic native boundary. The fixture deliberately waits for an
 * explicit test release, so a disconnected client cannot accidentally make
 * the assertion pass through a fast fake response.
 */
class LiveAcceptanceDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities();
  readonly startedAgentIds: string[] = [];
  readonly resumedAgentIds: string[] = [];
  readonly startOrders: DriverStartRequest[] = [];
  cancelCalls = 0;
  private readonly consumers = new Map<string, (event: DriverEvent) => void>();
  private readonly requests = new Map<string, DriverStartRequest>();

  async doctor(): Promise<DriverDoctorResult> {
    return {
      driver: this.id,
      available: true,
      authenticated: true,
      version: "core-thesis-fixture",
      capabilities: this.capabilities,
      detail: "Deterministic in-process native delivery fixture",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{
      id: "fixture",
      harness: this.id,
      name: "Core thesis fixture",
      description: "No external model or provider is contacted.",
      modalities: ["text"],
      structuredOutput: true,
      pricing: {},
      metadata: {},
    }];
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.startedAgentIds.push(request.agentId);
    this.startOrders.push(request);
    this.requests.set(request.agentId, request);
    this.consumers.set(request.agentId, onEvent);
    this.emit(request.agentId, "run.started", { agentId: request.agentId }, `start:${request.agentId}`);
    return this.session(request.agentId);
  }

  async resume(session: DriverSession, request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const agentId = typeof session.metadata.agentId === "string"
      ? session.metadata.agentId
      : request.agentId;
    this.resumedAgentIds.push(agentId);
    this.requests.set(agentId, request);
    this.consumers.set(agentId, onEvent);
    return { ...session, state: "running", metadata: { ...session.metadata, agentId } };
  }

  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> {
    return { receiptId: "fixture-message", queued: false };
  }

  async cancel(session: DriverSession): Promise<void> {
    this.cancelCalls += 1;
    const agentId = typeof session.metadata.agentId === "string"
      ? session.metadata.agentId
      : session.nativeSessionId.replace(/^native-/u, "");
    this.emit(agentId, "run.cancelled", this.attemptPayload(agentId, { status: "cancelled" }), `cancel:${agentId}`);
  }

  release(agentId: string, outcome: NativeOutcome): void {
    if (outcome === "unknown") {
      this.emit(agentId, "run.cancelled", this.attemptPayload(agentId, { status: "cancelled" }), `unknown:${agentId}`);
      return;
    }
    if (outcome === "failed") {
      this.emit(agentId, "run.failed", this.attemptPayload(agentId, { error: "fixture delivery failed" }), `failed:${agentId}`);
      return;
    }
    this.emit(agentId, "usage.recorded", this.attemptPayload(agentId, {
      nativeTurnId: `turn:${agentId}`,
      usage: { input_tokens: 7, output_tokens: 4, cost: 0.001 },
      basis: "harness-reported",
    }), `usage:${agentId}`);
    this.emit(agentId, "output.completed", { structuredOutput: { completed: true } }, `output:${agentId}`);
    this.emit(agentId, "run.completed", this.attemptPayload(agentId, { status: "completed" }), `complete:${agentId}`);
  }

  private session(agentId: string): DriverSession {
    return {
      driver: this.id,
      nativeSessionId: `native-${agentId}`,
      nativeRunId: `native-run-${agentId}`,
      state: "running",
      startedAt: FIXED_TIME,
      metadata: { agentId },
    };
  }

  private attemptPayload(agentId: string, payload: Record<string, unknown>): Record<string, unknown> {
    const request = this.requests.get(agentId);
    const metadata = request?.workOrder.metadata ?? {};
    return {
      ...payload,
      objectiveAttemptId: typeof metadata.objectiveAttemptId === "string" ? metadata.objectiveAttemptId : null,
      nativeTurnId: typeof payload.nativeTurnId === "string" ? payload.nativeTurnId : `turn:${agentId}`,
    };
  }

  private emit(agentId: string, kind: DriverEvent["kind"], payload: Record<string, unknown>, nativeEventId: string): void {
    const consumer = this.consumers.get(agentId);
    if (!consumer) throw new Error(`No fixture consumer for ${agentId}`);
    consumer({ kind, nativeEventId, occurredAt: FIXED_TIME, payload: payload as DriverEvent["payload"] });
  }
}

function workflowDefinition(root: string, id = "core-thesis-live-workflow"): WorkflowDefinition {
  return {
    id,
    name: "Core thesis live acceptance",
    mission: {
      statement: "A daemon-owned bounded control loop continues across projection and process faults.",
      keyResults: ["Each loop iteration has one durable native attempt."],
    },
    workspace: { path: root, dirtyPolicy: "local-only" },
    inputSchema: { type: "object", additionalProperties: true },
    output: "steps.loop-work",
    steps: [{
      id: "bounded-loop",
      type: "while",
      condition: { path: "loop.continue", op: "eq", value: true },
      maxIterations: 2,
      steps: [{
        id: "loop-work",
        type: "agent",
        objective: "Perform one deterministic bounded-loop iteration.",
        harness: "codex",
        model: "fixture",
        permissions: "read-only",
        outputSchema: { type: "object", properties: { completed: { type: "boolean" } }, required: ["completed"], additionalProperties: false },
      }],
    }],
    triggers: [{ id: "manual", type: "manual" }],
  };
}

function conductorOrder(root: string, workflow: WorkflowIr): Record<string, unknown> {
  return {
    id: "live-thesis-conductor",
    workflowId: workflow.definition.id,
    runId: "live-thesis-conductor-run",
    parentAgentId: null,
    depth: 0,
    mission: workflow.mission,
    objective: "Coordinate the deterministic core-thesis fixture.",
    harness: "codex",
    model: "fixture",
    permissions: "full-access",
    outputSchema: { type: "object", additionalProperties: true },
    workspace: { path: root, dirtyPolicy: "local-only" },
    inputs: [],
    metadata: {},
  };
}

async function waitUntilReady(base: string): Promise<void> {
  await waitFor(async () => {
    await expect(fetch(`${base}/health`).then((response) => response.json())).resolves.toMatchObject({ ok: true, status: "ready" });
  });
}

async function waitFor(assertion: () => unknown | Promise<unknown>): Promise<void> {
  await vi.waitFor(assertion, { timeout: 5_000, interval: 25 });
}

async function jsonRequest(base: string, path: string, init: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { response, body };
}

function eventIdsForRun(daemon: Awaited<ReturnType<typeof startDaemon>>, runId: string): string[] {
  return daemon.store.recentEvents({ runId, limit: 1000 }).map((event) => event.id);
}

function objectiveAgentIds(daemon: Awaited<ReturnType<typeof startDaemon>>, runId: string): string[] {
  return daemon.store.listAgents({ runId }).map((agent) => agent.id);
}

function controlAttemptId(snapshot: any, runId: string, nodeId: string): string | null {
  const controlSnapshot = snapshot.plan.controlSnapshot?.runId === runId
    ? snapshot.plan.controlSnapshot
    : snapshot.plan.snapshots.filter((candidate: any) => candidate.runId === runId).at(-1);
  return controlSnapshot?.executions.find((execution: any) => execution.key.nodeId === nodeId && execution.state === "running")?.attemptId ?? null;
}

describe("core thesis live acceptance", () => {
  it("survives client disconnect and daemon restart, CAS-revises a live strategy, and settles a bounded loop with evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-core-thesis-live-"));
    temporary.push(root);
    const port = await availablePort();
    writeConfig(root, port);
    const firstDriver = new LiveAcceptanceDriver();
    const firstRegistry = new DriverRegistry();
    firstRegistry.register(firstDriver);
    const firstDaemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: firstRegistry, secretStore: testSecretStore() });
    const base = `http://127.0.0.1:${port}`;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let secondDaemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      await waitUntilReady(base);
      const workflow = new WorkflowCompiler().compile(workflowDefinition(root), 1);
      firstDaemon.workflows.register(workflow);
      const plan = compileObjectiveControlPlan(workflow);
      const conductor = await firstDaemon.agents.create(conductorOrder(root, workflow));
      await waitFor(() => expect(firstDaemon.store.getAgent(conductor.id)?.status).toBe("running"));

      const stream = await fetch(`${base}/v1/events?projection=ui`);
      expect(stream.status).toBe(200);
      reader = stream.body?.getReader();
      expect(reader).toBeDefined();
      expect((await reader!.read()).done).toBe(false);

      const created = await jsonRequest(base, "/v1/objectives", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "core-thesis-objective" },
        body: JSON.stringify({
          runId: "core-thesis-run",
          objectiveId: "core-thesis-objective",
          workflowId: workflow.definition.id,
          workflowRevision: workflow.revision,
          workflowHash: workflow.hash,
          conductorAgentId: conductor.id,
          workspace: { path: root, dirtyPolicy: "local-only" },
          policy: { budget: {} },
          spec: {
            id: "core-thesis-objective",
            statement: "Keep durable work alive through a disconnected projection and daemon restart.",
            criteria: [],
            approvalPolicy: { mode: "never" },
            maxReplans: 0,
          },
          context: { loop: { continue: true } },
          controlPlan: plan,
        }),
      });
      expect(created.response.status).toBe(201);
      expect(created.body).toMatchObject({ runId: "core-thesis-run", state: "executing" });

      await waitFor(() => expect(firstDriver.startOrders.some((request) => request.workOrder.metadata.objectiveRunId === "core-thesis-run")).toBe(true));
      const firstLoopAgentId = firstDriver.startOrders.find((request) => request.workOrder.metadata.objectiveRunId === "core-thesis-run")!.agentId;
      await waitFor(() => expect(firstDaemon.store.getAgent(firstLoopAgentId)?.status).toBe("running"));
      const firstRunSnapshot = firstDaemon.store.latestObjectiveControlSnapshot("core-thesis-run")!;
      const firstExecution = firstRunSnapshot.executions.find((entry) => entry.key.nodeId === "loop-work" && entry.state === "running")!;
      expect(firstExecution.attemptId).toBeTruthy();

      // A projection fault is a reader cancellation, not a daemon command.
      await reader!.cancel();
      reader = undefined;
      expect(firstDaemon.store.getObjectiveRun("core-thesis-run")?.state).toBe("executing");
      expect(firstDaemon.store.getAgent(firstLoopAgentId)?.status).toBe("running");
      expect(firstDriver.cancelCalls).toBe(0);

      const mutation = {
        type: "insert-node",
        expectedRevision: 0,
        reason: "Conductor adds a durable post-loop marker while native work is running.",
        evidence: { eventCursor: firstDaemon.store.latestCursor(), eventIds: eventIdsForRun(firstDaemon, "core-thesis-run") },
        parentId: "root-control",
        slot: "steps",
        position: 1,
        node: {
          id: "conductor-revision",
          sourceNodeId: "conductor-revision",
          sourcePath: "conductor.revision",
          dependsOn: [],
          label: "Conductor revision",
          type: "set",
          value: { revised: true },
        },
      };
      const authHeaders = {
        "content-type": "application/json",
        "idempotency-key": "core-thesis-strategy-revision",
        "x-symphony-agent-id": conductor.id,
        "x-symphony-agent-token": firstDaemon.agents.tokenFor(conductor.id),
      };
      const revised = await jsonRequest(base, "/v1/objectives/core-thesis-run/strategy", { method: "POST", headers: authHeaders, body: JSON.stringify(mutation) });
      expect(revised.response.status).toBe(200);
      expect(revised.body).toMatchObject({ status: "committed", head: { activeRevision: 1 } });
      const replayed = await jsonRequest(base, "/v1/objectives/core-thesis-run/strategy", { method: "POST", headers: authHeaders, body: JSON.stringify(mutation) });
      expect(replayed.response.status).toBe(200);
      expect(replayed.body).toMatchObject({ status: "replayed", head: { activeRevision: 1 } });
      const staleCas = await jsonRequest(base, "/v1/objectives/core-thesis-run/strategy", {
        method: "POST",
        headers: { ...authHeaders, "idempotency-key": "core-thesis-stale-strategy-revision" },
        body: JSON.stringify({ ...mutation, node: { ...mutation.node, id: "stale-revision" } }),
      });
      expect(staleCas.response.status).toBe(409);
      expect(staleCas.body).toMatchObject({ status: "conflict", currentRevision: 1 });
      expect(firstDaemon.store.listObjectiveControlMutations("core-thesis-run")).toHaveLength(1);

      const frontierBeforeRestart = firstDaemon.store.latestObjectiveControlSnapshot("core-thesis-run")!;
      const headBeforeRestart = firstDaemon.store.getObjectiveControlHead("core-thesis-run")!;
      const attemptBeforeRestart = frontierBeforeRestart.executions.find((entry) => entry.key.nodeId === "loop-work" && entry.state === "running")!;

      const aggregateBeforeRestart = await jsonRequest(base, "/v1/objectives/core-thesis-objective/snapshot", { method: "GET" });
      expect(aggregateBeforeRestart.response.status).toBe(200);
      expect(aggregateBeforeRestart.body).toMatchObject({
        version: 1,
        objective: {
          id: "objective:core-thesis-objective",
          objectiveId: "core-thesis-objective",
          activeRevision: 1,
          latestRunId: "core-thesis-run",
        },
      });
      expect(aggregateBeforeRestart.body.runs.map((run: any) => run.runId)).toEqual(["core-thesis-run"]);
      expect(aggregateBeforeRestart.body.currentRuns.map((run: any) => run.runId)).toEqual(["core-thesis-run"]);
      expect(aggregateBeforeRestart.body.occurrences.map((occurrence: any) => occurrence.runId)).toEqual(["core-thesis-run"]);
      expect(aggregateBeforeRestart.body.plan.head).toMatchObject({ runId: "core-thesis-run", planId: expect.any(String), activeRevision: 1 });
      expect(aggregateBeforeRestart.body.plan.controlSnapshot).toMatchObject({ runId: "core-thesis-run", planRevision: 1, planId: aggregateBeforeRestart.body.plan.head.planId });
      expect(aggregateBeforeRestart.body.events.every((event: any) => event.runId === "core-thesis-run" && event.cursor <= aggregateBeforeRestart.body.eventCursor)).toBe(true);
      const aggregateAttemptBeforeRestart = controlAttemptId(aggregateBeforeRestart.body, "core-thesis-run", "loop-work");
      expect(aggregateAttemptBeforeRestart).toBe(attemptBeforeRestart.attemptId);

      const cursorBeforeRestart = firstDaemon.store.latestCursor();
      await firstDaemon.close();

      const secondDriver = new LiveAcceptanceDriver();
      const secondRegistry = new DriverRegistry();
      secondRegistry.register(secondDriver);
      secondDaemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: secondRegistry, secretStore: testSecretStore() });
      await waitUntilReady(base);
      await waitFor(() => expect(secondDriver.resumedAgentIds).toEqual(expect.arrayContaining([conductor.id, firstLoopAgentId])));
      expect(secondDriver.startedAgentIds).toEqual([]);
      expect(secondDaemon.store.getObjectiveRun("core-thesis-run")).toMatchObject({ state: "executing", activePlanRevision: 0 });
      expect(secondDaemon.store.getObjectiveControlHead("core-thesis-run")).toMatchObject({ activeRevision: headBeforeRestart.activeRevision });
      const frontierAfterRestart = secondDaemon.store.latestObjectiveControlSnapshot("core-thesis-run")!;
      expect(frontierAfterRestart).toMatchObject({
        planRevision: frontierBeforeRestart.planRevision,
        frontier: frontierBeforeRestart.frontier,
      });
      expect(frontierAfterRestart.executions.find((entry) => entry.key.nodeId === "loop-work" && entry.state === "running")?.attemptId).toBe(attemptBeforeRestart.attemptId);
      expect(secondDaemon.store.latestCursor()).toBeGreaterThanOrEqual(cursorBeforeRestart);

      const aggregateAfterRestart = await jsonRequest(base, "/v1/objectives/core-thesis-objective/snapshot", { method: "GET" });
      expect(aggregateAfterRestart.response.status).toBe(200);
      expect(aggregateAfterRestart.body.eventCursor).toBeGreaterThanOrEqual(aggregateBeforeRestart.body.eventCursor);
      expect(aggregateAfterRestart.body.events.every((event: any) => event.runId === "core-thesis-run" && event.cursor <= aggregateAfterRestart.body.eventCursor)).toBe(true);
      expect(aggregateAfterRestart.body.objective).toMatchObject({
        id: aggregateBeforeRestart.body.objective.id,
        objectiveId: aggregateBeforeRestart.body.objective.objectiveId,
        activeRevision: aggregateBeforeRestart.body.objective.activeRevision,
        latestRunId: aggregateBeforeRestart.body.objective.latestRunId,
      });
      expect(aggregateAfterRestart.body.runs.map((run: any) => run.runId)).toEqual(aggregateBeforeRestart.body.runs.map((run: any) => run.runId));
      expect(aggregateAfterRestart.body.occurrences.map((occurrence: any) => ({ id: occurrence.id, runId: occurrence.runId, objectiveRevision: occurrence.objectiveRevision }))).toEqual(
        aggregateBeforeRestart.body.occurrences.map((occurrence: any) => ({ id: occurrence.id, runId: occurrence.runId, objectiveRevision: occurrence.objectiveRevision })),
      );
      expect(aggregateAfterRestart.body.revisions.map((revision: any) => ({ id: revision.id, revision: revision.revision }))).toEqual(
        aggregateBeforeRestart.body.revisions.map((revision: any) => ({ id: revision.id, revision: revision.revision })),
      );
      expect(aggregateAfterRestart.body.plan.head).toMatchObject({
        runId: aggregateBeforeRestart.body.plan.head.runId,
        planId: aggregateBeforeRestart.body.plan.head.planId,
        activeRevision: aggregateBeforeRestart.body.plan.head.activeRevision,
      });
      expect(aggregateAfterRestart.body.plan.controlSnapshot).toMatchObject({
        runId: aggregateBeforeRestart.body.plan.controlSnapshot.runId,
        planId: aggregateBeforeRestart.body.plan.controlSnapshot.planId,
        planRevision: aggregateBeforeRestart.body.plan.controlSnapshot.planRevision,
      });
      expect(aggregateAfterRestart.body.plan.revisions.map((revision: any) => ({ planId: revision.planId, runId: revision.runId, revision: revision.revision }))).toEqual(
        aggregateBeforeRestart.body.plan.revisions.map((revision: any) => ({ planId: revision.planId, runId: revision.runId, revision: revision.revision })),
      );
      expect(controlAttemptId(aggregateAfterRestart.body, "core-thesis-run", "loop-work")).toBe(aggregateAttemptBeforeRestart);
      expect(aggregateAfterRestart.body.events.some((event: any) => event.runId !== "core-thesis-run")).toBe(false);

      secondDriver.release(firstLoopAgentId, "completed");
      await waitFor(() => expect(secondDriver.startedAgentIds.length).toBe(1));
      const secondLoopAgentId = secondDriver.startedAgentIds[0]!;
      expect(secondLoopAgentId).not.toBe(firstLoopAgentId);
      await waitFor(() => expect(secondDaemon!.store.getAgent(secondLoopAgentId)?.status).toBe("running"));
      secondDriver.release(secondLoopAgentId, "completed");
      await waitFor(() => expect(secondDaemon!.store.getObjectiveRun("core-thesis-run")?.state).toBe("succeeded"));

      const finalSnapshot = secondDaemon.store.latestObjectiveControlSnapshot("core-thesis-run")!;
      const loopExecutions = finalSnapshot.executions.filter((entry) => entry.key.nodeId === "loop-work");
      expect(loopExecutions).toHaveLength(2);
      expect(loopExecutions.every((entry) => entry.state === "completed" && entry.attemptId)).toBe(true);
      const whileExecutionId = Object.keys(finalSnapshot.loopIterations)[0]!;
      expect(finalSnapshot.loopIterations[whileExecutionId]).toBe(2);
      expect(finalSnapshot.exitReasons[whileExecutionId]).toBe("bound-reached");
      expect(finalSnapshot.executions.find((entry) => entry.key.nodeId === "conductor-revision")?.output).toEqual({ revised: true });

      const evidenceCursor = secondDaemon.store.latestCursor();
      const artifact = await jsonRequest(base, "/v1/objectives/core-thesis-run/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "core-thesis-artifact" },
        body: JSON.stringify({
          version: 1,
          // Artifact publication currently fences against the legacy flat
          // objective plan revision. The control strategy has its own CAS
          // revision, asserted separately below.
          planRevision: 0,
          kind: "acceptance.evidence",
          name: "core-thesis.json",
          mediaType: "application/json",
          content: { runId: "core-thesis-run", state: "succeeded", iterations: 2, revised: true },
          evidence: { eventCursor: evidenceCursor, eventIds: eventIdsForRun(secondDaemon, "core-thesis-run"), observationIds: [] },
          taskId: null,
          attemptId: null,
          controlNodeId: "conductor-revision",
          lineage: [],
          policyHash: secondDaemon.store.getObjectiveRun("core-thesis-run")?.policyHash,
        }),
      });
      expect(artifact.response.status).toBe(201);
      const artifacts = await jsonRequest(base, "/v1/objectives/core-thesis-run/artifacts", { method: "GET" });
      expect(artifacts.response.status).toBe(200);
      expect(artifacts.body.artifacts).toHaveLength(1);
      expect(artifacts.body.artifacts[0]).toMatchObject({ name: "core-thesis.json", planRevision: 0, content: { iterations: 2, revised: true } });

      // These are intentionally separate, run-scoped projections. The
      // legacy objective record keeps its flat-plan revision at zero while
      // the strategy endpoint exposes the independently durable control CAS
      // head at revision one; the browser must not present this pair as an
      // atomic aggregate unless a future aggregate endpoint supplies one.
      const detail = await jsonRequest(base, "/v1/objectives/core-thesis-run", { method: "GET" });
      const control = await jsonRequest(base, "/v1/objectives/core-thesis-run/strategy", { method: "GET" });
      expect(detail.response.status).toBe(200);
      expect(control.response.status).toBe(200);
      expect(detail.body.run.runId).toBe(control.body.runId);
      expect(detail.body.run.activePlanRevision).toBe(0);
      expect(control.body.head.activeRevision).toBe(1);
      expect(detail.body.eventCursor).toBeGreaterThan(0);

      const runEvents = secondDaemon.store.recentEvents({ runId: "core-thesis-run", limit: 1000 });
      expect(runEvents.map((event) => event.type)).toEqual(expect.arrayContaining([
        "objective.created",
        "objective.control-plan.changed",
        "objective.control.acknowledged",
        "driver.usage.recorded",
        "driver.run.completed",
        "objective.artifact.published",
      ]));
      const usage = secondDaemon.store.listUsage({ runId: "core-thesis-run" });
      expect(usage).toHaveLength(2);
      expect(usage.every((event) => event.objectiveAttemptId && event.inputTokens === 7 && event.outputTokens === 4)).toBe(true);
      expect(secondDaemon.store.getObjectiveBudgetLedger("core-thesis-run")).not.toBeNull();
      expect(secondDaemon.store.listAgents({ runId: "core-thesis-run" }).map((agent) => agent.logicalAgentId)).toHaveLength(2);
      expect(objectiveAgentIds(secondDaemon, "core-thesis-run")).toEqual(expect.arrayContaining([firstLoopAgentId, secondLoopAgentId]));

      // The supervisor has no attention record on this successful path; the
      // separate fault case below proves that unknown delivery does create one.
      const attentionEvents = runEvents.filter((event) => event.type === "objective.supervisor.attention");
      expect(attentionEvents).toHaveLength(0);
    } finally {
      if (reader) await reader.cancel();
      if (secondDaemon) await secondDaemon.close();
      else await firstDaemon.close();
    }
  }, 30_000);

  it("fails closed for unknown native delivery and records attention, while a known failure settles as failed", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-core-thesis-delivery-"));
    temporary.push(root);
    const port = await availablePort();
    writeConfig(root, port);
    const driver = new LiveAcceptanceDriver();
    const registry = new DriverRegistry();
    registry.register(driver);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: registry, secretStore: testSecretStore() });
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitUntilReady(base);
      const unknownWorkflow = new WorkflowCompiler().compile(workflowDefinition(root, "delivery-unknown-workflow"), 1);
      const failedWorkflow = new WorkflowCompiler().compile(workflowDefinition(root, "delivery-failed-workflow"), 1);
      daemon.workflows.register(unknownWorkflow);
      daemon.workflows.register(failedWorkflow);
      const unknownConductor = await daemon.agents.create(conductorOrder(root, unknownWorkflow));
      const failedConductor = await daemon.agents.create({ ...conductorOrder(root, failedWorkflow), id: "live-thesis-failed-conductor", runId: "live-thesis-failed-conductor-run" });
      await waitFor(() => expect(daemon.store.getAgent(unknownConductor.id)?.status).toBe("running"));
      await waitFor(() => expect(daemon.store.getAgent(failedConductor.id)?.status).toBe("running"));
      const unknownPlan = compileObjectiveControlPlan(unknownWorkflow);
      const failedPlan = compileObjectiveControlPlan(failedWorkflow);
      const create = async (runId: string, objectiveId: string, workflow: WorkflowIr, conductor: { id: string }, plan: ReturnType<typeof compileObjectiveControlPlan>) => jsonRequest(base, "/v1/objectives", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `create:${runId}` },
        body: JSON.stringify({
          runId,
          objectiveId,
          workflowId: workflow.definition.id,
          workflowRevision: workflow.revision,
          workflowHash: workflow.hash,
          conductorAgentId: conductor.id,
          workspace: { path: root, dirtyPolicy: "local-only" },
          spec: { id: objectiveId, statement: "Delivery result must be truthful.", criteria: [], approvalPolicy: { mode: "never" }, maxReplans: 0 },
          context: { loop: { continue: true } },
          controlPlan: plan,
        }),
      });

      const unknown = await create("unknown-delivery-run", "unknown-delivery-objective", unknownWorkflow, unknownConductor, unknownPlan);
      expect(unknown.response.status).toBe(201);
      await waitFor(() => expect(driver.startOrders.filter((request) => request.workOrder.metadata.objectiveRunId === "unknown-delivery-run")).toHaveLength(1));
      const unknownAgent = driver.startOrders.find((request) => request.workOrder.metadata.objectiveRunId === "unknown-delivery-run")!.agentId;
      driver.release(unknownAgent, "unknown");
      await waitFor(() => expect(daemon.store.recentEvents({ runId: "unknown-delivery-run", types: ["objective.supervisor.attention"], limit: 10 })).not.toHaveLength(0));
      expect(daemon.store.getObjectiveRun("unknown-delivery-run")?.state).toBe("executing");
      expect(daemon.store.getAgent(unknownAgent)?.status).toBe("cancelled");
      expect(daemon.store.recentEvents({ runId: "unknown-delivery-run", types: ["objective.supervisor.attention"], limit: 10 })[0]?.payload).toMatchObject({ detail: expect.stringContaining("inconclusive") });
      expect(daemon.store.recentEvents({ runId: "unknown-delivery-run", types: ["objective.run.succeeded"], limit: 10 })).toHaveLength(0);

      const failed = await create("failed-delivery-run", "failed-delivery-objective", failedWorkflow, failedConductor, failedPlan);
      expect(failed.response.status).toBe(201);
      await waitFor(() => expect(driver.startOrders.filter((request) => request.workOrder.metadata.objectiveRunId === "failed-delivery-run")).toHaveLength(1));
      const failedAgent = driver.startOrders.find((request) => request.workOrder.metadata.objectiveRunId === "failed-delivery-run")!.agentId;
      driver.release(failedAgent, "failed");
      await waitFor(() => expect(daemon.store.getObjectiveRun("failed-delivery-run")?.state).toBe("failed"));
      expect(daemon.store.recentEvents({ runId: "failed-delivery-run", types: ["driver.run.failed", "agent.failed"], limit: 10 }).map((event) => event.type)).toEqual(expect.arrayContaining(["driver.run.failed", "agent.failed"]));
      const failedSnapshot = daemon.store.getObjectiveControlSnapshot("failed-delivery-run", daemon.store.getObjectiveControlHead("failed-delivery-run")!.latestSnapshotSequence)!;
      expect(failedSnapshot.executions.find((entry) => entry.key.nodeId === "root-control")?.state).toBe("failed");
      expect(daemon.store.recentEvents({ runId: "failed-delivery-run", types: ["objective.run.succeeded"], limit: 10 })).toHaveLength(0);
    } finally {
      await daemon.close();
    }
  }, 30_000);
});
