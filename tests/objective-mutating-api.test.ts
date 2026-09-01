import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, type SymphonyDaemon } from "../apps/daemon/src/index.js";
import { SecretStore } from "../packages/config/src/index.js";
import { AgentRecordSchema, ObjectiveRunRecordSchema, nowIso, type ObjectiveRunRecord } from "../packages/protocol/src/index.js";
import { compileObjectiveControlPlan } from "../packages/workflow/src/objective-control-plan.js";
import { WorkflowCompiler } from "../packages/workflow/src/index.js";
import { TEST_DAEMON_SECRET } from "./setup.js";

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
    workflows: { triggersEnabled: false, maxLoopIterations: 7 },
  }));
}

function task(id: string, permissions?: "read-only" | "full-access") {
  return {
    id,
    objective: `Complete ${id}`,
    dependsOn: [],
    outputSchema: {},
    model: "fixture",
    harness: "auto" as const,
    inputs: [],
    ...(permissions ? { permissions } : {}),
    requiresApproval: false,
  };
}

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const objectiveId = typeof overrides.objectiveId === "string" ? overrides.objectiveId : "objective-api-objective";
  const slug = objectiveId.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 80) || "objective";
  return {
    runId: "objective-api-run",
    objectiveId,
    workflowId: `manual-${slug}`,
    workflowRevision: 1,
    workflowHash: `manual-workflow-${slug}`,
    spec: {
      id: objectiveId,
      statement: "Exercise the objective mutation boundary.",
      criteria: [],
      approvalPolicy: { mode: "never" },
      maxReplans: 2,
    },
    tasks: [],
    context: { fixture: true },
    ...overrides,
  };
}

function saveAgent(daemon: SymphonyDaemon, input: {
  id: string;
  runId: string;
  parentAgentId: string | null;
  permissions: "read-only" | "full-access";
  workspacePath: string;
  status?: "queued" | "routing" | "starting" | "running" | "idle" | "waiting" | "completed";
  workflowId?: string;
}): void {
  const timestamp = nowIso();
  daemon.store.saveAgent(AgentRecordSchema.parse({
    id: input.id,
    logicalAgentId: `logical-${input.id}`,
    workflowId: input.workflowId ?? "objective-api-workflow",
    runId: input.runId,
    parentAgentId: input.parentAgentId,
    depth: input.parentAgentId ? 1 : 0,
    objective: "Exercise objective mutation authority.",
    missionHash: "objective-api-mission-hash",
    requestedHarness: "codex",
    requestedModel: "fixture",
    harness: "codex",
    model: "fixture",
    permissions: input.permissions,
    status: input.status ?? "completed",
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

function saveWorkOrder(daemon: SymphonyDaemon, agentId: string, runId: string, workspacePath: string): void {
  daemon.store.setMetadata(`work-order:${agentId}`, {
    workflowId: "objective-api-workflow",
    runId,
    parentAgentId: null,
    depth: 0,
    mission: { id: "objective-api-mission", revision: 1, hash: "objective-api-mission-hash", statement: "Exercise objective workspace authority.", keyResults: [] },
    objective: "Coordinate objective workspace grants.",
    model: "fixture",
    harness: "codex",
    permissions: "full-access",
    outputSchema: {},
    workspace: { path: workspacePath, dirtyPolicy: "local-only" },
    inputs: [],
    metadata: {},
  });
}

function saveRun(daemon: SymphonyDaemon, overrides: Partial<ObjectiveRunRecord> = {}): ObjectiveRunRecord {
  const run = ObjectiveRunRecordSchema.parse({
    version: 1,
    runId: "objective-api-run",
    objectiveId: "objective-api-objective",
    workflowId: "objective-api-workflow",
    workflowRevision: 1,
    workflowHash: "objective-api-workflow-hash",
    conductorAgentId: "objective-api-root",
    spec: {
      id: "objective-api-objective",
      statement: "Exercise the objective mutation boundary.",
      criteria: [],
      approvalPolicy: { mode: "never" },
      maxReplans: 2,
    },
    state: "planning",
    activePlanRevision: 0,
    latestCheckpointId: null,
    pendingApprovalId: null,
    replanCount: 0,
    tasks: [],
    context: { fixture: true },
    output: null,
    error: null,
    requestKey: "objective-api-create",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  });
  daemon.store.saveObjectiveRun(run);
  return run;
}

function agentHeaders(daemon: SymphonyDaemon, id: string): Record<string, string> {
  return {
    "x-symphony-agent-id": id,
    "x-symphony-agent-token": daemon.agents.tokenFor(id),
  };
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
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

function testSecretStore(): SecretStore {
  return new SecretStore("dev.symphony.objective-mutating-api-test", {
    platform: "linux",
    environment: { SYMPHONY_DAEMON_SECRET: TEST_DAEMON_SECRET },
    nativeBackend: null,
  });
}

async function startFixture(): Promise<{ daemon: SymphonyDaemon; base: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "symphony-objective-mutation-api-"));
  temporary.push(root);
  const port = await availablePort();
  writeTestConfig(root, port);
  const daemon = await startDaemon({
    rootDirectory: root,
    noPlugins: true,
    secretStore: testSecretStore(),
    credentialPlatform: "linux",
  });
  return { daemon, base: `http://127.0.0.1:${port}`, root };
}

function jsonHeaders(idempotencyKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", "idempotency-key": idempotencyKey, ...extra };
}

describe("objective mutating API", () => {
  it("creates, appends a plan, checkpoints, requests approval, and survives a daemon restart", async () => {
    const first = await startFixture();
    const body = createBody();
    try {
      const createdResponse = await fetch(`${first.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("objective-create-1"),
        body: JSON.stringify(body),
      });
      expect(createdResponse.status).toBe(201);
      const created = await jsonResponse(createdResponse);
      expect(created).toMatchObject({ runId: "objective-api-run", state: "planning", activePlanRevision: 0 });

      const replayResponse = await fetch(`${first.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("objective-create-1"),
        body: JSON.stringify(body),
      });
      expect(replayResponse.status).toBe(201);
      expect(await jsonResponse(replayResponse)).toEqual(created);

      const conflictResponse = await fetch(`${first.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("objective-create-1"),
        body: JSON.stringify(createBody({ spec: { ...body.spec as Record<string, unknown>, statement: "Different intent." } })),
      });
      expect(conflictResponse.status).toBe(409);

      const planResponse = await fetch(`${first.base}/v1/objectives/objective-api-run/plans`, {
        method: "POST",
        headers: jsonHeaders("objective-plan-1"),
        body: JSON.stringify({ expectedPlanRevision: 0, tasks: [task("ship", "read-only")], reason: "Start the bounded plan." }),
      });
      expect(planResponse.status).toBe(200);
      expect(await jsonResponse(planResponse)).toMatchObject({ activePlanRevision: 1, tasks: [{ task: { id: "ship" } }] });

      const checkpointResponse = await fetch(`${first.base}/v1/objectives/objective-api-run/checkpoints`, {
        method: "POST",
        headers: jsonHeaders("objective-checkpoint-1"),
        body: JSON.stringify({
          eventCursor: 0,
          context: { fixture: true, checked: true },
          taskUpdates: [{ taskId: "ship", state: "running" }],
          reason: "The plan entered execution.",
        }),
      });
      expect(checkpointResponse.status).toBe(200);
      expect(await jsonResponse(checkpointResponse)).toMatchObject({ latestCheckpointId: expect.any(String), state: "executing" });

      const approvalBody = {
        kind: "plan",
        question: "Approve the bounded objective plan.",
        scope: { planRevision: 1 },
        operationId: "objective-api-plan-operation",
        requestHash: "objective-api-plan-request-hash",
        policyHash: created.policyHash,
        sideEffectClass: "local",
        canonicalTarget: "objective://objective-api-objective/plan/1",
        expiresAt: null,
      };
      const mismatchedApprovalResponse = await fetch(`${first.base}/v1/objectives/objective-api-run/approvals`, {
        method: "POST",
        headers: jsonHeaders("objective-approval-policy-mismatch"),
        body: JSON.stringify({ ...approvalBody, policyHash: "forged-objective-policy-hash" }),
      });
      expect(mismatchedApprovalResponse.status).toBe(409);

      const approvalResponse = await fetch(`${first.base}/v1/objectives/objective-api-run/approvals`, {
        method: "POST",
        headers: jsonHeaders("objective-approval-1"),
        body: JSON.stringify(approvalBody),
      });
      expect(approvalResponse.status).toBe(200);
      expect(await jsonResponse(approvalResponse)).toMatchObject({ state: "awaiting-approval", pendingApprovalId: expect.any(String) });
    } finally {
      await first.daemon.close();
    }

    const second = await startDaemon({
      rootDirectory: first.root,
      noPlugins: true,
      secretStore: testSecretStore(),
      credentialPlatform: "linux",
    });
    try {
      const detail = await fetchWithRetry(`${first.base}/v1/objectives/objective-api-run`).then(jsonResponse);
      expect(detail.run).toMatchObject({ runId: "objective-api-run", activePlanRevision: 1, state: "awaiting-approval" });
      expect(detail.planRevisions).toHaveLength(1);
      expect(detail.checkpoints).toHaveLength(1);
      expect(detail.approvals).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  it("allows a same-root agent, enforces its permission ceiling, and denies a foreign tree", async () => {
    const fixture = await startFixture();
    const run = saveRun(fixture.daemon);
    saveAgent(fixture.daemon, { id: "objective-api-root", runId: run.runId, parentAgentId: null, permissions: "full-access", workspacePath: fixture.root });
    saveAgent(fixture.daemon, { id: "objective-api-child", runId: run.runId, parentAgentId: "objective-api-root", permissions: "read-only", workspacePath: fixture.root });
    saveAgent(fixture.daemon, { id: "objective-api-foreign", runId: "foreign-run", parentAgentId: null, permissions: "full-access", workspacePath: fixture.root });
    try {
      const child = agentHeaders(fixture.daemon, "objective-api-child");
      const sameRoot = await fetch(`${fixture.base}/v1/objectives/${run.runId}/plans`, {
        method: "POST",
        headers: jsonHeaders("objective-child-plan-1", child),
        body: JSON.stringify({ expectedPlanRevision: 0, tasks: [task("inspect", "read-only")] }),
      });
      expect(sameRoot.status).toBe(200);

      const aboveCeiling = await fetch(`${fixture.base}/v1/objectives/${run.runId}/plans`, {
        method: "POST",
        headers: jsonHeaders("objective-child-plan-2", child),
        body: JSON.stringify({ expectedPlanRevision: 1, tasks: [task("write", "full-access")] }),
      });
      expect(aboveCeiling.status).toBe(403);

      const foreign = await fetch(`${fixture.base}/v1/objectives/${run.runId}/checkpoints`, {
        method: "POST",
        headers: jsonHeaders("objective-foreign-checkpoint", agentHeaders(fixture.daemon, "objective-api-foreign")),
        body: JSON.stringify({ eventCursor: 0, reason: "Foreign mutation must be denied." }),
      });
      expect(foreign.status).toBe(403);
    } finally {
      await fixture.daemon.close();
    }
  });

  it("binds approvals to immutable identity and settles expiry exactly once", async () => {
    const fixture = await startFixture();
    try {
      const createdResponse = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("objective-approval-create-1"),
        body: JSON.stringify(createBody()),
      });
      expect(createdResponse.status).toBe(201);
      const run = await jsonResponse(createdResponse);
      const runId = run.runId as string;
      const policyHash = run.policyHash as string;
      expect(policyHash).toEqual(expect.any(String));
      saveAgent(fixture.daemon, { id: "objective-api-root", runId, parentAgentId: null, permissions: "full-access", workspacePath: fixture.root });

      const approvalBody = {
        kind: "plan",
        question: "Approve this external operation?",
        scope: { target: "release" },
        operationId: "objective-api-operation-1",
        requestHash: "objective-api-request-hash-1",
        policyHash,
        sideEffectClass: "local",
        canonicalTarget: "repo://example/release",
        expiresAt: new Date(Date.now() + 50).toISOString(),
      };
      const userHeaders: Record<string, string> = {};
      const agentHeadersValue = agentHeaders(fixture.daemon, "objective-api-root");
      const mismatched = await fetch(`${fixture.base}/v1/objectives/${encodeURIComponent(runId)}/approvals`, {
        method: "POST",
        headers: jsonHeaders("objective-approval-policy-mismatch-1", userHeaders),
        body: JSON.stringify({ ...approvalBody, policyHash: "forged-objective-policy-hash" }),
      });
      expect(mismatched.status).toBe(409);

      const requested = await fetch(`${fixture.base}/v1/objectives/${encodeURIComponent(runId)}/approvals`, {
        method: "POST",
        headers: jsonHeaders("objective-approval-request-1", userHeaders),
        body: JSON.stringify(approvalBody),
      });
      expect(requested.status).toBe(200);
      const requestedBody = await jsonResponse(requested);
      expect(requestedBody).toMatchObject({ pendingApprovalId: expect.any(String), state: "awaiting-approval" });

      const conflict = await fetch(`${fixture.base}/v1/objectives/${encodeURIComponent(runId)}/approvals`, {
        method: "POST",
        headers: jsonHeaders("objective-approval-request-1", userHeaders),
        body: JSON.stringify({ ...approvalBody, canonicalTarget: "repo://example/other-release" }),
      });
      expect(conflict.status).toBe(409);

      const approvalId = requestedBody.pendingApprovalId as string;
      const agentResolve = await fetch(`${fixture.base}/v1/objectives/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        headers: jsonHeaders("objective-approval-agent-resolve-1", agentHeadersValue),
        body: JSON.stringify({ status: "expired" }),
      });
      expect(agentResolve.status).toBe(403);

      await new Promise((resolve) => setTimeout(resolve, 100));
      const resolveApproved = await fetch(`${fixture.base}/v1/objectives/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        headers: jsonHeaders("objective-approval-resolve-approved-1"),
        body: JSON.stringify({ status: "approved", decision: { approved: true } }),
      });
      expect(resolveApproved.status).toBe(409);

      const resolveRejected = await fetch(`${fixture.base}/v1/objectives/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        headers: jsonHeaders("objective-approval-resolve-rejected-1"),
        body: JSON.stringify({ status: "rejected", decision: { approved: false } }),
      });
      expect(resolveRejected.status).toBe(409);
      expect((await fixture.daemon.store.getObjectiveApproval(runId, approvalId))?.status).toBe("requested");

      const resolveExpired = await fetch(`${fixture.base}/v1/objectives/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        headers: jsonHeaders("objective-approval-resolve-expired-1"),
        body: JSON.stringify({ status: "expired", decision: { reason: "deadline elapsed" } }),
      });
      expect(resolveExpired.status).toBe(200);
      const resolvedBody = await jsonResponse(resolveExpired);
      expect(resolvedBody).toMatchObject({ runId, state: "failed", pendingApprovalId: null });
      expect((await fixture.daemon.store.getObjectiveApproval(runId, approvalId))?.status).toBe("expired");

      const replay = await fetch(`${fixture.base}/v1/objectives/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        headers: jsonHeaders("objective-approval-resolve-expired-1"),
        body: JSON.stringify({ status: "expired", decision: { reason: "deadline elapsed" } }),
      });
      expect(replay.status).toBe(200);
      expect(await jsonResponse(replay)).toEqual(resolvedBody);

      const conflictingReplay = await fetch(`${fixture.base}/v1/objectives/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        headers: jsonHeaders("objective-approval-resolve-expired-1"),
        body: JSON.stringify({ status: "approved" }),
      });
      expect(conflictingReplay.status).toBe(409);
    } finally {
      await fixture.daemon.close();
    }
  });

  it("contains authenticated objective task workspaces across create and replan", async () => {
    const fixture = await startFixture();
    const parent = join(fixture.root, "parent");
    const nested = join(parent, "nested");
    const sibling = join(fixture.root, "sibling");
    const outside = join(fixture.root, "outside");
    mkdirSync(nested, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(parent, "escape"), "dir");
    saveAgent(fixture.daemon, { id: "objective-workspace-agent", runId: "objective-workspace-agent-run", parentAgentId: null, permissions: "full-access", workspacePath: parent, status: "running" });
    saveWorkOrder(fixture.daemon, "objective-workspace-agent", "objective-workspace-agent-run", parent);
    const headers = agentHeaders(fixture.daemon, "objective-workspace-agent");
    const create = (key: string, workspacePath: string) => fetch(`${fixture.base}/v1/objectives`, {
      method: "POST",
      headers: jsonHeaders(key, headers),
      body: JSON.stringify(createBody({
        runId: "objective-workspace-valid-run",
        objectiveId: "objective-workspace-valid",
        tasks: [{ ...task("initial", "read-only"), workspace: { path: workspacePath, dirtyPolicy: "local-only" } }],
      })),
    });
    try {
      const valid = await create("objective-workspace-valid", "nested");
      expect(valid.status).toBe(201);
      const validRun = await jsonResponse(valid);
      expect((validRun.tasks as Array<{ task: { workspace?: { path: string } } }>)[0]?.task.workspace?.path).toBe(realpathSync.native(nested));

      const traversal = await create("objective-workspace-traversal", "../sibling");
      expect(traversal.status).toBe(403);
      expect(await jsonResponse(traversal)).toEqual({ error: "Child workspace grants cannot contain parent traversal (..)." });

      const absolute = await create("objective-workspace-absolute", sibling);
      expect(absolute.status).toBe(403);
      expect(await jsonResponse(absolute)).toEqual({ error: "Child workspace grant must be contained within the parent workspace grant." });

      const symlink = await create("objective-workspace-symlink", join(parent, "escape"));
      expect(symlink.status).toBe(403);
      expect(await jsonResponse(symlink)).toEqual({ error: "Child workspace grant must be contained within the parent workspace grant." });

      const plan = await fetch(`${fixture.base}/v1/objectives/objective-workspace-valid-run/plans`, {
        method: "POST",
        headers: jsonHeaders("objective-workspace-replan", headers),
        body: JSON.stringify({ expectedPlanRevision: 0, tasks: [{ ...task("replan", "read-only"), workspace: { path: sibling, dirtyPolicy: "local-only" } }] }),
      });
      expect(plan.status).toBe(403);
      expect(await jsonResponse(plan)).toEqual({ error: "Child workspace grant must be contained within the parent workspace grant." });
    } finally {
      await fixture.daemon.close();
    }
  });

  it("lets the local owner pin an objective workspace without allowing later replans to widen it", async () => {
    const fixture = await startFixture();
    const project = join(fixture.root, "project");
    const sibling = join(fixture.root, "sibling");
    mkdirSync(project, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    try {
      const create = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("objective-user-workspace-create"),
        body: JSON.stringify(createBody({
          runId: "objective-user-workspace-run",
          objectiveId: "objective-user-workspace",
          workspace: { path: project, dirtyPolicy: "local-only" },
        })),
      });
      expect(create.status).toBe(201);
      const plan = await fetch(`${fixture.base}/v1/objectives/objective-user-workspace-run/plans`, {
        method: "POST",
        headers: jsonHeaders("objective-user-workspace-replan"),
        body: JSON.stringify({ expectedPlanRevision: 0, tasks: [{ ...task("escape", "read-only"), workspace: { path: sibling, dirtyPolicy: "local-only" } }] }),
      });
      expect(plan.status).toBe(403);
      expect(await jsonResponse(plan)).toEqual({ error: "Child workspace grant must be contained within the parent workspace grant." });
    } finally {
      await fixture.daemon.close();
    }
  });

  it("pins local objective admission to stored workflow identity and rejects forged alternatives", async () => {
    const fixture = await startFixture();
    const storedWorkflow = {
      id: "registered-objective-workflow",
      revision: 2,
      mission: {},
      definition: {},
      ir: {},
      hash: "registered-objective-workflow-hash",
      createdAt: nowIso(),
    };
    fixture.daemon.store.saveWorkflow(storedWorkflow);
    try {
      const base = createBody({
        runId: "registered-objective-run",
        workflowId: storedWorkflow.id,
        workflowRevision: storedWorkflow.revision,
        workflowHash: storedWorkflow.hash,
      });
      const accepted = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("registered-objective-create"),
        body: JSON.stringify(base),
      });
      expect(accepted.status).toBe(201);

      const wrongHash = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("registered-objective-wrong-hash"),
        body: JSON.stringify({ ...base, runId: "registered-objective-wrong-hash-run", workflowHash: "forged-objective-workflow-hash" }),
      });
      expect(wrongHash.status).toBe(409);

      const wrongRevision = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("registered-objective-wrong-revision"),
        body: JSON.stringify({ ...base, runId: "registered-objective-wrong-revision-run", workflowRevision: 1 }),
      });
      expect(wrongRevision.status).toBe(409);
    } finally {
      await fixture.daemon.close();
    }
  });

  it("derives registered workflow control plans and rejects source-spoofed trees", async () => {
    const fixture = await startFixture();
    const workflow = new WorkflowCompiler().compile({
      id: "registered-control-workflow",
      name: "Registered control workflow",
      mission: { statement: "Admit only the saved control tree.", keyResults: [] },
      workspace: { path: fixture.root, dirtyPolicy: "local-only" },
      inputSchema: { type: "object", additionalProperties: true },
      output: "$",
      steps: [{
        id: "saved-loop",
        type: "while",
        condition: { path: "$.continue", op: "exists", default: false },
        steps: [{
          id: "saved-step",
          type: "agent",
          objective: "Run the saved control step.",
          model: "fixture",
          harness: "auto",
          permissions: "full-access",
          outputSchema: { type: "object", additionalProperties: true },
        }],
      }],
      triggers: [{ id: "manual", type: "manual" }],
    }, 3);
    fixture.daemon.store.saveWorkflow({
      id: workflow.definition.id,
      revision: workflow.revision,
      mission: workflow.mission,
      definition: workflow.definition,
      ir: workflow,
      hash: workflow.hash,
      createdAt: nowIso(),
    });
    const canonical = compileObjectiveControlPlan(workflow, { defaultMaxLoopIterations: 7 });
    expect(canonical.root).toMatchObject({ type: "sequence", steps: [{ type: "while", maxIterations: 7 }] });
    const forged = {
      ...canonical,
      root: {
        ...canonical.root,
        steps: [{
          id: "forged-step",
          sourceNodeId: "forged-step",
          sourcePath: "steps.0",
          dependsOn: [],
          type: "agent" as const,
          objective: "Forged full-access work.",
          model: "fixture",
          harness: "auto" as const,
          permissions: "full-access" as const,
          outputSchema: {},
          inputs: [],
          requiresApproval: false,
        }],
      },
    };
    try {
      const canonicalCreate = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("registered-control-canonical"),
        body: JSON.stringify(createBody({
          runId: "registered-control-canonical-run",
          objectiveId: "registered-control-canonical",
          workflowId: workflow.definition.id,
          workflowRevision: workflow.revision,
          workflowHash: workflow.hash,
          controlPlan: canonical,
        })),
      });
      expect(canonicalCreate.status).toBe(201);
      expect(fixture.daemon.store.getObjectiveRun("registered-control-canonical-run")).toBeTruthy();

      const restrictedCreate = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("registered-control-restricted"),
        body: JSON.stringify(createBody({
          runId: "registered-control-restricted-run",
          objectiveId: "registered-control-restricted",
          workflowId: workflow.definition.id,
          workflowRevision: workflow.revision,
          workflowHash: workflow.hash,
          policy: { effectivePermission: "read-only" },
          controlPlan: canonical,
        })),
      });
      expect(restrictedCreate.status).toBe(403);
      expect(fixture.daemon.store.getObjectiveRun("registered-control-restricted-run")).toBeNull();

      const forgedCreate = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("registered-control-forged"),
        body: JSON.stringify(createBody({
          runId: "registered-control-forged-run",
          objectiveId: "registered-control-forged",
          workflowId: workflow.definition.id,
          workflowRevision: workflow.revision,
          workflowHash: workflow.hash,
          controlPlan: forged,
        })),
      });
      expect(forgedCreate.status).toBe(409);
      expect(await jsonResponse(forgedCreate)).toEqual({
        error: "Workflow-backed control plans must equal the daemon-derived immutable workflow plan.",
      });
      expect(fixture.daemon.store.getObjectiveRun("registered-control-forged-run")).toBeNull();

      const wrongRevision = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("registered-control-revision-mismatch"),
        body: JSON.stringify(createBody({
          runId: "registered-control-revision-mismatch-run",
          objectiveId: "registered-control-revision-mismatch",
          workflowId: workflow.definition.id,
          workflowRevision: 2,
          workflowHash: workflow.hash,
          controlPlan: canonical,
        })),
      });
      expect(wrongRevision.status).toBe(409);
      expect(fixture.daemon.store.getObjectiveRun("registered-control-revision-mismatch-run")).toBeNull();
    } finally {
      await fixture.daemon.close();
    }
  });

  it("binds conductor-authored control plans to the attached conductor identity", async () => {
    const fixture = await startFixture();
    const workflowId = "manual-conductor-authored";
    const conductorId = "objective-control-conductor";
    saveAgent(fixture.daemon, {
      id: conductorId,
      runId: "conductor-authored-run",
      parentAgentId: null,
      permissions: "full-access",
      workspacePath: fixture.root,
      status: "running",
      workflowId,
    });
    const sourcePlan = compileObjectiveControlPlan({
      id: workflowId,
      name: "Conductor-authored objective",
      mission: { statement: "Use the attached conductor.", keyResults: [] },
      workspace: { path: fixture.root, dirtyPolicy: "local-only" },
      steps: [{ id: "initial", type: "set", value: { initial: true } }],
      triggers: [{ id: "manual", type: "manual" }],
    }, { planId: "conductor-authored-plan" });
    const conductorPlan = {
      ...sourcePlan,
      source: { kind: "conductor-authored" as const, authorAgentId: conductorId, sessionId: null },
    };
    try {
      const accepted = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("conductor-control-accepted"),
        body: JSON.stringify(createBody({
          runId: "conductor-authored-run",
          objectiveId: "conductor-authored",
          workflowId,
          workflowRevision: 1,
          workflowHash: "manual-workflow-conductor-authored",
          conductorAgentId: conductorId,
          controlPlan: conductorPlan,
        })),
      });
      expect(accepted.status).toBe(201);

      const spoofed = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("conductor-control-spoofed"),
        body: JSON.stringify(createBody({
          runId: "conductor-authored-spoofed-run",
          // Keep the standalone workflow identity coherent so the request
          // reaches the control-plan author binding rather than failing an
          // unrelated workflow/objective identity check first.
          objectiveId: "conductor-authored",
          workflowId,
          workflowRevision: 1,
          workflowHash: "manual-workflow-conductor-authored",
          conductorAgentId: conductorId,
          controlPlan: {
            ...conductorPlan,
            id: "spoofed-conductor-plan",
            source: { ...conductorPlan.source, authorAgentId: "forged-conductor" },
          },
        })),
      });
      expect(spoofed.status).toBe(403);
      expect(fixture.daemon.store.getObjectiveRun("conductor-authored-spoofed-run")).toBeNull();
    } finally {
      await fixture.daemon.close();
    }
  });

  it("requires objective/spec identity, the explicit standalone rule, and an eligible conductor", async () => {
    const fixture = await startFixture();
    const sibling = join(fixture.root, "foreign-project");
    mkdirSync(sibling, { recursive: true });
    try {
      const mismatchedBody = createBody();
      mismatchedBody.objectiveId = "different-objective-id";
      const mismatch = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("objective-spec-mismatch"),
        body: JSON.stringify(mismatchedBody),
      });
      expect(mismatch.status).toBe(400);

      const omittedObjectiveId = createBody({ runId: "objective-spec-omitted-id-run", objectiveId: "objective-spec-omitted-id" });
      delete omittedObjectiveId.objectiveId;
      const normalized = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("objective-spec-omitted-id"),
        body: JSON.stringify(omittedObjectiveId),
      });
      expect(normalized.status).toBe(201);
      expect(await jsonResponse(normalized)).toMatchObject({ objectiveId: "objective-spec-omitted-id", spec: { id: "objective-spec-omitted-id" } });

      const forgedStandalone = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("objective-forged-standalone"),
        body: JSON.stringify(createBody({ workflowId: "manual-not-the-objective", workflowHash: "manual-workflow-not-the-objective" })),
      });
      expect(forgedStandalone.status).toBe(409);

      saveAgent(fixture.daemon, {
        id: "foreign-objective-conductor",
        runId: "foreign-objective-conductor-run",
        parentAgentId: null,
        permissions: "full-access",
        workspacePath: sibling,
        status: "running",
      });
      const foreignConductor = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("objective-foreign-conductor"),
        body: JSON.stringify(createBody({
          runId: "objective-foreign-conductor-run",
          workspace: { path: fixture.root, dirtyPolicy: "local-only" },
          conductorAgentId: "foreign-objective-conductor",
        })),
      });
      expect(foreignConductor.status).toBe(403);

      const standalone = await fetch(`${fixture.base}/v1/objectives`, {
        method: "POST",
        headers: jsonHeaders("objective-explicit-standalone"),
        body: JSON.stringify(createBody({ runId: "objective-explicit-standalone-run" })),
      });
      expect(standalone.status).toBe(201);
    } finally {
      await fixture.daemon.close();
    }
  });
});
