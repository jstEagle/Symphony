import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { AgentRecordSchema, nowIso } from "../packages/protocol/src/index.js";
import { TEST_DAEMON_SECRET } from "./setup.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function config(root: string, port: number): void {
  writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
    dataDirectory: ".symphony",
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
    conductor: { harness: "codex", model: "fixture" },
    agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access" },
    harnesses: { codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false }, opencode: { enabled: false }, pi: { enabled: false }, acp: [] },
    router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
    observer: { provider: "deterministic" },
    plugins: { watch: false },
    workflows: { triggersEnabled: false },
  }));
}

function saveAgent(daemon: Awaited<ReturnType<typeof startDaemon>>, id: string, runId: string, status: "completed" | "idle" | "waiting" = "completed"): void {
  const timestamp = nowIso();
  daemon.store.saveAgent(AgentRecordSchema.parse({
    id,
    logicalAgentId: `logical-${id}`,
    workflowId: `workflow-${runId}`,
    runId,
    parentAgentId: null,
    depth: 0,
    objective: "Exercise daemon platform authority.",
    missionHash: "platform-authority-hash",
    requestedHarness: "codex",
    requestedModel: "fixture",
    harness: "codex",
    model: "fixture",
    permissions: "full-access",
    status,
    nativeSessionId: null,
    nativeRunId: null,
    workspacePath: daemon.loaded.rootDirectory,
    output: { ok: true },
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: status === "completed" ? timestamp : null,
  }));
}

describe("daemon platform surfaces", () => {
  it("owns capability and message databases under dataDirectory and binds HTTP identity", async () => {
    process.env.SYMPHONY_DAEMON_SECRET = TEST_DAEMON_SECRET;
    const root = mkdtempSync(join(tmpdir(), "symphony-platform-surfaces-"));
    roots.push(root);
    const port = await freePort();
    config(root, port);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: new DriverRegistry(), credentialPlatform: "linux" });
    try {
      expect(daemon.capabilities.repository.path).toBe(join(root, ".symphony", "capabilities.sqlite"));
      expect(daemon.agentMessages.store.path).toBe(join(root, ".symphony", "agent-messages.sqlite"));
      const base = `http://127.0.0.1:${port}`;
      const capability = {
        capabilityId: "document.summarise",
        definition: { name: "Summary", description: "Summarise", parameters: { type: "object", properties: {}, additionalProperties: false } },
        provenance: { source: "test", actor: "forged" },
        actor: { type: "agent", id: "forged" },
        requestKey: "forged-body-key",
      };
      const created = await fetch(`${base}/v1/capabilities`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "capability-header-key" },
        body: JSON.stringify(capability),
      });
      expect(created.status).toBe(201);
      expect((await created.json() as { version: { capabilityId: string } }).version.capabilityId).toBe("document.summarise");
      const message = await fetch(`${base}/v1/agent-messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "message-header-key" },
        body: JSON.stringify({ ...messageInput("local-user"), requestKey: "forged-message-key" }),
      });
      expect(message.status).toBe(201);
      expect((await message.json() as { message: { requestKey: string } }).message.requestKey).toBe("message-header-key");
    } finally {
      await daemon.close();
      expect(daemon.capabilities.repository.database.isOpen).toBe(false);
      expect(daemon.agentMessages.store.database.isOpen).toBe(false);
    }
  });

  it("keeps agent messages scoped to self/lineage/objective and exposes redacted diagnostics", async () => {
    process.env.SYMPHONY_DAEMON_SECRET = TEST_DAEMON_SECRET;
    const root = mkdtempSync(join(tmpdir(), "symphony-platform-authority-"));
    roots.push(root);
    const port = await freePort();
    config(root, port);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: new DriverRegistry(), credentialPlatform: "linux" });
    try {
      saveAgent(daemon, "platform-agent-a", "platform-run-a");
      saveAgent(daemon, "platform-agent-b", "platform-run-b");
      const base = `http://127.0.0.1:${port}`;
      const agentA = { "x-symphony-agent-id": "platform-agent-a", "x-symphony-agent-token": daemon.agents.tokenFor("platform-agent-a") };
      const agentB = { "x-symphony-agent-id": "platform-agent-b", "x-symphony-agent-token": daemon.agents.tokenFor("platform-agent-b") };
      const appended = await fetch(`${base}/v1/agent-messages`, { method: "POST", headers: { ...agentA, "content-type": "application/json", "idempotency-key": "scoped-message-key" }, body: JSON.stringify(messageInput("platform-agent-a")) });
      expect(appended.status).toBe(201);
      const messageId = (await appended.json() as { message: { id: string } }).message.id;
      const forbidden = await fetch(`${base}/v1/agent-messages/${encodeURIComponent(messageId)}`, { headers: agentB });
      expect(forbidden.status).toBe(403);
      const allowed = await fetch(`${base}/v1/agent-messages/${encodeURIComponent(messageId)}`, { headers: agentA });
      expect(allowed.status).toBe(200);
      const projection = await fetch(`${base}/v1/agent-messages/projection`);
      expect(projection.status).toBe(200);
      const projected = await projection.json() as { actorId: string | null; messageCursor: number; receiptCursor: number; inbox: Array<{ message: { id: string }; receipts: unknown[] }>; outbox: unknown[] };
      expect(projected).toMatchObject({ actorId: null, messageCursor: 1, receiptCursor: 0 });
      expect(projected.inbox).toHaveLength(1);
      expect(projected.inbox[0]?.message.id).toBe(messageId);
      const reply = await fetch(`${base}/v1/agent-messages/${encodeURIComponent(messageId)}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "reply-header-key" },
        body: JSON.stringify({ summary: "Reply from the operator", actor: { type: "agent", id: "forged" }, requestKey: "forged-reply-key" }),
      });
      expect(reply.status).toBe(200);
      const replyProjection = await reply.json() as { message: { senderId: string; recipientId: string; replyToId: string | null; correlationId: string | null; requestKey: string } };
      expect(replyProjection.message).toMatchObject({ senderId: "local-user", recipientId: "platform-agent-a", replyToId: messageId, correlationId: messageId, requestKey: "reply-header-key" });
      const projectedAfterReply = await (await fetch(`${base}/v1/agent-messages/projection`)).json() as { inbox: unknown[]; outbox: Array<{ message: { senderId: string } }> };
      expect(projectedAfterReply.inbox).toHaveLength(1);
      expect(projectedAfterReply.outbox).toHaveLength(1);
      const diagnostics = await fetch(`${base}/v1/agents/platform-agent-a/diagnostics`);
      expect(diagnostics.status).toBe(200);
      const bundle = await diagnostics.json() as { identity: { agentId: string }; environment: Record<string, unknown>; contentHash: string };
      expect(bundle.identity.agentId).toBe("platform-agent-a");
      expect(bundle.environment).toEqual({});
      expect(bundle.contentHash).toMatch(/^[a-f0-9]{64}$/u);
      const exported = await fetch(`${base}/v1/agents/platform-agent-a/diagnostics/export`);
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-disposition")).toContain("attachment");

      saveAgent(daemon, "platform-agent-idle", "platform-run-idle", "idle");
      const idleDiagnostics = await fetch(`${base}/v1/agents/platform-agent-idle/diagnostics`, {
        headers: { "x-symphony-agent-id": "platform-agent-idle", "x-symphony-agent-token": daemon.agents.tokenFor("platform-agent-idle") },
      });
      expect(idleDiagnostics.status).toBe(200);
      expect(await idleDiagnostics.json()).toMatchObject({
        termination: "unknown",
        liveness: { state: "unknown" },
      });
    } finally {
      await daemon.close();
    }
  });
});

function messageInput(senderId: string) {
  return {
    version: 1,
    kind: "finding",
    senderId,
    recipientId: senderId,
    parentId: null,
    parentAgentId: null,
    objectiveId: null,
    runId: senderId === "local-user" ? null : `platform-run-${senderId.endsWith("a") ? "a" : "b"}`,
    attemptId: null,
    correlationId: null,
    replyToId: null,
    payload: { claim: "semantic result" },
    summary: "A semantic result",
    artifactRefs: [],
    evidenceRefs: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: null,
  };
}
