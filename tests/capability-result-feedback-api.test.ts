import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { withCapabilityResultFeedbackHash } from "../packages/protocol/src/index.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
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

function feedback(runId: string, idempotencyKey: string, result: Record<string, unknown>) {
  return withCapabilityResultFeedbackHash({
    version: 1,
    id: "feedback-api-1",
    objectiveId: "feedback-api-objective",
    runId,
    nodeId: "capability-node",
    attemptId: "attempt-1",
    capabilityAdmissionId: "admission-1",
    capabilityAdmissionHash: "a".repeat(64),
    agentId: null,
    nativeAgentId: null,
    nativeSessionId: null,
    nativeRunId: null,
    evidenceRefs: [{ kind: "event", id: "feedback-event-1", cursor: 1 }],
    charterCitation: null,
    idempotencyKey,
    createdAt: "2026-09-01T00:00:00.000Z",
    status: "received",
    result,
    summary: "A bounded capability result.",
  });
}

describe("daemon capability-result feedback API", () => {
  it("commits once, replays identically, conflicts on changed content, and projects the objective snapshot", async () => {
    process.env.SYMPHONY_DAEMON_SECRET = TEST_DAEMON_SECRET;
    const root = mkdtempSync(join(tmpdir(), "symphony-feedback-api-"));
    roots.push(root);
    const port = await freePort();
    config(root, port);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: new DriverRegistry(), credentialPlatform: "linux" });
    const base = `http://127.0.0.1:${port}`;
    try {
      const objective = await fetch(`${base}/v1/objectives`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "feedback-objective-key" },
        body: JSON.stringify({
          runId: "feedback-api-run",
          workflowId: "manual-feedback-api-objective",
          workflowRevision: 1,
          workflowHash: "manual-workflow-feedback-api-objective",
          spec: { id: "feedback-api-objective", statement: "Receive a result.", criteria: [], approvalPolicy: { mode: "never" }, maxReplans: 1 },
        }),
      });
      expect(objective.status).toBe(201);

      const requestKey = "feedback-submit-key";
      const record = feedback("feedback-api-run", requestKey, { ok: true });
      const submit = () => fetch(`${base}/v1/capability-result-feedback`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": requestKey },
        body: JSON.stringify(record),
      });
      const first = await submit();
      expect(first.status).toBe(201);
      expect(await first.json()).toMatchObject({ status: "committed", feedback: { id: record.id, idempotencyKey: requestKey } });
      const replay = await submit();
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ status: "replayed", feedback: { hash: record.hash } });

      const conflict = await fetch(`${base}/v1/capability-result-feedback`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": requestKey },
        body: JSON.stringify(feedback("feedback-api-run", requestKey, { ok: false })),
      });
      expect(conflict.status).toBe(409);

      const listed = await fetch(`${base}/v1/capability-result-feedback?objectiveId=feedback-api-objective`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ feedback: [{ id: record.id }], evaluations: [], decisions: [] });

      const objectiveFeedback = await fetch(`${base}/v1/objectives/feedback-api-objective/feedback`);
      expect(objectiveFeedback.status).toBe(200);
      expect(await objectiveFeedback.json()).toMatchObject({ objectiveId: "feedback-api-objective", feedback: [{ id: record.id }] });

      const snapshot = await fetch(`${base}/v1/objectives/feedback-api-objective/snapshot`);
      expect(snapshot.status).toBe(200);
      expect(await snapshot.json()).toMatchObject({
        capabilityResultFeedback: { objectiveId: "feedback-api-objective", feedback: [{ id: record.id }], evaluations: [], decisions: [] },
      });
    } finally {
      await daemon.close();
    }
  });
});
