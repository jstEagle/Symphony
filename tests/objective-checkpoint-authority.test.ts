import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, type SymphonyDaemon } from "../apps/daemon/src/index.js";
import { SecretStore } from "../packages/config/src/index.js";
import {
  AgentRecordSchema,
  ObjectiveRunRecordSchema,
  nowIso,
  type AgentRecord,
  type ObjectiveRunRecord,
} from "../packages/protocol/src/index.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { TEST_DAEMON_SECRET } from "./setup.js";

const temporary: string[] = [];
const daemons: SymphonyDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
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

function writeTestConfig(root: string, port: number): void {
  writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
    dataDirectory: ".symphony",
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
    conductor: { harness: "codex", model: "fixture" },
    agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access" },
    harnesses: {
      codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
      opencode: { enabled: false }, pi: { enabled: false }, acp: [],
    },
    router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
    observer: { provider: "deterministic" },
    plugins: { watch: false },
    workflows: { triggersEnabled: false },
  }));
}

function secretStore(): SecretStore {
  return new SecretStore("dev.symphony.objective-checkpoint-authority-test", {
    platform: "linux",
    environment: { SYMPHONY_DAEMON_SECRET: TEST_DAEMON_SECRET },
    nativeBackend: null,
  });
}

async function makeFixture(): Promise<{ daemon: SymphonyDaemon; base: string; run: ObjectiveRunRecord; eventCursor: () => number }> {
  const root = mkdtempSync(join(tmpdir(), "symphony-objective-checkpoint-authority-"));
  temporary.push(root);
  const port = await availablePort();
  writeTestConfig(root, port);
  const daemon = await startDaemon({
    rootDirectory: root,
    noPlugins: true,
    driverRegistry: new DriverRegistry(),
    secretStore: secretStore(),
    credentialPlatform: "linux",
  });
  // Keep this API-focused fixture from racing the public request with the
  // internal event-driven supervisor; runner reconciliation is covered by its
  // own integration contract tests.
  await daemon.objectiveSupervisor.stop();
  daemons.push(daemon);

  const timestamp = nowIso();
  const conductor = agent(daemon, {
    id: "checkpoint-conductor",
    logicalAgentId: "checkpoint-conductor",
    // Chat conductors and objective runs are separate durable resources.
    runId: "checkpoint-chat-run",
    parentAgentId: null,
    depth: 0,
    status: "running",
  });
  const worker = agent(daemon, {
    id: "checkpoint-worker",
    logicalAgentId: "checkpoint-attempt",
    runId: "checkpoint-run",
    parentAgentId: conductor.id,
    depth: 1,
    status: "running",
  });
  daemon.store.saveAgent(conductor);
  daemon.store.saveAgent(worker);
  const run = ObjectiveRunRecordSchema.parse({
    version: 1,
    runId: "checkpoint-run",
    objectiveId: "checkpoint-objective",
    workflowId: "checkpoint-workflow",
    workflowRevision: 1,
    workflowHash: "checkpoint-workflow-hash",
    conductorAgentId: conductor.id,
    spec: {
      id: "checkpoint-objective",
      statement: "Prove terminal checkpoint authority.",
      criteria: [],
      approvalPolicy: { mode: "never" },
      maxReplans: 0,
    },
    state: "executing",
    activePlanRevision: 1,
    latestCheckpointId: null,
    pendingApprovalId: null,
    replanCount: 0,
    tasks: [{
      task: {
        id: "build",
        objective: "Build the fixture",
        dependsOn: [],
        outputSchema: {},
        model: "fixture",
        harness: "auto",
        inputs: [],
        requiresApproval: false,
      },
      state: "running",
      attemptId: "checkpoint-attempt",
      agentId: worker.id,
      output: null,
      error: null,
      startedAt: timestamp,
      finishedAt: null,
    }],
    context: {},
    output: null,
    error: null,
    requestKey: "checkpoint-create-request",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: null,
  });
  daemon.store.saveObjectiveRun(run);
  return { daemon, base: `http://127.0.0.1:${port}`, run, eventCursor: () => daemon.store.latestCursor() };
}

function agent(daemon: SymphonyDaemon, input: {
  id: string;
  logicalAgentId: string;
  runId: string;
  parentAgentId: string | null;
  depth: number;
  status: AgentRecord["status"];
}): AgentRecord {
  const timestamp = nowIso();
  return AgentRecordSchema.parse({
    ...input,
    workflowId: "checkpoint-workflow",
    objective: "Checkpoint authority fixture",
    missionHash: "checkpoint-mission-hash",
    requestedHarness: "codex",
    requestedModel: "fixture",
    harness: "codex",
    model: "fixture",
    permissions: "full-access",
    nativeSessionId: null,
    nativeRunId: null,
    workspacePath: daemon.loaded.rootDirectory,
    output: input.status === "completed" ? { ok: true } : null,
    error: input.status === "failed" ? "fixture failure" : null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: input.status === "running" ? null : timestamp,
  });
}

function checkpointHeaders(requestKey: string): Record<string, string> {
  return { "content-type": "application/json", "idempotency-key": requestKey };
}

async function checkpoint(
  base: string,
  runId: string,
  requestKey: string,
  eventCursor: number,
  taskUpdate: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${base}/v1/objectives/${runId}/checkpoints`, {
    method: "POST",
    headers: { ...checkpointHeaders(requestKey), ...extraHeaders },
    body: JSON.stringify({ eventCursor, taskUpdates: [taskUpdate], reason: "Fixture checkpoint." }),
  });
}

function terminalEvent(fixture: Awaited<ReturnType<typeof makeFixture>>, type: "completed" | "failed") {
  const worker = fixture.daemon.store.getAgent("checkpoint-worker");
  if (!worker) throw new Error("checkpoint worker missing");
  const timestamp = nowIso();
  fixture.daemon.store.saveAgent({
    ...worker,
    status: type,
    output: type === "completed" ? { ok: true } : null,
    error: type === "failed" ? "fixture failure" : null,
    updatedAt: timestamp,
    finishedAt: timestamp,
  });
  return fixture.daemon.store.appendEvent({
    type: type === "completed" ? "agent.completed" : "agent.failed",
    workflowId: fixture.run.workflowId,
    runId: fixture.run.runId,
    agentId: worker.id,
    occurredAt: timestamp,
    payload: { objectiveAttemptId: "checkpoint-attempt" },
    provenance: { source: "daemon" },
  });
}

describe("objective checkpoint terminal authority", () => {
  it("rejects a forged success even when the body names the current assignment", async () => {
    const fixture = await makeFixture();
    const response = await checkpoint(fixture.base, fixture.run.runId, "checkpoint-forged-success", fixture.eventCursor(), {
      taskId: "build", state: "completed", attemptId: "checkpoint-attempt", agentId: "checkpoint-worker",
    });
    expect(response.status).toBe(409);
    expect(fixture.daemon.store.getObjectiveRun(fixture.run.runId)?.tasks[0]?.state).toBe("running");
  });

  it("rejects a terminal update with a wrong attempt identity", async () => {
    const fixture = await makeFixture();
    const event = terminalEvent(fixture, "completed");
    const response = await checkpoint(fixture.base, fixture.run.runId, "checkpoint-wrong-attempt", event.cursor, {
      taskId: "build", state: "completed", attemptId: "forged-attempt", agentId: "checkpoint-worker",
    });
    expect(response.status).toBe(403);
    expect(fixture.daemon.store.getObjectiveRun(fixture.run.runId)?.tasks[0]?.state).toBe("running");
  });

  it("rejects a terminal update with a wrong agent identity", async () => {
    const fixture = await makeFixture();
    const event = terminalEvent(fixture, "completed");
    const response = await checkpoint(fixture.base, fixture.run.runId, "checkpoint-wrong-agent", event.cursor, {
      taskId: "build", state: "completed", attemptId: "checkpoint-attempt", agentId: "forged-agent",
    });
    expect(response.status).toBe(403);
    expect(fixture.daemon.store.getObjectiveRun(fixture.run.runId)?.tasks[0]?.state).toBe("running");
  });

  it("rejects a future cursor even when terminal evidence is durable", async () => {
    const fixture = await makeFixture();
    terminalEvent(fixture, "completed");
    const response = await checkpoint(fixture.base, fixture.run.runId, "checkpoint-future-cursor", fixture.eventCursor() + 1, {
      taskId: "build", state: "completed", attemptId: "checkpoint-attempt", agentId: "checkpoint-worker",
    });
    expect(response.status).toBe(409);
  });

  it("accepts a valid terminal reconciliation when the conductor chat run differs", async () => {
    const fixture = await makeFixture();
    expect(fixture.daemon.store.getAgent(fixture.run.conductorAgentId as string)?.runId).not.toBe(fixture.run.runId);
    const event = terminalEvent(fixture, "completed");
    const response = await checkpoint(fixture.base, fixture.run.runId, "checkpoint-valid-terminal", event.cursor, {
      taskId: "build", state: "completed", attemptId: "checkpoint-attempt", agentId: "checkpoint-worker",
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { state: string; context: unknown }).toMatchObject({
      state: "succeeded",
      context: { evidence: { eventCursor: event.cursor, eventIds: [event.id] } },
    });
    const checkpointEvent = fixture.daemon.store.recentEvents({ runId: fixture.run.runId, types: ["objective.checkpoint.committed"], limit: 1 })[0];
    expect(checkpointEvent?.payload).toMatchObject({ evidenceEventIds: [event.id], evidenceByTask: { build: [event.id] } });
  });

  it("denies a checkpoint from an authenticated agent in another root", async () => {
    const fixture = await makeFixture();
    const foreign = agent(fixture.daemon, {
      id: "checkpoint-foreign",
      logicalAgentId: "checkpoint-foreign",
      runId: "foreign-run",
      parentAgentId: null,
      depth: 0,
      status: "running",
    });
    fixture.daemon.store.saveAgent(foreign);
    const response = await checkpoint(fixture.base, fixture.run.runId, "checkpoint-cross-root", fixture.eventCursor(), {
      taskId: "build", state: "running", attemptId: "checkpoint-attempt", agentId: "checkpoint-worker",
    }, {
      "x-symphony-agent-id": foreign.id,
      "x-symphony-agent-token": fixture.daemon.agents.tokenFor(foreign.id),
    });
    expect(response.status).toBe(403);
  });
});
