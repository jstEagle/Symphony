import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { SecretStore } from "../packages/config/src/index.js";
import { nowIso } from "../packages/protocol/src/index.js";
import { createStore } from "../packages/storage/src/index.js";
import { TEST_DAEMON_SECRET } from "./setup.js";

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

async function postWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw lastError;
}

function config(root: string, port: number): void {
  writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
    dataDirectory: ".symphony",
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
    workflows: { triggersEnabled: true },
    harnesses: {
      codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
      opencode: { enabled: false }, pi: { enabled: false }, acp: [],
    },
    router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
    observer: { provider: "deterministic" },
    plugins: { watch: false },
  }));
}

function seedFullAccessAgent(root: string): void {
  const store = createStore(join(root, ".symphony"));
  const timestamp = nowIso();
  store.saveAgent({
    id: "workflow-author",
    logicalAgentId: "workflow-author",
    workflowId: "author-workflow",
    runId: "author-run",
    parentAgentId: null,
    depth: 0,
    objective: "Propose a workflow schedule.",
    missionHash: "mission-hash-1",
    requestedHarness: "codex",
    requestedModel: "fixture",
    harness: "codex",
    model: "fixture",
    permissions: "full-access",
    status: "completed",
    nativeSessionId: null,
    nativeRunId: null,
    workspacePath: root,
    output: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
  });
  store.close();
}

function testSecretStore(): SecretStore {
  return new SecretStore("dev.symphony.daemon-workflow-trigger-policy", {
    platform: "linux",
    environment: { SYMPHONY_DAEMON_SECRET: TEST_DAEMON_SECRET },
    nativeBackend: null,
  });
}

function scheduledDefinition(id: string, expression = "* * * * * *") {
  return {
    id,
    name: id,
    mission: { statement: "Run the scheduled objective.", keyResults: [] },
    workspace: { path: process.cwd(), dirtyPolicy: "local-only" as const },
    steps: [{ id: "value", type: "set" as const, value: true }],
    triggers: [{ id: "schedule", type: "cron" as const, expression, input: {} }],
  };
}

describe("daemon workflow trigger activation policy", () => {
  it("keeps agent-authored schedules pending across restart and allows user schedules to run", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-trigger-policy-daemon-"));
    temporary.push(root);
    const port = await availablePort();
    config(root, port);
    seedFullAccessAgent(root);
    const first = await startDaemon({ rootDirectory: root, noPlugins: true, secretStore: testSecretStore(), credentialPlatform: "linux" });
    const auth = {
      "idempotency-key": "agent-register-scheduled",
      "x-symphony-agent-id": "workflow-author",
      "x-symphony-agent-token": first.agents.tokenFor("workflow-author"),
      "content-type": "application/json",
    };
    try {
      const response = await postWithRetry(`http://127.0.0.1:${port}/v1/workflows`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(scheduledDefinition("agent-scheduled")),
      });
      expect(response.status).toBe(201);
      expect(first.triggers.isPending("agent-scheduled")).toBe(true);
      expect(first.triggers.activeTriggerCount("agent-scheduled")).toBe(0);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));
      expect(first.store.listTriggerOccurrences().filter((occurrence) => occurrence.workflowId === "agent-scheduled")).toEqual([]);
    } finally {
      await first.close();
    }

    const second = await startDaemon({ rootDirectory: root, noPlugins: true, secretStore: testSecretStore(), credentialPlatform: "linux" });
    try {
      expect(second.triggers.isPending("agent-scheduled")).toBe(true);
      expect(second.triggers.activeTriggerCount("agent-scheduled")).toBe(0);
      expect(second.store.listTriggerOccurrences().filter((occurrence) => occurrence.workflowId === "agent-scheduled")).toEqual([]);

      const activation = await postWithRetry(`http://127.0.0.1:${port}/v1/workflows/agent-scheduled/activate`, {
        method: "POST",
        headers: {
          "idempotency-key": "agent-activate-scheduled",
          "x-symphony-agent-id": "workflow-author",
          "x-symphony-agent-token": second.agents.tokenFor("workflow-author"),
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(activation.status).toBe(200);
      expect(second.triggers.isPending("agent-scheduled")).toBe(false);
      expect(second.triggers.activeTriggerCount("agent-scheduled")).toBe(1);

      const pause = await postWithRetry(`http://127.0.0.1:${port}/v1/workflows/agent-scheduled/deactivate`, {
        method: "POST",
        headers: {
          "idempotency-key": "agent-pause-scheduled",
          "x-symphony-agent-id": "workflow-author",
          "x-symphony-agent-token": second.agents.tokenFor("workflow-author"),
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(pause.status).toBe(200);
      expect(second.triggers.isPending("agent-scheduled")).toBe(false);
      expect(second.triggers.activeTriggerCount("agent-scheduled")).toBe(0);

      const resume = await postWithRetry(`http://127.0.0.1:${port}/v1/workflows/agent-scheduled/activate`, {
        method: "POST",
        headers: {
          "idempotency-key": "agent-resume-scheduled",
          "x-symphony-agent-id": "workflow-author",
          "x-symphony-agent-token": second.agents.tokenFor("workflow-author"),
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(resume.status).toBe(200);
      expect(second.triggers.activeTriggerCount("agent-scheduled")).toBe(1);

      const userBody = JSON.stringify(scheduledDefinition("user-scheduled", "0 0 1 1 *"));
      const userResponse = await postWithRetry(`http://127.0.0.1:${port}/v1/workflows`, {
        method: "POST",
        headers: { "idempotency-key": "user-register-scheduled", "content-type": "application/json", connection: "close" },
        body: userBody,
      });
      expect(userResponse.status).toBe(201);
      expect(second.triggers.isPending("user-scheduled")).toBe(false);
      expect(second.triggers.activeTriggerCount("user-scheduled")).toBe(1);

      const projection = await fetch(`http://127.0.0.1:${port}/v1/workflows`).then((response) => response.json()) as Array<{ id: string; triggerState: string }>;
      expect(projection.find((workflow) => workflow.id === "agent-scheduled")?.triggerState).toBe("active");
      expect(projection.find((workflow) => workflow.id === "user-scheduled")?.triggerState).toBe("active");
    } finally {
      await second.close();
    }
  });
});
