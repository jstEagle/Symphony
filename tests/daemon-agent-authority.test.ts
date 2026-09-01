import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { AgentRecordSchema, nowIso } from "../packages/protocol/src/index.js";

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

function saveAgent(
  daemon: Awaited<ReturnType<typeof startDaemon>>,
  input: { id: string; parentAgentId: string | null; runId: string; workspacePath: string; permissions?: "read-only" | "full-access" },
): void {
  const timestamp = nowIso();
  daemon.store.saveAgent(AgentRecordSchema.parse({
    id: input.id,
    logicalAgentId: `logical-${input.id}`,
    workflowId: `workflow-${input.runId}`,
    runId: input.runId,
    parentAgentId: input.parentAgentId,
    depth: input.parentAgentId ? 1 : 0,
    objective: "Exercise authenticated coordination authority.",
    missionHash: "authority-hash",
    requestedHarness: "codex",
    requestedModel: "fixture",
    harness: "codex",
    model: "fixture",
    permissions: input.permissions ?? "full-access",
    status: "completed",
    nativeSessionId: null,
    nativeRunId: null,
    workspacePath: input.workspacePath,
    output: { ok: true },
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
  }));
}

describe("daemon agent authority", () => {
  it("keeps authenticated message, observe, and cancel operations inside one root run tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-agent-authority-"));
    temporary.push(root);
    const port = await availablePort();
    writeTestConfig(root, port);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: new DriverRegistry() });
    try {
      saveAgent(daemon, { id: "lineage-root", parentAgentId: null, runId: "lineage-run", workspacePath: root });
      saveAgent(daemon, { id: "lineage-caller", parentAgentId: "lineage-root", runId: "lineage-run", workspacePath: root });
      saveAgent(daemon, { id: "lineage-sibling", parentAgentId: "lineage-root", runId: "lineage-run", workspacePath: root });
      saveAgent(daemon, { id: "unrelated-root", parentAgentId: null, runId: "unrelated-run", workspacePath: root });
      const timestamp = nowIso();
      daemon.store.saveRun({
        id: "lineage-run",
        workflowId: "lineage-workflow",
        workflowRevision: 1,
        status: "completed",
        input: {},
        output: { ok: true },
        error: null,
        startedAt: timestamp,
        updatedAt: timestamp,
        finishedAt: timestamp,
        cancelRequested: false,
        origin: {
          kind: "agent",
          threadId: null,
          parentRunId: null,
          parentAgentId: "lineage-root",
          baseDepth: 0,
          permissionCeiling: "full-access",
        },
      });
      daemon.store.saveRun({
        id: "unrelated-run",
        workflowId: "unrelated-workflow",
        workflowRevision: 1,
        status: "completed",
        input: {},
        output: { ok: true },
        error: null,
        startedAt: timestamp,
        updatedAt: timestamp,
        finishedAt: timestamp,
        cancelRequested: false,
        origin: {
          kind: "agent",
          threadId: null,
          parentRunId: null,
          parentAgentId: "unrelated-root",
          baseDepth: 0,
          permissionCeiling: "full-access",
        },
      });
      const base = `http://127.0.0.1:${port}`;
      const agentHeaders = {
        "x-symphony-agent-id": "lineage-caller",
        "x-symphony-agent-token": daemon.agents.tokenFor("lineage-caller"),
      };

      const siblingTranscript = await fetch(`${base}/v1/agents/lineage-sibling/messages`, { headers: agentHeaders });
      expect(siblingTranscript.status).toBe(200);
      const siblingObservation = await fetch(`${base}/v1/agents/lineage-sibling/observe`, { headers: agentHeaders });
      expect(siblingObservation.status).toBe(200);
      const siblingCancellation = await fetch(`${base}/v1/agents/lineage-sibling/cancel`, {
        method: "POST",
        headers: { ...agentHeaders, "idempotency-key": "authority-cancel-sibling" },
        body: "{}",
      });
      expect(siblingCancellation.status).toBe(204);

      const lineageEvents = await fetch(`${base}/v1/runs/lineage-run/events`, { headers: agentHeaders });
      expect(lineageEvents.status).toBe(200);
      const lineageCancellation = await fetch(`${base}/v1/runs/lineage-run/cancel`, {
        method: "POST",
        headers: { ...agentHeaders, "idempotency-key": "authority-cancel-lineage-run" },
        body: "{}",
      });
      expect(lineageCancellation.status).toBe(200);

      const unrelatedTranscript = await fetch(`${base}/v1/agents/unrelated-root/messages`, { headers: agentHeaders });
      expect(unrelatedTranscript.status).toBe(403);
      const unrelatedObservation = await fetch(`${base}/v1/agents/unrelated-root/observe`, { headers: agentHeaders });
      expect(unrelatedObservation.status).toBe(403);
      const unrelatedCancellation = await fetch(`${base}/v1/agents/unrelated-root/cancel`, {
        method: "POST",
        headers: { ...agentHeaders, "idempotency-key": "authority-cancel-unrelated" },
        body: "{}",
      });
      expect(unrelatedCancellation.status).toBe(403);
      const unrelatedEvents = await fetch(`${base}/v1/runs/unrelated-run/events`, { headers: agentHeaders });
      expect(unrelatedEvents.status).toBe(403);
      const unrelatedRunCancellation = await fetch(`${base}/v1/runs/unrelated-run/cancel`, {
        method: "POST",
        headers: { ...agentHeaders, "idempotency-key": "authority-cancel-unrelated-run" },
        body: "{}",
      });
      expect(unrelatedRunCancellation.status).toBe(403);

      // User control remains intentionally broader than a native agent token.
      const userTranscript = await fetch(`${base}/v1/agents/unrelated-root/messages`);
      expect(userTranscript.status).toBe(200);
    } finally {
      await daemon.close();
    }
  });

  it("canonicalizes child workspace grants and rejects traversal, siblings, and symlink escapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-workspace-grant-"));
    temporary.push(root);
    const parent = join(root, "parent");
    const nested = join(parent, "nested");
    const sibling = join(root, "sibling");
    const outside = join(root, "outside");
    mkdirSync(nested, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(parent, "escape"), "dir");
    const port = await availablePort();
    writeTestConfig(root, port);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: new DriverRegistry() });
    try {
      saveAgent(daemon, { id: "workspace-parent", parentAgentId: null, runId: "workspace-run", workspacePath: parent });
      daemon.store.setMetadata("work-order:workspace-parent", {
        workflowId: "workspace-workflow",
        runId: "workspace-run",
        parentAgentId: null,
        depth: 0,
        mission: { id: "workspace-mission", revision: 1, hash: "workspace-hash", statement: "Keep child work inside the grant.", keyResults: [] },
        objective: "Coordinate child workspace grants.",
        model: "auto",
        harness: "auto",
        permissions: "full-access",
        outputSchema: {},
        workspace: { path: parent, dirtyPolicy: "local-only" },
        inputs: [],
        metadata: {},
      });
      const base = `http://127.0.0.1:${port}`;
      const headers = {
        "content-type": "application/json",
        "x-symphony-agent-id": "workspace-parent",
        "x-symphony-agent-token": daemon.agents.tokenFor("workspace-parent"),
      };
      const create = (idempotencyKey: string, workspacePath: string) => fetch(`${base}/v1/agents`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": idempotencyKey },
        body: JSON.stringify({
          objective: "Work inside the inherited grant.",
          model: "auto",
          harness: "auto",
          outputSchema: {},
          workspace: { path: workspacePath, dirtyPolicy: "local-only" },
        }),
      });

      const valid = await create("workspace-valid-child", "nested");
      expect(valid.status).toBe(202);
      expect((await valid.json()) as { workspacePath: string }).toMatchObject({ workspacePath: realpathSync.native(nested) });

      const traversal = await create("workspace-traversal", "../sibling");
      expect(traversal.status).toBe(403);
      await expect(traversal.json()).resolves.toEqual({ error: "Child workspace grants cannot contain parent traversal (..)." });

      const siblingGrant = await create("workspace-sibling", sibling);
      expect(siblingGrant.status).toBe(403);
      await expect(siblingGrant.json()).resolves.toEqual({ error: "Child workspace grant must be contained within the parent workspace grant." });

      const symlinkEscape = await create("workspace-symlink-escape", join(parent, "escape"));
      expect(symlinkEscape.status).toBe(403);
      await expect(symlinkEscape.json()).resolves.toEqual({ error: "Child workspace grant must be contained within the parent workspace grant." });
    } finally {
      await daemon.close();
    }
  });
});
