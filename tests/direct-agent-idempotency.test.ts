import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { capabilities, emit, makeSession } from "../packages/drivers/src/common.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
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

class CountingDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities();
  starts = 0;
  resumes = 0;
  messages = 0;
  cancels = 0;
  private readonly eventConsumers = new Map<string, (event: DriverEvent) => void>();

  async doctor(): Promise<DriverDoctorResult> {
    return {
      driver: this.id,
      available: true,
      authenticated: true,
      version: "fixture",
      capabilities: this.capabilities,
      detail: "Direct idempotency fixture",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{
      id: "fixture",
      harness: this.id,
      name: "Fixture",
      description: "Direct idempotency fixture",
      modalities: ["text"],
      structuredOutput: false,
      pricing: {},
      metadata: {},
    }];
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.starts += 1;
    this.eventConsumers.set(`native-${request.agentId}`, onEvent);
    emit(onEvent, "run.started", { agentId: request.agentId });
    return makeSession(this.id, `native-${request.agentId}`);
  }

  async resume(
    session: DriverSession,
    request: DriverStartRequest,
    onEvent: (event: DriverEvent) => void,
  ): Promise<DriverSession> {
    this.resumes += 1;
    this.eventConsumers.set(session.nativeSessionId, onEvent);
    emit(onEvent, "run.updated", { agentId: request.agentId, resumed: true });
    return { ...session, state: "running" };
  }

  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> {
    this.messages += 1;
    return { receiptId: `receipt-${this.messages}`, queued: false };
  }

  async cancel(session: DriverSession): Promise<void> {
    this.cancels += 1;
    const onEvent = this.eventConsumers.get(session.nativeSessionId);
    if (onEvent) emit(onEvent, "run.cancelled", { nativeSessionId: session.nativeSessionId });
  }

  complete(agentId: string): void {
    const onEvent = this.eventConsumers.get(`native-${agentId}`);
    if (!onEvent) throw new Error(`No event consumer for ${agentId}`);
    emit(onEvent, "output.completed", { text: "Completed fixture turn." });
    emit(onEvent, "run.completed", { status: "finished" });
  }
}

function registry(driver: CountingDriver): DriverRegistry {
  const value = new DriverRegistry();
  value.register(driver);
  return value;
}

describe("direct agent mutation idempotency", () => {
  it("deduplicates authenticated create and message retries across daemon restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-direct-idempotency-"));
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
        recoveryTimeoutMs: 30_000,
        recoveryConcurrency: 4,
      },
      harnesses: {
        codex: { enabled: true }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
      workflows: { triggersEnabled: true },
    }));

    const firstDriver = new CountingDriver();
    const firstDaemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: registry(firstDriver) });
    const base = `http://127.0.0.1:${port}`;
    let parentId = "";
    let parentToken = "";
    let firstChildId = "";
    let firstMessageResult: unknown;
    let firstFollowUpResult: unknown;
    let firstPresentationResult: unknown;
    try {
      const thread = firstDaemon.chats.create({
        title: "Idempotent structured UI",
        workspacePath: root,
      }, "direct-agent-idempotency-thread");
      const parent = await firstDaemon.agents.create({
        id: "idempotency-parent",
        workflowId: `chat:${thread.id}`,
        runId: `chat-run:${thread.id}`,
        parentAgentId: null,
        depth: 0,
        mission: { id: "mission", revision: 1, hash: "mission-hash", statement: "Exercise durable retries.", keyResults: [] },
        objective: "Remain available for coordination.",
        model: "fixture",
        harness: "codex",
        permissions: "full-access",
        outputSchema: {},
        workspace: { path: root, dirtyPolicy: "local-only" },
      });
      parentId = parent.id;
      parentToken = firstDaemon.agents.tokenFor(parent.id);
      await expect.poll(() => firstDaemon.agents.hasSession(parent.id)).toBe(true);
      const authHeaders = {
        "connection": "close",
        "content-type": "application/json",
        "x-symphony-agent-id": parent.id,
        "x-symphony-agent-token": parentToken,
      };
      const childInput = {
        objective: "Inspect the idempotency boundary.",
        harness: "codex",
        model: "fixture",
        permissions: "read-only",
        outputSchema: {},
      };
      const createHeaders = { ...authHeaders, "idempotency-key": "mcp:create-agent:tool-call-1" };
      const create = () => fetch(`${base}/v1/agents`, {
        method: "POST",
        headers: createHeaders,
        body: JSON.stringify(childInput),
      });
      const firstCreate = await create();
      expect(firstCreate.status).toBe(202);
      const firstChild = await firstCreate.json() as { id: string };
      firstChildId = firstChild.id;
      const duplicateChild = await (await create()).json() as { id: string };
      expect(duplicateChild).toEqual(firstChild);
      expect(firstDaemon.agents.list()).toHaveLength(2);

      const conflictingCreate = await fetch(`${base}/v1/agents`, {
        method: "POST",
        headers: createHeaders,
        body: JSON.stringify({ ...childInput, objective: "A different operation." }),
      });
      expect(conflictingCreate.status).toBe(409);

      const missingKey = await fetch(`${base}/v1/agents/${parent.id}/messages`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ content: "Do not deliver this." }),
      });
      expect(missingKey.status).toBe(400);

      const messageKey = "mcp:send-message:tool-call-2";
      const messageHeaders = { ...authHeaders, "idempotency-key": messageKey };
      const send = (content = "Continue safely.") => fetch(`${base}/v1/agents/${parent.id}/messages`, {
        method: "POST",
        headers: messageHeaders,
        body: JSON.stringify({ content }),
      });
      const firstMessage = await (await send()).json();
      firstMessageResult = firstMessage;
      const duplicateMessage = await (await send()).json();
      expect(duplicateMessage).toEqual(firstMessage);
      expect(firstDriver.messages).toBe(1);
      expect(firstDaemon.agents.messageAttempt(parent.id, messageKey)).toMatchObject({
        kind: "steering",
        state: "delivered",
        attemptId: messageKey,
        receiptId: "receipt-1",
        queued: false,
      });
      expect((await send("Conflicting content.")).status).toBe(409);
      expect(firstDriver.messages).toBe(1);

      const presentationKey = "mcp:present-ui:tool-call-4";
      const presentation = { kind: "job-progress", data: { title: "Durable projection", progress: 0.5 } };
      const present = () => fetch(`${base}/v1/agents/${parent.id}/present`, {
        method: "POST",
        headers: { ...authHeaders, "idempotency-key": presentationKey },
        body: JSON.stringify(presentation),
      });
      const firstPresentation = await present();
      expect(firstPresentation.status).toBe(201);
      firstPresentationResult = await firstPresentation.json();
      expect(await (await present()).json()).toEqual(firstPresentationResult);
      expect(firstDaemon.store.listConversationMessages(thread.id)
        .filter((message) => message.id === (firstPresentationResult as { messageId: string }).messageId)).toHaveLength(1);

      firstDriver.complete(parent.id);
      await expect.poll(() => firstDaemon.store.getAgent(parent.id)?.status).toBe("completed");
      const followUpKey = "mcp:send-message:tool-call-3";
      const sendFollowUp = () => fetch(`${base}/v1/agents/${parent.id}/messages`, {
        method: "POST",
        headers: { ...authHeaders, "idempotency-key": followUpKey },
        body: JSON.stringify({ content: "Continue in the retained session." }),
      });
      firstFollowUpResult = await (await sendFollowUp()).json();
      expect(await (await sendFollowUp()).json()).toEqual(firstFollowUpResult);
      await expect.poll(() => firstDriver.messages).toBe(2);
      expect(firstDaemon.agents.messageAttempt(parent.id, followUpKey)).toMatchObject({
        kind: "follow-up",
        attemptId: followUpKey,
        queued: true,
      });

      for (const idempotencyKey of ["mcp:create-agent:tool-call-1", messageKey, followUpKey, presentationKey]) {
        const receipt = firstDaemon.store.getCommandReceipt(idempotencyKey);
        expect(receipt).not.toBeNull();
        firstDaemon.store.replaceCommandReceipt({
          ...receipt!,
          accepted: false,
          state: "dispatching",
          result: {
            commandType: idempotencyKey === "mcp:create-agent:tool-call-1"
              ? "agent.create"
              : idempotencyKey === presentationKey ? "agent.present" : "agent.message",
            status: "outcome-unknown",
          },
          updatedAt: new Date().toISOString(),
        });
      }
    } finally {
      await firstDaemon.close();
    }

    process.env.SYMPHONY_DAEMON_SECRET = TEST_DAEMON_SECRET;
    const secondDriver = new CountingDriver();
    const secondDaemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: registry(secondDriver) });
    try {
      const authHeaders = {
        "connection": "close",
        "content-type": "application/json",
        "x-symphony-agent-id": parentId,
        "x-symphony-agent-token": parentToken,
      };
      expect(secondDaemon.agents.authenticate(parentId, parentToken)).toBe(true);
      const wrongSameLength = `${parentToken.slice(0, -1)}${parentToken.endsWith("0") ? "1" : "0"}`;
      expect(secondDaemon.agents.authenticate(parentId, wrongSameLength)).toBe(false);
      expect(secondDaemon.agents.authenticate(parentId, parentToken.slice(1))).toBe(false);
      expect(secondDaemon.agents.authenticate(parentId, `${parentToken}00`)).toBe(false);
      expect(secondDaemon.agents.authenticate(parentId, "🔒")).toBe(false);
      const retriedCreate = await fetch(`${base}/v1/agents`, {
        method: "POST",
        headers: { ...authHeaders, "idempotency-key": "mcp:create-agent:tool-call-1" },
        body: JSON.stringify({
          objective: "Inspect the idempotency boundary.",
          harness: "codex",
          model: "fixture",
          permissions: "read-only",
          outputSchema: {},
        }),
      });
      const retriedMessage = await fetch(`${base}/v1/agents/${parentId}/messages`, {
        method: "POST",
        headers: { ...authHeaders, "idempotency-key": "mcp:send-message:tool-call-2" },
        body: JSON.stringify({ content: "Continue safely." }),
      });
      const retriedFollowUp = await fetch(`${base}/v1/agents/${parentId}/messages`, {
        method: "POST",
        headers: { ...authHeaders, "idempotency-key": "mcp:send-message:tool-call-3" },
        body: JSON.stringify({ content: "Continue in the retained session." }),
      });
      const retriedPresentation = await fetch(`${base}/v1/agents/${parentId}/present`, {
        method: "POST",
        headers: { ...authHeaders, "idempotency-key": "mcp:present-ui:tool-call-4" },
        body: JSON.stringify({ kind: "job-progress", data: { title: "Durable projection", progress: 0.5 } }),
      });
      expect(retriedCreate.status).toBe(202);
      expect(((await retriedCreate.json()) as { id: string }).id).toBe(firstChildId);
      expect(retriedMessage.status).toBe(202);
      expect(await retriedMessage.json()).toEqual(firstMessageResult);
      expect(retriedFollowUp.status).toBe(202);
      expect(await retriedFollowUp.json()).toEqual(firstFollowUpResult);
      expect(retriedPresentation.status).toBe(201);
      expect(await retriedPresentation.json()).toEqual(firstPresentationResult);
      expect(secondDaemon.store.getConversationMessage((firstPresentationResult as { messageId: string }).messageId)).not.toBeNull();
      expect(secondDaemon.agents.list()).toHaveLength(2);
      expect(secondDriver.starts).toBe(0);
      expect(secondDriver.messages).toBe(0);
    } finally {
      await secondDaemon.close();
    }
  });

  it("deduplicates workflow mutations and reconstructs interrupted cancellation receipts", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-command-idempotency-"));
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
        recoveryTimeoutMs: 30_000,
        recoveryConcurrency: 4,
        cancellationAcknowledgementTimeoutMs: 20,
        cancellationTerminationGraceMs: 20,
      },
      harnesses: {
        codex: { enabled: true }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
      workflows: { triggersEnabled: true },
    }));

    const workflowDefinition = {
      id: "durable-command-workflow",
      name: "Durable command workflow",
      mission: { statement: "Exercise workflow mutation idempotency.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" as const },
      steps: [{ id: "finish", type: "set" as const, value: { ok: true } }],
    };
    const dynamicWorkflow = {
      id: "agent-defined-workflow",
      name: "Agent defined workflow",
      mission: { statement: "Let a conductor choose and persist its orchestration strategy.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" as const },
      steps: [{ id: "result", type: "set" as const, value: { registered: true } }],
      triggers: [{ id: "far-future", type: "cron" as const, expression: "0 0 1 1 *", input: {} }],
    };
    const cancellableWorkflow = {
      id: "durable-cancellable-workflow",
      name: "Durable cancellable workflow",
      mission: { statement: "Keep native work supervised until cancellation is durably requested.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" as const },
      steps: [{
        id: "wait-for-cancel",
        type: "agent" as const,
        objective: "Remain active until the workflow is cancelled.",
        harness: "codex" as const,
        model: "fixture",
        permissions: "read-only" as const,
        outputSchema: {},
      }],
    };
    const base = `http://127.0.0.1:${port}`;
    const jsonHeaders = { "connection": "close", "content-type": "application/json" };
    const firstDriver = new CountingDriver();
    const firstDaemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: registry(firstDriver) });
    let targetId = "";
    let ambiguousAgentId = "";
    let firstRunId = "";
    let ambiguousRunId = "";
    try {
      firstDaemon.workflows.register(new WorkflowCompiler().compile(workflowDefinition, 1));
      firstDaemon.workflows.register(new WorkflowCompiler().compile(cancellableWorkflow, 1));
      const registerHeaders = { ...jsonHeaders, "idempotency-key": "direct:register-workflow:1" };
      const registerWorkflow = (definition: unknown = dynamicWorkflow, headers = registerHeaders) => fetch(`${base}/v1/workflows`, {
        method: "POST",
        headers,
        body: JSON.stringify(definition),
      });
      const registered = await (await registerWorkflow()).json() as { id: string; revision: number; hash: string };
      const duplicateRegistration = await (await registerWorkflow()).json() as { id: string; revision: number; hash: string };
      expect(registered).toMatchObject({ id: dynamicWorkflow.id, revision: 1 });
      expect(duplicateRegistration).toEqual(registered);
      expect((await registerWorkflow({ ...dynamicWorkflow, name: "Conflicting retry" })).status).toBe(409);
      const contentDuplicateResponse = await registerWorkflow(
        dynamicWorkflow,
        { ...jsonHeaders, "idempotency-key": "direct:register-workflow:same-content" },
      );
      expect(contentDuplicateResponse.status).toBe(201);
      await expect(contentDuplicateResponse.json()).resolves.toEqual(registered);
      const revisedResponse = await registerWorkflow(
        { ...dynamicWorkflow, name: "Agent defined workflow v2" },
        { ...jsonHeaders, "idempotency-key": "direct:register-workflow:2" },
      );
      expect(revisedResponse.status).toBe(201);
      await expect(revisedResponse.json()).resolves.toMatchObject({ id: dynamicWorkflow.id, revision: 2 });
      expect(firstDaemon.triggers.activeTriggerCount(dynamicWorkflow.id)).toBe(1);

      const target = await firstDaemon.agents.create({
        id: "cancel-target",
        workflowId: "cancel-workflow",
        runId: "cancel-run",
        parentAgentId: null,
        depth: 0,
        mission: { id: "cancel", revision: 1, hash: "cancel-hash", statement: "Wait to be cancelled.", keyResults: [] },
        objective: "Wait to be cancelled.",
        model: "fixture",
        harness: "codex",
        permissions: "full-access",
        outputSchema: {},
        workspace: { path: root, dirtyPolicy: "local-only" },
      });
      targetId = target.id;
      await expect.poll(() => firstDaemon.agents.hasSession(target.id)).toBe(true);

      const genericAgentCommand = await fetch(`${base}/v1/commands`, {
        method: "POST",
        headers: {
          ...jsonHeaders,
          "x-symphony-agent-id": target.id,
          "x-symphony-agent-token": firstDaemon.agents.tokenFor(target.id),
        },
        body: JSON.stringify({
          idempotencyKey: "direct:agent-generic-command",
          type: "workflow.run",
          payload: { workflowId: workflowDefinition.id, input: {} },
          actor: { type: "user", id: null },
        }),
      });
      expect(genericAgentCommand.status).toBe(403);

      const missingCancelKey = await fetch(`${base}/v1/agents/${target.id}/cancel`, {
        method: "POST", headers: jsonHeaders, body: "{}",
      });
      expect(missingCancelKey.status).toBe(400);

      const cancelHeaders = { ...jsonHeaders, "idempotency-key": "direct:cancel-agent:1" };
      const cancel = () => fetch(`${base}/v1/agents/${target.id}/cancel`, {
        method: "POST", headers: cancelHeaders, body: "{}",
      });
      expect((await cancel()).status).toBe(204);
      expect((await cancel()).status).toBe(204);
      expect(firstDriver.cancels).toBe(1);

      const conflictingCancel = await fetch(`${base}/v1/agents/different-agent/cancel`, {
        method: "POST", headers: cancelHeaders, body: "{}",
      });
      expect(conflictingCancel.status).toBe(409);
      expect(firstDriver.cancels).toBe(1);

      const missingRunKey = await fetch(`${base}/v1/workflows/${workflowDefinition.id}/runs`, {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ value: 1 }),
      });
      expect(missingRunKey.status).toBe(400);

      const startHeaders = { ...jsonHeaders, "idempotency-key": "direct:run-workflow:1" };
      const start = (input: unknown = { value: 1 }) => fetch(`${base}/v1/workflows/${workflowDefinition.id}/runs`, {
        method: "POST", headers: startHeaders, body: JSON.stringify(input),
      });
      const firstRun = await (await start()).json() as { id: string };
      const duplicateRun = await (await start()).json() as { id: string };
      expect(duplicateRun).toEqual(firstRun);
      firstRunId = firstRun.id;
      expect(firstDaemon.store.listRuns()).toHaveLength(1);
      await expect.poll(() => firstDaemon.store.getRun(firstRun.id)?.status).toBe("completed");
      expect((await start({ value: 2 })).status).toBe(409);
      expect(firstDaemon.store.listRuns()).toHaveLength(1);

      const secondRunResponse = await fetch(`${base}/v1/workflows/${workflowDefinition.id}/runs`, {
        method: "POST",
        headers: { ...jsonHeaders, "idempotency-key": "direct:run-workflow:2" },
        body: JSON.stringify({ value: 2 }),
      });
      const secondRun = await secondRunResponse.json() as { id: string };
      expect(secondRunResponse.status).toBe(202);

      const cancelRunHeaders = { ...jsonHeaders, "idempotency-key": "direct:cancel-run:1" };
      const cancelRun = (runId = firstRun.id) => fetch(`${base}/v1/runs/${runId}/cancel`, {
        method: "POST", headers: cancelRunHeaders, body: "{}",
      });
      const firstCancellation = await (await cancelRun()).json();
      const duplicateCancellation = await (await cancelRun()).json();
      expect(duplicateCancellation).toEqual(firstCancellation);
      expect(firstCancellation).toMatchObject({ status: "completed", cancelRequested: false });
      expect(firstDaemon.store.getRun(firstRun.id)?.cancelRequested).toBe(false);
      expect((await cancelRun(secondRun.id)).status).toBe(409);
      expect(firstDaemon.store.getRun(secondRun.id)?.cancelRequested).toBe(false);

      const ambiguousAgent = await firstDaemon.agents.create({
        id: "ambiguous-cancel-target",
        workflowId: "ambiguous-cancel-workflow",
        runId: "ambiguous-cancel-agent-run",
        parentAgentId: null,
        depth: 0,
        mission: { id: "ambiguous-cancel", revision: 1, hash: "ambiguous-cancel-hash", statement: "Survive until a recovered cancel request arrives.", keyResults: [] },
        objective: "Remain active until cancelled after daemon recovery.",
        model: "fixture",
        harness: "codex",
        permissions: "full-access",
        outputSchema: {},
        workspace: { path: root, dirtyPolicy: "local-only" },
      });
      ambiguousAgentId = ambiguousAgent.id;
      await expect.poll(() => firstDaemon.agents.hasSession(ambiguousAgent.id)).toBe(true);

      const ambiguousRunResponse = await fetch(`${base}/v1/workflows/${cancellableWorkflow.id}/runs`, {
        method: "POST",
        headers: { ...jsonHeaders, "idempotency-key": "direct:run-workflow:3" },
        body: JSON.stringify({ value: 3 }),
      });
      ambiguousRunId = ((await ambiguousRunResponse.json()) as { id: string }).id;
      expect(ambiguousRunResponse.status).toBe(202);
      await expect.poll(() => firstDaemon.agents.list({ runId: ambiguousRunId, activeOnly: true })).toHaveLength(1);
      const createdAt = new Date().toISOString();
      firstDaemon.store.claimCommandReceipt({
        idempotencyKey: "direct:ambiguous-cancel-run",
        accepted: false,
        state: "dispatching",
        result: { commandType: "workflow.cancel", status: "outcome-unknown" },
        createdAt,
        updatedAt: createdAt,
      });
      firstDaemon.store.claimCommandReceipt({
        idempotencyKey: "direct:ambiguous-cancel-agent",
        accepted: false,
        state: "dispatching",
        result: { commandType: "agent.cancel", status: "outcome-unknown" },
        createdAt,
        updatedAt: createdAt,
      });
      const runReceipt = firstDaemon.store.getCommandReceipt("direct:run-workflow:1");
      expect(runReceipt).not.toBeNull();
      firstDaemon.store.replaceCommandReceipt({
        ...runReceipt!,
        accepted: false,
        state: "dispatching",
        result: { commandType: "workflow.run", status: "outcome-unknown" },
        updatedAt: new Date().toISOString(),
      });
      const registerReceipt = firstDaemon.store.getCommandReceipt("direct:register-workflow:2");
      expect(registerReceipt).not.toBeNull();
      firstDaemon.store.replaceCommandReceipt({
        ...registerReceipt!,
        accepted: false,
        state: "dispatching",
        result: { commandType: "workflow.register", status: "outcome-unknown" },
        updatedAt: new Date().toISOString(),
      });
    } finally {
      await firstDaemon.close();
    }

    process.env.SYMPHONY_DAEMON_SECRET = TEST_DAEMON_SECRET;
    const secondDriver = new CountingDriver();
    const secondDaemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: registry(secondDriver) });
    try {
      const replayedCancel = await fetch(`${base}/v1/agents/${targetId}/cancel`, {
        method: "POST",
        headers: { ...jsonHeaders, "idempotency-key": "direct:cancel-agent:1" },
        body: "{}",
      });
      const replayedStart = await fetch(`${base}/v1/workflows/${workflowDefinition.id}/runs`, {
        method: "POST",
        headers: { ...jsonHeaders, "idempotency-key": "direct:run-workflow:1" },
        body: JSON.stringify({ value: 1 }),
      });
      expect(replayedCancel.status).toBe(204);
      expect(replayedStart.status).toBe(202);
      expect(((await replayedStart.json()) as { id: string }).id).toBe(firstRunId);
      expect(secondDaemon.triggers.activeTriggerCount(dynamicWorkflow.id)).toBe(1);
      const replayedRegistration = await fetch(`${base}/v1/workflows`, {
        method: "POST",
        headers: { ...jsonHeaders, "idempotency-key": "direct:register-workflow:2" },
        body: JSON.stringify({ ...dynamicWorkflow, name: "Agent defined workflow v2" }),
      });
      expect(replayedRegistration.status).toBe(201);
      expect(await replayedRegistration.json()).toMatchObject({ id: dynamicWorkflow.id, revision: 2 });
      expect(secondDaemon.triggers.activeTriggerCount(dynamicWorkflow.id)).toBe(1);
      expect(secondDriver.cancels).toBe(0);
      expect(secondDaemon.store.listRuns()).toHaveLength(3);
      expect(secondDaemon.store.getRun(ambiguousRunId)?.cancelRequested).toBe(false);

      const recoveredAgentCancellation = await fetch(`${base}/v1/agents/${ambiguousAgentId}/cancel`, {
        method: "POST",
        headers: { ...jsonHeaders, "idempotency-key": "direct:ambiguous-cancel-agent" },
        body: "{}",
      });
      expect(recoveredAgentCancellation.status).toBe(204);
      await expect.poll(() => secondDaemon.agents.get(ambiguousAgentId).status).toBe("cancelled");
      expect(secondDriver.cancels).toBe(1);
      const duplicateRecoveredAgentCancellation = await fetch(`${base}/v1/agents/${ambiguousAgentId}/cancel`, {
        method: "POST",
        headers: { ...jsonHeaders, "idempotency-key": "direct:ambiguous-cancel-agent" },
        body: "{}",
      });
      expect(duplicateRecoveredAgentCancellation.status).toBe(204);
      expect(secondDriver.cancels).toBe(1);

      const ambiguousRetry = await fetch(`${base}/v1/runs/${ambiguousRunId}/cancel`, {
        method: "POST",
        headers: { ...jsonHeaders, "idempotency-key": "direct:ambiguous-cancel-run" },
        body: "{}",
      });
      expect(ambiguousRetry.status).toBe(200);
      const recoveredCancellation = await ambiguousRetry.json();
      expect(recoveredCancellation).toMatchObject({ id: ambiguousRunId, cancelRequested: true });
      await expect.poll(() => secondDaemon.store.getRun(ambiguousRunId)?.status).toBe("cancelled");
      expect(secondDriver.cancels).toBe(2);
      const duplicateRecoveredCancellation = await fetch(`${base}/v1/runs/${ambiguousRunId}/cancel`, {
        method: "POST",
        headers: { ...jsonHeaders, "idempotency-key": "direct:ambiguous-cancel-run" },
        body: "{}",
      });
      expect(duplicateRecoveredCancellation.status).toBe(200);
      expect(await duplicateRecoveredCancellation.json()).toEqual(recoveredCancellation);
      expect(secondDriver.cancels).toBe(2);
    } finally {
      await secondDaemon.close();
    }
  });
});
