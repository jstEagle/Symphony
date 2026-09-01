import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { AgentRecordSchema, nowIso } from "../packages/protocol/src/index.js";
import { WorkflowCompiler } from "../packages/workflow/src/index.js";

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

describe("workflow run authority", () => {
  it("derives linked run origin from the authenticated agent and rejects depth overflow", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-workflow-run-authority-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      conductor: { harness: "codex", model: "fixture" },
      agents: { maxDepth: 2, maxConcurrent: null, defaultPermissions: "full-access" },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
      workflows: { triggersEnabled: false },
    }));
    const daemon = await startDaemon({
      rootDirectory: root,
      noPlugins: true,
      driverRegistry: new DriverRegistry(),
    });
    const base = `http://127.0.0.1:${port}`;
    const timestamp = nowIso();
    const saveParent = (id: string, depth: number) => daemon.store.saveAgent(AgentRecordSchema.parse({
      id,
      logicalAgentId: `logical-${id}`,
      workflowId: "chat:authority-thread",
      runId: "chat-run:authority-thread",
      parentAgentId: depth === 0 ? null : "root-parent",
      depth,
      objective: "Run a linked dynamic workflow.",
      missionHash: "12345678",
      requestedHarness: "codex",
      requestedModel: "fixture",
      harness: "codex",
      model: "fixture",
      permissions: "full-access",
      status: "running",
      nativeSessionId: `native-${id}`,
      nativeRunId: `native-run-${id}`,
      workspacePath: root,
      output: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      finishedAt: null,
    }));
    saveParent("root-parent", 0);
    saveParent("workflow-parent", 1);
    saveParent("depth-limit-parent", 2);
    const ir = new WorkflowCompiler().compile({
      id: "linked-authority",
      name: "Linked authority",
      mission: { statement: "Retain the initiating agent's authority and lineage.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" },
      output: "steps.result",
      steps: [{ id: "result", type: "set", value: { ok: true } }],
    }, 1);
    daemon.workflows.register(ir);

    const response = await fetch(`${base}/v1/workflows/${ir.definition.id}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "linked-authority-run",
        "x-symphony-agent-id": "workflow-parent",
        "x-symphony-agent-token": daemon.agents.tokenFor("workflow-parent"),
      },
      body: JSON.stringify({
        objective: "input remains ordinary workflow data",
        origin: { kind: "user", parentAgentId: null, baseDepth: -1 },
      }),
    });
    expect(response.status).toBe(202);
    const run = await response.json() as { id: string; origin: Record<string, unknown>; input: Record<string, unknown> };
    expect(run.origin).toEqual({
      kind: "agent",
      threadId: "authority-thread",
      parentRunId: "chat-run:authority-thread",
      parentAgentId: "workflow-parent",
      baseDepth: 1,
      permissionCeiling: "full-access",
    });
    expect(run.input.origin).toEqual({ kind: "user", parentAgentId: null, baseDepth: -1 });
    await vi.waitFor(() => expect(daemon.store.getRun(run.id)?.status).toBe("completed"));

    const rejected = await fetch(`${base}/v1/workflows/${ir.definition.id}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "depth-overflow-run",
        "x-symphony-agent-id": "depth-limit-parent",
        "x-symphony-agent-token": daemon.agents.tokenFor("depth-limit-parent"),
      },
      body: JSON.stringify({}),
    });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toEqual({ error: "Maximum agent depth 2 exceeded." });
    expect(daemon.store.listRuns().filter((candidate) => candidate.workflowId === ir.definition.id)).toHaveLength(1);
    await daemon.close();
  });
});
