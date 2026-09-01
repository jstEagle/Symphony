import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { capabilities, emit, makeSession } from "../packages/drivers/src/common.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { ConversationMessageSchema, nowIso } from "../packages/protocol/src/index.js";
import { createStore } from "../packages/storage/src/index.js";
import { WorkflowCompiler } from "../packages/workflow/src/index.js";
import { TEST_DAEMON_SECRET } from "./setup.js";
import type {
  DriverDoctorResult,
  DriverEvent,
  DriverSession,
  DriverStartRequest,
  ModelDescriptor,
  WorkerDriver,
} from "../packages/protocol/src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

class ControlledDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities();
  readonly started: Promise<void>;
  cancelCalls = 0;
  authenticationCalls = 0;
  forceTerminateCalls = 0;
  messageCalls = 0;
  startCalls = 0;
  readonly startRequests: DriverStartRequest[] = [];
  private resolveStarted!: () => void;
  private eventConsumer: ((event: DriverEvent) => void) | null = null;

  constructor() {
    this.started = new Promise<void>((resolvePromise) => {
      this.resolveStarted = resolvePromise;
    });
  }

  async doctor(): Promise<DriverDoctorResult> {
    return {
      driver: this.id,
      available: true,
      authenticated: true,
      version: "fixture",
      capabilities: this.capabilities,
      detail: "Controlled durability fixture",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{
      id: "fixture",
      harness: this.id,
      name: "Fixture",
      description: "Controlled durability fixture",
      modalities: ["text"],
      structuredOutput: false,
      pricing: {},
      metadata: {},
    }];
  }

  async authenticate() {
    this.authenticationCalls += 1;
    return { authenticated: true, detail: "Controlled driver authenticated." };
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.startCalls += 1;
    this.startRequests.push(request);
    this.eventConsumer = onEvent;
    emit(onEvent, "run.started", { agentId: request.agentId });
    emit(onEvent, "message.delta", { text: "Still working.", messageId: "durability-fixture" });
    this.resolveStarted();
    return makeSession(this.id, `native-${request.agentId}`);
  }

  async resume(session: DriverSession): Promise<DriverSession> {
    return session;
  }

  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> {
    this.messageCalls += 1;
    return { receiptId: "fixture-receipt", queued: false };
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
  }

  async forceTerminate(): Promise<void> {
    this.forceTerminateCalls += 1;
  }

  complete(): void {
    if (!this.eventConsumer) throw new Error("Controlled driver has not started");
    emit(this.eventConsumer, "output.completed", { text: "Completed after the client reloaded." });
    emit(this.eventConsumer, "run.completed", { status: "finished" });
  }
}

class AuthenticationRequiredDriver extends ControlledDriver {
  override async doctor(): Promise<DriverDoctorResult> {
    return {
      ...await super.doctor(),
      authenticated: this.authenticationCalls > 0,
    };
  }
}

class BlockingRecoveryDriver extends ControlledDriver {
  readonly resumeStarted: Promise<void>;
  private releaseRecovery!: () => void;
  private markResumeStarted!: () => void;

  constructor() {
    super();
    this.resumeStarted = new Promise<void>((resolvePromise) => {
      this.markResumeStarted = resolvePromise;
    });
  }

  override async resume(session: DriverSession): Promise<DriverSession> {
    this.markResumeStarted();
    await new Promise<void>((resolvePromise) => {
      this.releaseRecovery = resolvePromise;
    });
    return { ...session, state: "running" };
  }

  releaseResume(): void {
    this.releaseRecovery();
  }
}

describe("local daemon API", () => {
  it("serves the durable control plane while native session recovery is still in progress", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-recovery-control-plane-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      conductor: { harness: "codex", model: "fixture" },
      agents: {
        maxDepth: null,
        maxConcurrent: null,
        defaultPermissions: "full-access",
        recoveryTimeoutMs: 5_000,
      },
      harnesses: {
        codex: { enabled: true }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    const seeded = createStore(join(root, ".symphony"));
    const timestamp = nowIso();
    const agentId = "recovering-control-plane-agent";
    const workOrder = {
      id: "recovering-control-plane-logical-agent",
      workflowId: "recovering-control-plane-workflow",
      runId: "recovering-control-plane-run",
      parentAgentId: null,
      depth: 0,
      mission: {
        id: "recovering-control-plane-workflow",
        revision: 1,
        hash: "12345678",
        statement: "Keep the coordination control plane available during recovery.",
        keyResults: [],
      },
      objective: "Resume native work while Symphony remains observable.",
      harness: "codex",
      model: "fixture",
      permissions: "full-access",
      outputSchema: {},
      workspace: { path: root, dirtyPolicy: "local-only" },
      inputs: [],
      metadata: {},
    };
    seeded.saveAgent({
      id: agentId,
      logicalAgentId: workOrder.id,
      workflowId: workOrder.workflowId,
      runId: workOrder.runId,
      parentAgentId: null,
      depth: 0,
      objective: workOrder.objective,
      missionHash: workOrder.mission.hash,
      requestedHarness: "codex",
      requestedModel: "fixture",
      harness: "codex",
      model: "fixture",
      permissions: "full-access",
      status: "running",
      nativeSessionId: `native-${agentId}`,
      nativeRunId: `native-run-${agentId}`,
      workspacePath: root,
      output: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      finishedAt: null,
    });
    seeded.setMetadata(`work-order:${agentId}`, workOrder as never);
    seeded.setMetadata(`driver-session:${agentId}`, {
      driver: "codex",
      nativeSessionId: `native-${agentId}`,
      nativeRunId: `native-run-${agentId}`,
      state: "running",
      startedAt: timestamp,
      metadata: { agentId },
    });
    seeded.close();

    const driver = new BlockingRecoveryDriver();
    const driverRegistry = new DriverRegistry();
    driverRegistry.register(driver);
    const starting = startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry });
    await driver.resumeStarted;

    const base = `http://127.0.0.1:${port}`;
    const recoveringHealth = await fetch(`${base}/health`).then((response) => response.json()) as { ok: boolean; status: string };
    expect(recoveringHealth).toMatchObject({ ok: false, status: "recovering" });
    const bootstrapResponse = await fetch(`${base}/v1/bootstrap`);
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = await bootstrapResponse.json() as { agents: Array<{ id: string; status: string }> };
    expect(bootstrap.agents).toContainEqual(expect.objectContaining({ id: agentId, status: "running" }));

    driver.releaseResume();
    const daemon = await starting;
    try {
      await expect(fetch(`${base}/health`).then((response) => response.json())).resolves.toMatchObject({ ok: true, status: "ready" });
    } finally {
      await daemon.close();
    }
  });

  it("becomes ready while a recovered workflow continues in the background", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-workflow-readiness-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      conductor: { harness: "codex", model: "fixture" },
      agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access" },
      harnesses: {
        codex: { enabled: true }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    const ir = new WorkflowCompiler().compile({
      id: "ready-during-recovery",
      name: "Ready during recovery",
      mission: { statement: "Keep durable work observable during restart.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" },
      output: "steps.long-work",
      steps: [{
        id: "long-work",
        type: "agent",
        objective: "Continue this long-running recovered workflow.",
        harness: "codex",
        model: "fixture",
        outputSchema: { type: "object", properties: {}, additionalProperties: true },
      }],
    }, 1);
    const seeded = createStore(join(root, ".symphony"));
    seeded.saveWorkflow({
      id: ir.definition.id,
      revision: ir.revision,
      mission: ir.mission as never,
      definition: ir.definition as never,
      ir: ir as never,
      hash: ir.hash,
      createdAt: nowIso(),
    });
    seeded.saveRun({
      id: "ready-during-recovery-run",
      workflowId: ir.definition.id,
      workflowRevision: ir.revision,
      status: "running",
      input: {},
      output: null,
      error: null,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      finishedAt: null,
      cancelRequested: false,
      origin: {
        kind: "user",
        threadId: null,
        parentRunId: null,
        parentAgentId: null,
        baseDepth: -1,
        permissionCeiling: "full-access",
      },
    });
    seeded.close();

    const driver = new ControlledDriver();
    const driverRegistry = new DriverRegistry();
    driverRegistry.register(driver);
    const daemon = await Promise.race([
      startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Daemon readiness waited for workflow completion")), 500)),
    ]);
    try {
      const base = `http://127.0.0.1:${port}`;
      await expect(fetch(`${base}/health`).then((response) => response.json())).resolves.toMatchObject({ ok: true, status: "ready" });
      await driver.started;
      await expect.poll(() => daemon.store.listAgents({ runId: "ready-during-recovery-run" })).toHaveLength(1);
      await expect.poll(() => daemon.store.listAgents({ runId: "ready-during-recovery-run" })[0]?.status).toBe("running");
      const bootstrap = await fetch(`${base}/v1/bootstrap`).then((response) => response.json()) as {
        runs: Array<{ id: string; status: string }>;
        agents: Array<{ runId: string; status: string }>;
      };
      expect(bootstrap.runs).toContainEqual(expect.objectContaining({ id: "ready-during-recovery-run", status: "running" }));
      expect(bootstrap.agents).toContainEqual(expect.objectContaining({ runId: "ready-during-recovery-run", status: "running" }));

      driver.complete();
      await expect.poll(() => daemon.store.getRun("ready-during-recovery-run")).toMatchObject({ status: "completed" });
      expect(daemon.store.listAgents({ runId: "ready-during-recovery-run" })).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  });

  it("runs a documented driver authentication action and refreshes the runtime catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-driver-auth-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      conductor: { harness: "codex", model: "fixture" },
      agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access" },
      harnesses: {
        codex: { enabled: true }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    const driver = new AuthenticationRequiredDriver();
    const driverRegistry = new DriverRegistry();
    driverRegistry.register(driver);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/drivers/codex/authenticate`, {
        method: "POST",
        headers: { "idempotency-key": "daemon-driver-authentication-action" },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ authenticated: true, detail: "Controlled driver authenticated." });
      expect(driver.authenticationCalls).toBe(1);
      const store = createStore(join(root, ".symphony"));
      try {
        expect(store.eventsAfter(0).some((event) => event.type === "driver.authenticated")).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      await daemon.close();
    }
  });

  it("keeps an in-flight agent running when an SSE client disconnects and reloads state", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-durability-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      conductor: { harness: "codex", model: "fixture" },
      agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access" },
      harnesses: {
        codex: { enabled: true }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    const driver = new ControlledDriver();
    const driverRegistry = new DriverRegistry();
    driverRegistry.register(driver);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry });
    try {
      const base = `http://127.0.0.1:${port}`;
      const events = await fetch(`${base}/v1/events?projection=ui`);
      expect(events.status).toBe(200);
      const eventReader = events.body?.getReader();
      expect(eventReader).toBeDefined();
      expect((await eventReader!.read()).done).toBe(false);

      const thread = await fetch(`${base}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "test-thread-durable-run" },
        body: JSON.stringify({ title: "Durable run" }),
      }).then((response) => response.json()) as { id: string };
      const accepted = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: "durable-chat-turn-1", content: "Keep working while I reload." }),
      }).then((response) => response.json()) as { agentId: string; messageId: string };
      expect(daemon.store.eventsAfter(0, { types: ["chat.message.updated"] })).toContainEqual(
        expect.objectContaining({
          provenance: { source: "user" },
          payload: expect.objectContaining({ messageId: accepted.messageId }),
        }),
      );
      const duplicateAccepted = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: "durable-chat-turn-1", content: "Keep working while I reload." }),
      }).then((response) => response.json()) as typeof accepted;
      expect(duplicateAccepted).toEqual(accepted);
      await driver.started;
      expect(driver.startCalls).toBe(1);
      await expect.poll(() => daemon.store.getAgent(accepted.agentId)?.status).toBe("running");

      const presented = await fetch(`${base}/v1/agents/${accepted.agentId}/present`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "daemon:present-ui:1",
          "x-symphony-agent-id": accepted.agentId,
          "x-symphony-agent-token": daemon.agents.tokenFor(accepted.agentId),
        },
        body: JSON.stringify({
          kind: "subagent-list",
          data: { agents: [{ agentId: accepted.agentId, name: "Durable conductor", state: "running" }] },
        }),
      }).then((response) => response.json()) as { messageId: string; threadId: string };
      expect(presented.threadId).toBe(thread.id);
      const duplicatePresented = await fetch(`${base}/v1/agents/${accepted.agentId}/present`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "daemon:present-ui:1",
          "x-symphony-agent-id": accepted.agentId,
          "x-symphony-agent-token": daemon.agents.tokenFor(accepted.agentId),
        },
        body: JSON.stringify({
          kind: "subagent-list",
          data: { agents: [{ agentId: accepted.agentId, name: "Durable conductor", state: "running" }] },
        }),
      }).then((response) => response.json()) as typeof presented;
      expect(duplicatePresented).toEqual(presented);
      const presentedFrame = await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          let text = "";
          while (!text.includes(presented.messageId) || !text.includes('"name":"subagent-list"')) {
            const chunk = await eventReader!.read();
            if (chunk.done) break;
            text += decoder.decode(chunk.value, { stream: true });
          }
          return text;
        })(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Presented UI was not delivered live")), 500)),
      ]);
      expect(presentedFrame).toContain("event: chat.message.updated");
      expect((presentedFrame.match(new RegExp(presented.messageId, "gu")) ?? []).length).toBeGreaterThanOrEqual(1);
      const presentedThread = await fetch(`${base}/v1/threads/${thread.id}`).then((response) => response.json()) as {
        messages: Array<{ id: string }>;
      };
      expect(presentedThread.messages.filter((message) => message.id === presented.messageId)).toHaveLength(1);

      await eventReader!.cancel();
      const reloaded = await fetch(`${base}/v1/bootstrap`).then((response) => response.json()) as {
        agents: Array<{ id: string; status: string }>;
      };
      expect(reloaded.agents).toContainEqual(expect.objectContaining({ id: accepted.agentId, status: "running" }));
      expect(driver.cancelCalls).toBe(0);

      const durableCommand = {
        idempotencyKey: "durable-message-command",
        type: "agent.message",
        payload: { agentId: accepted.agentId, content: "Continue from the durable checkpoint." },
        actor: { type: "user", id: null },
      };
      const firstReceipt = await fetch(`${base}/v1/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(durableCommand),
      }).then((response) => response.json());
      const duplicateReceipt = await fetch(`${base}/v1/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(durableCommand),
      }).then((response) => response.json());
      expect(duplicateReceipt).toEqual(firstReceipt);
      expect(driver.messageCalls).toBe(1);

      daemon.store.claimCommandReceipt({
        idempotencyKey: "outcome-unknown-command",
        accepted: false,
        state: "dispatching",
        result: { status: "outcome-unknown" },
        createdAt: nowIso(),
      });
      const ambiguousRetry = await fetch(`${base}/v1/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...durableCommand, idempotencyKey: "outcome-unknown-command" }),
      });
      expect(ambiguousRetry.status).toBe(409);

      driver.complete();
      await expect.poll(() => daemon.store.getAgent(accepted.agentId)?.status).toBe("completed");
      const detail = await fetch(`${base}/v1/threads/${thread.id}`).then((response) => response.json()) as {
        messages: Array<{ role: string; streaming?: boolean; parts: Array<{ type?: string; text?: string }> }>;
      };
      expect(detail.messages.find((message) => message.parts.some((part) => part.text === "Completed after the client reloaded."))).toMatchObject({
        role: "assistant",
        streaming: false,
        parts: [{ type: "text", text: "Completed after the client reloaded." }],
      });
      const automaticModel = await fetch(`${base}/v1/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conductor: { harness: "codex", model: "auto" } }),
      }).then((response) => response.json()) as { conductor: { model: string } };
      expect(automaticModel.conductor.model).toBe("auto");
      const nextTurn = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: "durable-chat-turn-2", content: "Continue once." }),
      }).then((response) => response.json()) as { agentId: string; messageId: string };
      const duplicateNextTurn = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: "durable-chat-turn-2", content: "Continue once." }),
      }).then((response) => response.json()) as typeof nextTurn;
      expect(duplicateNextTurn).toEqual(nextTurn);
      expect(nextTurn.agentId).not.toBe(accepted.agentId);
      expect(daemon.agents.hasSession(accepted.agentId)).toBe(false);
      await expect.poll(() => driver.forceTerminateCalls).toBe(1);
      await expect.poll(() => daemon.store.getMetadata(`agent-session-retirement:${accepted.agentId}`)).toMatchObject({
        agentId: accepted.agentId,
        nativeSessionId: `native-${accepted.agentId}`,
        reason: "chat-conductor-replaced",
        state: "retired",
        attempts: 1,
      });
      await expect.poll(() => driver.startCalls).toBe(2);
      expect(daemon.store.getAgent(nextTurn.agentId)?.requestedModel).toBe("auto");
      expect(driver.startRequests.at(-1)?.model).toBeUndefined();
      expect(driver.messageCalls).toBe(1);

      const recoveredThread = await fetch(`${base}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "test-thread-recover-turn" },
        body: JSON.stringify({ title: "Recover accepted turn" }),
      }).then((response) => response.json()) as { id: string };
      const recoveredMessageId = "accepted-before-restart";
      const recoveredContent = "Resume this accepted turn exactly once.";
      daemon.store.transaction(() => {
        daemon.store.appendConversationMessage(ConversationMessageSchema.parse({
          id: recoveredMessageId,
          threadId: recoveredThread.id,
          role: "user",
          parts: [{ type: "text", text: recoveredContent }],
          createdAt: nowIso(),
        }));
        const acceptedAt = nowIso();
        daemon.store.setMetadata(`chat-turn:${recoveredMessageId}`, {
          version: 1,
          messageId: recoveredMessageId,
          threadId: recoveredThread.id,
          requestHash: createHash("sha256")
            .update(JSON.stringify({ content: recoveredContent, attachments: [] }))
            .digest("hex"),
          state: "accepted",
          mode: null,
          agentId: null,
          receiptId: null,
          error: null,
          createdAt: acceptedAt,
          updatedAt: acceptedAt,
        });
      });
      await daemon.chats.recoverPendingTurns();
      const recoveredTurn = await fetch(`${base}/v1/threads/${recoveredThread.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: recoveredMessageId, content: recoveredContent }),
      }).then((response) => response.json()) as { agentId: string; messageId: string };
      expect(recoveredTurn.messageId).toBe(recoveredMessageId);
      await expect.poll(() => driver.startCalls).toBe(3);
      expect(driver.cancelCalls).toBe(0);

      const followUpMessageId = "follow-up-accepted-before-restart";
      const followUpAgentId = "durable-follow-up-agent";
      const followUpAt = nowIso();
      daemon.store.durableTransaction(() => {
        daemon.store.setMetadata(`chat-turn:${followUpMessageId}`, {
          version: 1,
          messageId: followUpMessageId,
          threadId: recoveredThread.id,
          requestHash: createHash("sha256").update("durable-follow-up-request").digest("hex"),
          state: "dispatching",
          mode: "message-existing",
          agentId: followUpAgentId,
          receiptId: null,
          error: null,
          createdAt: followUpAt,
          updatedAt: followUpAt,
        });
        daemon.store.setMetadata(`agent-follow-up:${followUpAgentId}`, {
          version: 1,
          attemptId: followUpMessageId,
          agentId: followUpAgentId,
          content: "Continue the retained native session exactly once.",
          state: "queued",
          receiptId: null,
          createdAt: followUpAt,
          updatedAt: followUpAt,
        });
      });

      await daemon.chats.recoverPendingTurns();

      expect(daemon.store.getMetadata(`chat-turn:${followUpMessageId}`)).toMatchObject({
        messageId: followUpMessageId,
        state: "delivered",
        mode: "message-existing",
        agentId: followUpAgentId,
        receiptId: followUpMessageId,
        error: null,
      });

      const unmatchedMessageId = "follow-up-without-runtime-receipt";
      daemon.store.setMetadata(`chat-turn:${unmatchedMessageId}`, {
        version: 1,
        messageId: unmatchedMessageId,
        threadId: recoveredThread.id,
        requestHash: createHash("sha256").update("unmatched-follow-up-request").digest("hex"),
        state: "dispatching",
        mode: "message-existing",
        agentId: "missing-follow-up-agent",
        receiptId: null,
        error: null,
        createdAt: followUpAt,
        updatedAt: followUpAt,
      });

      await daemon.chats.recoverPendingTurns();

      expect(daemon.store.getMetadata(`chat-turn:${unmatchedMessageId}`)).toMatchObject({
        state: "outcome-unknown",
        agentId: "missing-follow-up-agent",
      });
    } finally {
      await daemon.close();
    }
  });

  it("recovers and bootstraps every durable agent beyond one thousand records", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-large-recovery-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    const seeded = createStore(join(root, ".symphony"));
    const timestamp = nowIso();
    for (let index = 0; index < 1_005; index += 1) {
      const id = `recovery-agent-${String(index).padStart(4, "0")}`;
      seeded.saveAgent({
        id,
        logicalAgentId: `logical-${id}`,
        workflowId: "large-recovery-workflow",
        runId: "large-recovery-run",
        parentAgentId: null,
        depth: 0,
        objective: "Verify authoritative recovery pagination.",
        missionHash: "12345678",
        requestedHarness: "codex",
        requestedModel: "fixture",
        harness: null,
        model: null,
        permissions: "read-only",
        status: "queued",
        nativeSessionId: null,
        nativeRunId: null,
        workspacePath: root,
        output: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: null,
        finishedAt: null,
      });
    }
    seeded.close();

    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true });
    try {
      const bootstrap = await fetch(`http://127.0.0.1:${port}/v1/bootstrap`).then((response) => response.json()) as {
        agents: Array<{ id: string; status: string }>;
      };
      expect(bootstrap.agents).toHaveLength(1_005);
      expect(new Set(bootstrap.agents.map((agent) => agent.id)).size).toBe(1_005);
      expect(bootstrap.agents.every((agent) => agent.status === "lost")).toBe(true);
      expect(daemon.store.listAgents({ activeOnly: true, limit: 2_000 })).toEqual([]);
    } finally {
      await daemon.close();
    }
  });

  it("projects the newest transcript evidence after more than ten thousand agent events", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-long-transcript-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    const agentId = "long-transcript-agent";
    const timestamp = nowIso();
    const seeded = createStore(join(root, ".symphony"));
    seeded.saveAgent({
      id: agentId,
      logicalAgentId: agentId,
      workflowId: "long-transcript-workflow",
      runId: "long-transcript-run",
      parentAgentId: null,
      depth: 0,
      objective: "Keep the complete durable transcript visible.",
      missionHash: "12345678",
      requestedHarness: "codex",
      requestedModel: "fixture",
      harness: "codex",
      model: "fixture",
      permissions: "read-only",
      status: "completed",
      nativeSessionId: "long-transcript-session",
      nativeRunId: "long-transcript-native-run",
      workspacePath: root,
      output: { text: "Newest durable output." },
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
    });
    seeded.transaction(() => {
      const append = (type: string, payload: Record<string, unknown>) => seeded.appendEvent({
        type,
        workflowId: "long-transcript-workflow",
        runId: "long-transcript-run",
        agentId,
        occurredAt: timestamp,
        payload: payload as never,
        provenance: { source: "driver", driver: "codex" },
      });
      append("driver.message.delta", { text: "Old durable output.", messageId: "old-output" });
      append("driver.output.completed", { text: "Old durable output." });
      for (let index = 0; index < 10_001; index += 1) append("driver.log", { index });
      append("driver.message.delta", { text: "Newest durable output.", messageId: "new-output" });
      append("driver.output.completed", { text: "Newest durable output." });
      append("driver.run.completed", { status: "finished" });
    });
    seeded.close();

    const daemon = await startDaemon({ rootDirectory: root, port, host: "127.0.0.1", noPlugins: true });
    try {
      const transcript = await fetch(`http://127.0.0.1:${port}/v1/agents/${agentId}/messages`).then((response) => response.json()) as {
        messages: Array<{ parts: Array<{ text?: string }> }>;
      };
      expect(JSON.stringify(transcript.messages)).toContain("Newest durable output.");
    } finally {
      await daemon.close();
    }
  });

  it("serves health, bootstrap, resumable state, and grouped chat metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true });
    try {
      const base = `http://127.0.0.1:${port}`;
      const health = await fetch(`${base}/health`).then((response) => response.json()) as { ok: boolean };
      expect(health.ok).toBe(true);
      const created = await fetch(`${base}/v1/threads`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "test-thread-harness-work" }, body: JSON.stringify({ title: "Harness work", groupId: "Symphony" }) }).then((response) => response.json()) as { id: string; groupId: string };
      expect(created.groupId).toBe("Symphony");
      const bootstrap = await fetch(`${base}/v1/bootstrap`).then((response) => response.json()) as {
        cursor: number;
        events: unknown[];
        messages: unknown[];
        runCosts: Record<string, unknown>;
        agentCosts: Record<string, unknown>;
        settings: { conductor: { harness: string } };
        daemon: { noPlugins: boolean };
      };
      expect(bootstrap.cursor).toBeGreaterThan(0);
      expect(bootstrap.events.length).toBeGreaterThan(0);
      expect(bootstrap.messages).toEqual([]);
      expect(bootstrap.runCosts[`chat-run:${created.id}`]).toBeDefined();
      expect(bootstrap.agentCosts).toEqual({});
      expect(bootstrap.settings.conductor.harness).toBe("pi");
      expect(bootstrap.daemon.noPlugins).toBe(true);
      const currentEvents = await fetch(`${base}/v1/events?after=${bootstrap.cursor}&projection=ui`);
      expect(currentEvents.status).toBe(200);
      const currentEventReader = currentEvents.body?.getReader();
      expect(currentEventReader).toBeDefined();
      const initialFrame = await Promise.race([
        currentEventReader!.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE did not flush its initial frame")), 250)),
      ]);
      expect(new TextDecoder().decode(initialFrame.value)).toContain(": connected");
      await currentEventReader!.cancel();

      const replayStart = daemon.store.latestCursor();
      for (let index = 0; index < 1_105; index += 1) {
        daemon.store.appendEvent({
          type: "config.updated",
          workflowId: null,
          runId: null,
          agentId: null,
          occurredAt: nowIso(),
          payload: { index },
          provenance: { source: "daemon" },
        });
      }
      const replayResponse = await fetch(`${base}/v1/events?after=${replayStart}&projection=ui`);
      const replayReader = replayResponse.body?.getReader();
      expect(replayReader).toBeDefined();
      const replayDecoder = new TextDecoder();
      let replayText = "";
      while ((replayText.match(/event: config\.updated/gu) ?? []).length < 1_105) {
        const chunk = await replayReader!.read();
        if (chunk.done) break;
        replayText += replayDecoder.decode(chunk.value, { stream: true });
      }
      expect((replayText.match(/event: config\.updated/gu) ?? [])).toHaveLength(1_105);
      await replayReader!.cancel();
      daemon.store.recordUsage({
        id: "heatmap-usage",
        workflowId: `chat:${created.id}`,
        runId: `chat-run:${created.id}`,
        agentId: null,
        model: "fixture",
        harness: null,
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: null,
        costAmount: 0.0025,
        currency: "USD",
        basis: "provider-reported",
        priceSnapshotId: null,
        recordedAt: new Date().toISOString(),
      });
      const heatmap = await fetch(`${base}/v1/usage/heatmap?weeks=12`).then((response) => response.json()) as {
        weeks: number;
        days: Array<{ knownCost: number; eventCount: number; future: boolean }>;
      };
      expect(heatmap.weeks).toBe(12);
      expect(heatmap.days).toHaveLength(84);
      expect(heatmap.days.some((day) => day.knownCost === 0.0025 && day.eventCount === 1 && !day.future)).toBe(true);
      const detail = await fetch(`${base}/v1/threads/${created.id}`).then((response) => response.json()) as { thread: { title: string }; messages: unknown[] };
      expect(detail.thread.title).toBe("Harness work");
      expect(detail.messages).toEqual([]);

      const projectPath = join(root, "project-alpha");
      const canonicalRoot = realpathSync(root);
      mkdirSync(join(projectPath, "src"), { recursive: true });
      mkdirSync(join(projectPath, ".git"));
      const listing = await fetch(`${base}/v1/filesystem/directories?path=${encodeURIComponent(root)}`).then((response) => response.json()) as {
        currentPath: string;
        entries: Array<{ name: string; isGitRepository: boolean }>;
      };
      expect(listing.currentPath).toBe(canonicalRoot);
      expect(listing.entries).toContainEqual(expect.objectContaining({ name: "project-alpha", isGitRepository: true }));
      const project = await fetch(`${base}/v1/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspacePath: projectPath }),
      }).then((response) => response.json()) as { id: string; title: string; workspacePath: string; isGitRepository: boolean };
      const canonicalProjectPath = realpathSync(projectPath);
      expect(project).toMatchObject({ title: "project-alpha", workspacePath: canonicalProjectPath, isGitRepository: true });
      const projectChat = await fetch(`${base}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "test-thread-project-chat" },
        body: JSON.stringify({ projectId: project.id }),
      }).then((response) => response.json()) as { id: string; groupId: string; workspacePath: string };
      expect(projectChat).toMatchObject({ groupId: project.id, workspacePath: canonicalProjectPath });

      const streamingAgentId = "streaming-conductor";
      const streamingThread = daemon.store.getThread(projectChat.id);
      expect(streamingThread).not.toBeNull();
      daemon.store.saveThread({ ...streamingThread!, conductorAgentId: streamingAgentId });
      daemon.store.saveAgent({
        id: streamingAgentId,
        logicalAgentId: streamingAgentId,
        workflowId: `chat:${projectChat.id}`,
        runId: `chat-run:${projectChat.id}`,
        parentAgentId: null,
        depth: 0,
        objective: "Stream a response",
        missionHash: "fixture-mission",
        requestedHarness: "codex",
        requestedModel: "fixture",
        harness: "codex",
        model: "fixture",
        permissions: "full-access",
        status: "running",
        nativeSessionId: "fixture-session",
        nativeRunId: "fixture-run",
        workspacePath: canonicalProjectPath,
        output: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: null,
      });
      const appendDriverEvent = (type: string, payload: Record<string, unknown>) => daemon.store.appendEvent({
        type,
        workflowId: `chat:${projectChat.id}`,
        runId: `chat-run:${projectChat.id}`,
        agentId: streamingAgentId,
        occurredAt: new Date().toISOString(),
        payload: payload as never,
        provenance: { source: "driver", driver: "codex" },
      });
      appendDriverEvent("driver.message.delta", { text: "I’ll inspect the project.", messageId: "commentary-1" });
      appendDriverEvent("driver.tool.started", {
        toolCallId: "tool-create-agent",
        toolName: "create_agent",
        args: { objective: "Audit the architecture" },
        status: "inProgress",
      });
      appendDriverEvent("driver.tool.updated", {
        toolCallId: "tool-create-agent",
        status: "inProgress",
      });
      appendDriverEvent("driver.tool.completed", {
        toolCallId: "tool-create-agent",
        result: { agentId: "architecture-auditor", state: "running" },
        status: "completed",
      });
      appendDriverEvent("driver.message.delta", { text: "The audit is running.", messageId: "commentary-2" });
      const runHistory = await fetch(`${base}/v1/runs/${encodeURIComponent(`chat-run:${projectChat.id}`)}/events?limit=2`)
        .then((response) => response.json()) as {
          cursor: number;
          hasMore: boolean;
          events: Array<{ type: string; runId: string }>;
        };
      expect(runHistory.hasMore).toBe(true);
      expect(runHistory.events).toHaveLength(2);
      expect(runHistory.events.every((event) => event.runId === `chat-run:${projectChat.id}`)).toBe(true);
      const remainingRunHistory = await fetch(`${base}/v1/runs/${encodeURIComponent(`chat-run:${projectChat.id}`)}/events?after=${runHistory.cursor}&limit=20`)
        .then((response) => response.json()) as typeof runHistory;
      expect(remainingRunHistory.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "driver.tool.completed" }),
      ]));
      const overlapping = await fetch(`${base}/v1/threads/${projectChat.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "This must not overlap", attachments: [] }),
      });
      expect(overlapping.status).toBe(409);
      let streamed = await fetch(`${base}/v1/threads/${projectChat.id}`).then((response) => response.json()) as {
        messages: Array<{
          id: string;
          streaming: boolean;
          parts: Array<{ type?: string; text?: string; toolCallId?: string; toolName?: string; result?: unknown }>;
        }>;
      };
      expect(streamed.messages).toHaveLength(1);
      expect(streamed.messages[0]).toMatchObject({
        streaming: true,
        parts: [
          { type: "text", text: "I’ll inspect the project." },
          {
            type: "tool-call",
            toolCallId: "tool-create-agent",
            toolName: "create_agent",
            result: { agentId: "architecture-auditor", state: "running" },
          },
          { type: "text", text: "The audit is running." },
        ],
      });
      expect(streamed.messages[0]?.parts.filter((part) => part.toolCallId === "tool-create-agent")).toHaveLength(1);
      const streamMessageId = streamed.messages[0]?.id;
      appendDriverEvent("driver.output.completed", { text: "The audit is running." });
      streamed = await fetch(`${base}/v1/threads/${projectChat.id}`).then((response) => response.json()) as typeof streamed;
      expect(streamed.messages).toHaveLength(1);
      expect(streamed.messages[0]).toMatchObject({
        id: streamMessageId,
        streaming: false,
        parts: [
          { type: "text", text: "I’ll inspect the project." },
          { type: "tool-call", toolCallId: "tool-create-agent" },
          { type: "text", text: "The audit is running." },
        ],
      });
      const agentTranscript = await fetch(`${base}/v1/agents/${streamingAgentId}/messages`).then((response) => response.json()) as {
        agentId: string;
        messages: Array<{
          id: string;
          role: string;
          parts: Array<{ type?: string; text?: string; toolCallId?: string; result?: unknown }>;
        }>;
      };
      expect(agentTranscript.agentId).toBe(streamingAgentId);
      expect(agentTranscript.messages).toMatchObject([
        {
          id: `agent:${streamingAgentId}:objective`,
          role: "user",
          parts: [{ type: "text", text: "Stream a response" }],
        },
        {
          role: "assistant",
          parts: [
            { type: "text", text: "I’ll inspect the project." },
            { type: "tool-call", toolCallId: "tool-create-agent", result: { agentId: "architecture-auditor" } },
            { type: "text", text: "The audit is running." },
          ],
        },
      ]);
      const sessionLog = await fetch(`${base}/v1/agents/${streamingAgentId}/logs?limit=20`).then((response) => response.json()) as {
        agent: { id: string; nativeSessionId: string };
        cursor: number;
        entries: Array<{ cursor: number; level: string; type: string; message: string }>;
      };
      expect(sessionLog.agent).toMatchObject({ id: streamingAgentId, nativeSessionId: "fixture-session" });
      expect(sessionLog.cursor).toBeGreaterThan(0);
      expect(sessionLog.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "driver.tool.started", message: "Started create_agent" }),
        expect.objectContaining({ type: "driver.tool.completed", message: "Completed create_agent" }),
      ]));
      appendDriverEvent("driver.log", { stream: "stderr", line: '{"level":"WARN","message":"retrying"}' });
      appendDriverEvent("driver.log", { stream: "stderr", line: '{"level":"ERROR","message":"native failure"}' });
      const classifiedLogs = await fetch(`${base}/v1/agents/${streamingAgentId}/logs?limit=5&tail=true`).then((response) => response.json()) as {
        entries: Array<{ level: string; message: string }>;
      };
      expect(classifiedLogs.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ level: "warn", message: '{"level":"WARN","message":"retrying"}' }),
        expect.objectContaining({ level: "error", message: '{"level":"ERROR","message":"native failure"}' }),
      ]));

      // Daemon-origin diagnostics do not cross the worker-event sanitizer;
      // the agent-facing logs projection must still redact and bound them.
      daemon.store.appendEvent({
        type: "driver.log",
        workflowId: `chat:${projectChat.id}`,
        runId: `chat-run:${projectChat.id}`,
        agentId: streamingAgentId,
        occurredAt: new Date().toISOString(),
        payload: {
          apiKey: "daemon-origin-secret",
          nested: { password: "nested-secret" },
          output: "x".repeat(10_000),
        },
        provenance: { source: "daemon" },
      });
      const safeLogs = await fetch(`${base}/v1/agents/${streamingAgentId}/logs?limit=5&tail=true`).then((response) => response.json()) as {
        entries: Array<{ data: unknown; message: string }>;
      };
      const safeLog = safeLogs.entries.at(-1);
      expect(JSON.stringify(safeLog)).not.toContain("daemon-origin-secret");
      expect(JSON.stringify(safeLog)).not.toContain("nested-secret");
      expect(JSON.stringify(safeLog)).toContain("[REDACTED]");
      expect(JSON.stringify(safeLog)).toContain("[truncated]");

      appendDriverEvent("driver.reasoning.delta", { text: "Plan the response." });
      appendDriverEvent("driver.message.delta", { text: "Answer." });
      appendDriverEvent("driver.reasoning.delta", { text: "Plan the response.", replace: true });
      appendDriverEvent("driver.message.delta", { text: "Answer.", replace: true });
      appendDriverEvent("driver.output.completed", { text: "Answer." });
      const deduplicated = await fetch(`${base}/v1/threads/${projectChat.id}`).then((response) => response.json()) as {
        messages: Array<{ parts: Array<{ type?: string; text?: string }> }>;
      };
      expect(deduplicated.messages.at(-1)?.parts).toEqual([
        { type: "reasoning", text: "Plan the response.", status: { type: "complete" } },
        { type: "text", text: "Answer." },
      ]);

      appendDriverEvent("driver.message.delta", { text: "Work before interruption." });
      const beforeInterruption = daemon.store.getAgent(streamingAgentId);
      daemon.store.saveAgent({
        ...beforeInterruption!,
        status: "interrupted",
        error: "The retained native process became unavailable.",
        finishedAt: nowIso(),
        updatedAt: nowIso(),
      });
      appendDriverEvent("agent.interrupted", { error: "The retained native process became unavailable." });
      const interruptedMessages = await fetch(`${base}/v1/threads/${projectChat.id}`).then((response) => response.json()) as {
        messages: Array<{ streaming: boolean; parts: Array<{ type?: string; text?: string }> }>;
      };
      expect(interruptedMessages.messages.at(-2)).toMatchObject({
        streaming: false,
        parts: [{ type: "text", text: "Work before interruption." }],
      });
      expect(interruptedMessages.messages.at(-1)?.parts[0]?.text).toContain("This run was interrupted.");
      const settledMessageCount = interruptedMessages.messages.length;
      appendDriverEvent("driver.run.failed", { error: "The retained native process became unavailable." });
      appendDriverEvent("driver.message.delta", { text: "Late text must remain raw evidence only." });
      appendDriverEvent("driver.tool.started", { toolCallId: "late-tool", toolName: "bash" });
      const afterLateEvidence = await fetch(`${base}/v1/threads/${projectChat.id}`).then((response) => response.json()) as typeof interruptedMessages;
      expect(afterLateEvidence.messages).toHaveLength(settledMessageCount);
      expect(JSON.stringify(afterLateEvidence.messages)).not.toContain("Late text must remain raw evidence only.");
      const settledTranscript = await fetch(`${base}/v1/agents/${streamingAgentId}/messages`).then((response) => response.json()) as {
        messages: Array<{ streaming?: boolean; parts: Array<{ text?: string }> }>;
      };
      const transcriptText = JSON.stringify(settledTranscript.messages);
      expect(transcriptText).not.toContain("Late text must remain raw evidence only.");
      expect((transcriptText.match(/retained native process became unavailable/giu) ?? [])).toHaveLength(1);
      expect(settledTranscript.messages.every((message) => message.streaming !== true)).toBe(true);
      const storedChatUpdates = daemon.store.eventsAfter(0, { types: ["chat.message.updated"] });
      expect(storedChatUpdates.length).toBeGreaterThan(0);
      expect(storedChatUpdates.every((event) => {
        const payload = event.payload as Record<string, unknown>;
        return typeof payload.messageId === "string" && payload.message === undefined;
      })).toBe(true);

      const projectBootstrap = await fetch(`${base}/v1/bootstrap`).then((response) => response.json()) as {
        projects: Array<{ id: string }>;
        events: Array<{ type: string }>;
      };
      expect(projectBootstrap.projects).toContainEqual(expect.objectContaining({ id: project.id }));
      expect(projectBootstrap.events.some((event) => event.type === "chat.message.updated")).toBe(false);

      const settings = await fetch(`${base}/v1/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conductor: { harness: "claude", model: "auto" },
          agents: { defaultPermissions: "read-only", maxDepth: 2, maxConcurrent: 4 },
          uiUtilities: { chatSearch: { rerankEnabled: true } },
        }),
      }).then((response) => response.json()) as {
        conductor: { harness: string; model: string };
        agents: { defaultPermissions: string; maxDepth: number | null; maxConcurrent: number | null };
        uiUtilities: { chatSearch: { rerankEnabled: boolean } };
      };
      expect(settings).toMatchObject({
        conductor: { harness: "claude", model: "auto" },
        agents: { defaultPermissions: "read-only", maxDepth: 2, maxConcurrent: 4 },
        uiUtilities: { chatSearch: { rerankEnabled: true } },
      });
      const unlimited = await fetch(`${base}/v1/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agents: { maxDepth: null, maxConcurrent: null } }),
      }).then((response) => response.json()) as {
        agents: { maxDepth: number | null; maxConcurrent: number | null };
      };
      expect(unlimited.agents).toMatchObject({ maxDepth: null, maxConcurrent: null });
      const persisted = JSON.parse(readFileSync(join(root, "symphony.config.json"), "utf8")) as {
        conductor: { harness: string };
        agents: { maxDepth: number | null; maxConcurrent: number | null };
        uiUtilities: { chatSearch: { rerankEnabled: boolean } };
      };
      expect(persisted.conductor.harness).toBe("claude");
      expect(persisted.agents).toMatchObject({ maxDepth: null, maxConcurrent: null });
      expect(persisted.uiUtilities.chatSearch.rerankEnabled).toBe(true);

      const chat = await fetch(`${base}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "test-thread-new-chat" },
        body: JSON.stringify({ title: "New chat" }),
      }).then((response) => response.json()) as { id: string };
      const sent = await fetch(`${base}/v1/threads/${chat.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messageId: "client-message-1",
          content: "Fix the thing",
          attachments: [{
            id: "attachment-1",
            name: "notes.md",
            type: "document",
            contentType: "text/markdown",
            content: [{ type: "text", text: "<attachment name=notes.md>\nUse the existing API.\n</attachment>" }],
          }],
        }),
      });
      expect(sent.status).toBe(202);
      const chatDetail = await fetch(`${base}/v1/threads/${chat.id}`).then((response) => response.json()) as {
        thread: { title: string };
        messages: Array<{ id: string; parts: Array<{ type?: string }> }>;
      };
      expect(chatDetail.thread.title).toBe("Fix the thing");
      expect(chatDetail.messages[0]).toMatchObject({
        id: "client-message-1",
        parts: [{ type: "text" }, { type: "attachment" }],
      });
    } finally {
      await daemon.close();
    }
  });

  it("leases the durable data directory before recovery and releases it on shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-lease-"));
    temporary.push(root);
    const firstPort = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port: firstPort, openBrowser: false, webDirectory: "apps/web/out" },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));

    const first = await startDaemon({ rootDirectory: root, noPlugins: true });
    try {
      const competingPort = await availablePort();
      await expect(startDaemon({ rootDirectory: root, noPlugins: true, port: competingPort }))
        .rejects.toThrow(/already owned by daemon PID/u);
    } finally {
      await first.close();
    }

    process.env.SYMPHONY_DAEMON_SECRET = TEST_DAEMON_SECRET;
    const replacementPort = await availablePort();
    const replacement = await startDaemon({ rootDirectory: root, noPlugins: true, port: replacementPort });
    await replacement.close();
  });
});
