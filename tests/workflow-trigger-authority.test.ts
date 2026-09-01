import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { PassiveObserver, AgentCoordinator, ModelRouter } from "../packages/runtime/src/index.js";
import { createStore, type SymphonyStore } from "../packages/storage/src/index.js";
import { TriggerManager, WorkflowCompiler, WorkflowEngine, parseWorkflowRunOrigin } from "../packages/workflow/src/index.js";
import { loadConfig, SecretStore, writeDefaultConfig } from "../packages/config/src/index.js";

const temporary: string[] = [];
const stores: SymphonyStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "symphony-workflow-trigger-authority-"));
  temporary.push(root);
  writeDefaultConfig(root);
  const loaded = loadConfig({ rootDirectory: root });
  const store = createStore(loaded.dataDirectory);
  stores.push(store);
  const drivers = new DriverRegistry();
  const secrets = new SecretStore("dev.symphony.workflow-trigger-authority");
  const coordinator = new AgentCoordinator(
    loaded,
    store,
    drivers,
    new ModelRouter(loaded, secrets, drivers, store),
    new PassiveObserver(loaded, secrets, store),
  );
  return { root, store, engine: new WorkflowEngine(loaded, store, coordinator) };
}

describe("workflow trigger authority", () => {
  it("keeps agent-authored cron schedules pending until explicitly approved", () => {
    const { root, store, engine } = fixture();
    const ir = new WorkflowCompiler().compile({
      id: "agent-authored-schedule",
      name: "Agent-authored schedule",
      mission: { statement: "Propose recurring work without activating it implicitly.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" },
      steps: [{ id: "value", type: "set", value: true }],
      triggers: [{ id: "nightly", type: "cron", expression: "0 0 1 1 *", input: {} }],
    }, 1);
    const triggers = new TriggerManager(store, engine);

    triggers.register(ir, { mode: "pending" });
    expect(triggers.pendingTriggerCount(ir.definition.id)).toBe(1);
    expect(triggers.activeTriggerCount(ir.definition.id)).toBe(0);
    triggers.activate();
    expect(store.listTriggerOccurrences()).toEqual([]);

    expect(triggers.approve(ir.definition.id)).toBe(true);
    expect(triggers.pendingTriggerCount(ir.definition.id)).toBe(0);
    expect(triggers.activeTriggerCount(ir.definition.id)).toBe(1);
    expect(triggers.approve(ir.definition.id)).toBe(false);
    triggers.stop();
  });

  it("fails closed when a legacy run would otherwise create agents with default permissions", async () => {
    const { root, store, engine } = fixture();
    const ir = new WorkflowCompiler().compile({
      id: "legacy-authority-run",
      name: "Legacy authority run",
      mission: { statement: "Do not resume a run without a durable authority receipt.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" },
      steps: [{
        id: "work",
        type: "agent",
        objective: "This agent must never inherit a mutable default authority.",
        harness: "codex",
        model: "fixture",
        outputSchema: {},
      }],
    }, 1);
    engine.register(ir);
    const now = new Date().toISOString();
    store.saveRun({
      id: "legacy-run",
      workflowId: ir.definition.id,
      workflowRevision: ir.revision,
      status: "interrupted",
      input: {},
      output: null,
      error: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      cancelRequested: false,
    });

    expect(() => engine.start(ir.definition.id, {}, { runId: "legacy-run" }))
      .toThrow("no immutable authority origin");
    await engine.recover();
    expect(store.getRun("legacy-run")).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("no immutable authority origin"),
    });
  });

  it("rejects malformed or privilege-escalating origin receipts", () => {
    expect(() => parseWorkflowRunOrigin({
      kind: "agent",
      threadId: null,
      parentRunId: null,
      parentAgentId: null,
      baseDepth: 0,
      permissionCeiling: "full-access",
    })).toThrow("parent run");
    expect(() => parseWorkflowRunOrigin({
      kind: "cron",
      threadId: null,
      parentRunId: null,
      parentAgentId: null,
      baseDepth: -1,
      permissionCeiling: "read-only",
    })).toThrow("full-access");
  });
});
