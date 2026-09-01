import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, SecretStore, writeDefaultConfig } from "../packages/config/src/index.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { ModelRouter, PassiveObserver, AgentCoordinator } from "../packages/runtime/src/index.js";
import { createStore } from "../packages/storage/src/index.js";
import { WorkflowCompiler, WorkflowEngine, compileObjectiveControlPlan, type WorkflowDefinition } from "../packages/workflow/src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function definition(source: string): WorkflowDefinition {
  return {
    id: "fanout-workflow",
    name: "Fanout workflow",
    mission: { statement: "Exercise dynamic map compilation.", keyResults: [] },
    workspace: { path: "/tmp/fanout-workflow" },
    inputSchema: { type: "object" },
    output: "steps",
    steps: [{
      id: "map-items",
      type: "fanout",
      source,
      concurrency: null,
      aggregation: { mode: "array" },
      itemTemplate: {
        id: "item-worker",
        type: "agent",
        objective: "Process the current fanout item.",
        harness: "auto",
        model: "auto",
        outputSchema: { type: "object" },
      },
    }],
    triggers: [{ id: "manual", type: "manual" }],
  };
}

describe("workflow fanout schema and compiler", () => {
  it("pins the source path and item template without materializing executions", () => {
    const ir = new WorkflowCompiler().compile(definition("steps.items"), 2);
    expect(ir.stepIds).toEqual(["map-items"]);
    const plan = compileObjectiveControlPlan(ir);
    const map = plan.root.steps[0];
    expect(map).toMatchObject({
      id: "map-items",
      type: "fanout",
      source: "steps.items",
      concurrency: null,
      aggregation: { mode: "array" },
      itemTemplate: { id: "item-worker", type: "agent", sourcePath: "steps.0.itemTemplate" },
    });
  });

  it("rejects ambiguous source paths before a workflow is admitted", () => {
    expect(() => new WorkflowCompiler().compile(definition(" steps.items"), 1)).toThrow(/surrounding whitespace/);
  });
});

describe("workflow fanout runtime", () => {
  it("maps runtime input items with durable per-item attempts and stable keys", async () => {
    const root = mkdtempSync(`${tmpdir()}/symphony-fanout-runtime-`);
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, new SecretStore("dev.symphony.tests"), drivers, store),
      new PassiveObserver(loaded, new SecretStore("dev.symphony.tests"), store),
    );
    const ir = new WorkflowCompiler().compile({
      id: "fanout-runtime",
      name: "Fanout runtime",
      mission: { statement: "Process every input item durably.", keyResults: [] },
      workspace: { path: root },
      output: "steps.map",
      steps: [{
        id: "map",
        type: "fanout",
        source: "input.items",
        concurrency: 2,
        aggregation: { mode: "array" },
        itemTemplate: { id: "item", type: "set", value: "{{item.id}}/{{itemIndex}}/{{itemKey}}" },
      }],
      triggers: [{ id: "manual", type: "manual" }],
    }, 1);
    const engine = new WorkflowEngine(loaded, store, coordinator);
    engine.register(ir);

    const run = await engine.run(ir.definition.id, { items: [{ id: "a" }, { id: "b" }, { id: "a" }] }, { runId: "fanout-runtime-run" });

    expect(run).toMatchObject({ status: "completed", output: ["a/0/a", "b/1/b", "a/2/a#2"] });
    const attempts = store.listStepAttempts(run.id);
    expect(attempts.filter((attempt) => attempt.stepId === "item")).toHaveLength(3);
    expect(attempts.filter((attempt) => attempt.stepId === "item").map((attempt) => attempt.iterationKey).sort()).toEqual([
      "root/map/item/a%232:",
      "root/map/item/a:",
      "root/map/item/b:",
    ]);
    expect(attempts.every((attempt) => attempt.status === "completed")).toBe(true);
    store.close();
  });

  it("reduces object and merge fanout results deterministically", async () => {
    const root = mkdtempSync(`${tmpdir()}/symphony-fanout-reduce-`);
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, new SecretStore("dev.symphony.tests"), drivers, store),
      new PassiveObserver(loaded, new SecretStore("dev.symphony.tests"), store),
    );
    const compiler = new WorkflowCompiler();
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const definitionFor = (id: string, aggregation: { mode: "object" | "merge"; keyPath?: string }) => ({
      id,
      name: id,
      mission: { statement: "Reduce fanout outputs.", keyResults: [] },
      workspace: { path: root },
      output: "steps.map",
      steps: [{
        id: "map",
        type: "fanout" as const,
        source: "input.items",
        aggregation,
        itemTemplate: {
          id: "item",
          type: "set" as const,
          value: aggregation.mode === "merge" ? { "{{item.id}}": "{{item.value}}" } : "{{item.value}}",
        },
      }],
      triggers: [{ id: "manual", type: "manual" as const }],
    });
    const objectIr = compiler.compile(definitionFor("fanout-object", { mode: "object", keyPath: "id" }), 1);
    engine.register(objectIr);
    const objectRun = await engine.run(objectIr.definition.id, { items: [{ id: "first", value: 1 }, { id: "second", value: 2 }] }, { runId: "fanout-object-run" });
    expect(objectRun.output).toEqual({ first: "1", second: "2" });

    const mergeIr = compiler.compile(definitionFor("fanout-merge", { mode: "merge" }), 1);
    engine.register(mergeIr);
    const mergeRun = await engine.run(mergeIr.definition.id, { items: [{ id: "first", value: 1 }, { id: "second", value: 2 }] }, { runId: "fanout-merge-run" });
    expect(mergeRun.output).toEqual({ first: "1", second: "2" });
    store.close();
  });
});
