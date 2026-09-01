import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, type SymphonyDaemon } from "../apps/daemon/src/index.js";
import { SecretStore } from "../packages/config/src/index.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import {
  ObjectiveCheckpointRecordSchema,
  ObjectivePortableCheckpointRecordSchema,
  ObjectiveRunRecordSchema,
  type ObjectiveCheckpointRecord,
} from "../packages/protocol/src/index.js";
import { createStore } from "../packages/storage/src/index.js";

const now = "2026-09-01T00:00:00.000Z";
const daemons: SymphonyDaemon[] = [];

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function run(runId = "portable-run", objectiveId = "portable-objective") {
  return ObjectiveRunRecordSchema.parse({
    version: 1,
    runId,
    objectiveId,
    workflowId: "portable-workflow",
    workflowRevision: 3,
    workflowHash: "portable-workflow-hash",
    conductorAgentId: null,
    spec: { id: objectiveId, statement: "Portable recovery", criteria: [], approvalPolicy: { mode: "never" }, maxReplans: 0 },
    state: "planning",
    activePlanRevision: 0,
    latestCheckpointId: null,
    pendingApprovalId: null,
    replanCount: 0,
    tasks: [],
    context: {},
    output: null,
    error: null,
    requestKey: `${runId}-request`,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  });
}

function portableCheckpoint(overrides: Partial<ObjectiveCheckpointRecord> = {}): ObjectiveCheckpointRecord {
  return ObjectiveCheckpointRecordSchema.parse({
    version: 1,
    id: "portable-checkpoint-1",
    runId: "portable-run",
    objectiveId: "portable-objective",
    sequence: 1,
    planRevision: 0,
    eventCursor: 2,
    context: { phase: "saved" },
    taskStates: {},
    criteria: [],
    contextHash: "portable-context-hash",
    reason: "Durable boundary",
    createdBy: { type: "system", id: "portable-test" },
    requestKey: "portable-checkpoint-request-1",
    createdAt: now,
    objectiveRevision: 1,
    workflowRevision: 3,
    workflowHash: "portable-workflow-hash",
    controlPlanRevision: null,
    controlPlanHash: null,
    flatExecution: { state: "planning", context: { phase: "saved" }, tasks: [], outputs: {} },
    treeExecution: null,
    outputs: {},
    attemptHighWater: 2,
    eventHighWater: 2,
    artifactHashes: [],
    workspaceEvidence: {
      canonicalGrant: null,
      git: { repo: null, ref: null, commit: null, dirty: null, patchHash: null, worktree: null },
      dirty: null,
      patchHash: null,
      worktree: null,
    },
    nativeSessions: [],
    continuity: { status: "unknown", capabilities: [], reason: "No retained native session" },
    unresolvedExternalOperations: [],
    policySnapshotHash: null,
    configSnapshotHash: "0123456789abcdef0123456789abcdef",
    provenance: {
      source: "recovery",
      actor: { type: "system", id: "portable-test" },
      capturedAt: now,
      evidenceEventIds: [],
      parentCheckpointId: null,
      baseCheckpointId: null,
    },
    ...overrides,
  });
}

describe("portable objective checkpoints", () => {
  afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.close();
  });

  it("keeps legacy rows readable while retaining the complete portable boundary across restart", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-portable-checkpoint-"));
    try {
      const path = join(root, "store");
      const first = createStore(path);
      first.saveObjectiveRun(run());
      first.appendObjectiveCheckpoint(portableCheckpoint());
      const legacy = ObjectiveCheckpointRecordSchema.parse({
        version: 1,
        id: "legacy-checkpoint",
        runId: "portable-run",
        objectiveId: "portable-objective",
        sequence: 2,
        planRevision: 0,
        eventCursor: 2,
        context: {},
        taskStates: {},
        criteria: [],
        contextHash: "legacy-context-hash",
        reason: "Legacy boundary",
        createdBy: { type: "system", id: "legacy" },
        requestKey: "legacy-checkpoint-request",
        createdAt: now,
      });
      first.appendObjectiveCheckpoint(legacy);
      first.close();

      const restarted = createStore(path);
      const rows = restarted.listObjectiveCheckpoints("portable-run");
      expect(rows).toHaveLength(2);
      expect(ObjectivePortableCheckpointRecordSchema.safeParse(rows[0]).success).toBe(true);
      expect(ObjectivePortableCheckpointRecordSchema.safeParse(rows[1]).success).toBe(false);
      restarted.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects stale high-water and unprovable artifact lineage at the storage boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-portable-checkpoint-fence-"));
    try {
      const store = createStore(join(root, "store"));
      store.saveObjectiveRun(run());
      store.saveObjectiveRun(run("isolated-run", "isolated-objective"));
      store.appendObjectiveCheckpoint(portableCheckpoint());
      expect(() => store.appendObjectiveCheckpoint(portableCheckpoint({
        id: "cross-objective-checkpoint",
        runId: "isolated-run",
        objectiveId: "portable-objective",
        requestKey: "cross-objective-request",
      }))).toThrow(/identity/i);
      expect(() => store.appendObjectiveCheckpoint(portableCheckpoint({
        id: "portable-checkpoint-2",
        sequence: 2,
        requestKey: "portable-checkpoint-request-2",
        attemptHighWater: 1,
      }))).toThrow(/attempt high-water/i);
      expect(() => store.appendObjectiveCheckpoint(portableCheckpoint({
        id: "portable-checkpoint-2",
        sequence: 2,
        requestKey: "portable-checkpoint-request-2",
        artifactHashes: [{ id: "missing-artifact", hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }],
      }))).toThrow(/artifact lineage/i);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes honest command capabilities and forks a new occurrence from committed state", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-portable-checkpoint-api-"));
    const port = await availablePort();
    let daemon: SymphonyDaemon | undefined;
    try {
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
      const seeded = createStore(join(root, ".symphony"));
      seeded.saveObjectiveRun(run());
      seeded.appendObjectiveCheckpoint(portableCheckpoint());
      seeded.close();
      daemon = await startDaemon({
        rootDirectory: root,
        noPlugins: true,
        driverRegistry: new DriverRegistry(),
        secretStore: new SecretStore("dev.symphony.portable-checkpoint-api-test", {
          platform: "linux",
          environment: { SYMPHONY_DAEMON_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
          nativeBackend: null,
        }),
        credentialPlatform: "linux",
      });
      daemons.push(daemon);
      // Keep this API-focused fixture from racing the public request with the
      // event-driven supervisor. Supervisor behavior is covered separately.
      await daemon.objectiveSupervisor.stop();
      const base = `http://127.0.0.1:${port}`;
      const detail = await fetch(`${base}/v1/objectives/portable-run/checkpoints/portable-checkpoint-1`).then((response) => response.json()) as { portable: boolean; commands: { resume: boolean; retry: boolean; fork: boolean } };
      expect(detail).toMatchObject({ portable: true, commands: { resume: false, retry: true, fork: true } });
      const resume = await fetch(`${base}/v1/objectives/portable-run/checkpoints/portable-checkpoint-1/resume`, { method: "POST", headers: { "idempotency-key": "portable-resume-request" }, body: "{}" });
      expect(resume.status).toBe(409);
      const fork = await fetch(`${base}/v1/objectives/portable-run/checkpoints/portable-checkpoint-1/fork`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "portable-fork-request" }, body: JSON.stringify({ newRunId: "portable-fork-run", reason: "Try a committed alternative." }) });
      expect(fork.status).toBe(201);
      const forkResult = await fork.json() as { capability: string; newRunId: string; newCheckpointId: string | null };
      expect(forkResult).toMatchObject({ capability: "new-run-from-committed-state", newRunId: "portable-fork-run", newCheckpointId: expect.any(String) });
      expect(daemon.store.getObjectiveRunOccurrence("portable-fork-run")).toMatchObject({ forkedFromRunId: "portable-run", kind: "fork" });
    } finally {
      if (daemon) {
        const index = daemons.indexOf(daemon);
        if (index >= 0) daemons.splice(index, 1);
        await daemon.close();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
