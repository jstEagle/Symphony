import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, SecretStore, writeDefaultConfig } from "../packages/config/src/index.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { capabilities, emit, makeSession } from "../packages/drivers/src/common.js";
import { AgentRecordSchema, type DriverDoctorResult, type DriverEvent, type DriverSession, type DriverStartRequest, type ModelDescriptor, type WorkerDriver } from "../packages/protocol/src/index.js";
import { AgentCoordinator, ModelRouter, PassiveObserver } from "../packages/runtime/src/index.js";
import { createStore } from "../packages/storage/src/index.js";
import { WorkflowCompiler, WorkflowEngine } from "../packages/workflow/src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

class FakeDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities();
  private reviews = 0;

  async doctor(): Promise<DriverDoctorResult> {
    return { driver: this.id, available: true, authenticated: true, version: "fake", capabilities: this.capabilities, detail: "fixture" };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: "fixture", harness: this.id, name: "Fixture", description: "Deterministic test model", modalities: ["text"], structuredOutput: true, pricing: { inputPerMillion: 1, outputPerMillion: 2 }, metadata: {} }];
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const output = request.workOrder.objective.includes("Review")
      ? { score: ++this.reviews === 1 ? 4 : 9 }
      : { changed: true };
    setTimeout(() => {
      emit(onEvent, "usage.recorded", { usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });
      emit(onEvent, "output.completed", { structuredOutput: output });
      emit(onEvent, "run.completed", { status: "finished" });
    }, 2);
    return makeSession(this.id, `native-${request.agentId}`);
  }

  async resume(session: DriverSession): Promise<DriverSession> { return session; }
  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> { return { receiptId: "receipt", queued: false }; }
  async cancel(): Promise<void> {}
}

class MissingOutputDriver extends FakeDriver {
  override async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    setTimeout(() => emit(onEvent, "run.completed", { status: "finished-without-output" }), 2);
    return makeSession(this.id, `native-${request.agentId}`);
  }
}

describe("agent graph and workflow execution", () => {
  it("attributes OpenRouter observer usage to the observed agent and global totals", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-observer-cost-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.observer.provider = "openrouter";
    loaded.config.observer.cache = false;
    const store = createStore(loaded.dataDirectory);
    const agent = AgentRecordSchema.parse({
      id: "observer-target",
      logicalAgentId: "logical-target",
      workflowId: "workflow-observer",
      runId: "run-observer",
      parentAgentId: null,
      depth: 0,
      objective: "Summarize this work.",
      missionHash: "12345678",
      requestedHarness: "codex",
      requestedModel: "fixture",
      harness: "codex",
      model: "fixture",
      permissions: "read-only",
      status: "running",
      nativeSessionId: "native-target",
      nativeRunId: "native-run",
      workspacePath: root,
      output: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });
    store.saveAgent(agent);
    store.appendEvent({
      type: "driver.tool.completed",
      workflowId: agent.workflowId,
      runId: agent.runId,
      agentId: agent.id,
      occurredAt: new Date().toISOString(),
      payload: { name: "fixture" },
      provenance: { source: "driver", driver: "codex" },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ summary: "The fixture operation completed." }) } }],
      usage: { prompt_tokens: 120, completion_tokens: 12, cost: 0.0015 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const secrets = { get: () => "test-openrouter-key" } as unknown as SecretStore;
      const observation = await new PassiveObserver(loaded, secrets, store).observe(agent, "tldr");
      expect(observation).toMatchObject({ generatedBy: "model", costAmount: 0.0015 });
      expect(store.aggregateCost({ agentId: agent.id })).toMatchObject({
        knownTotal: 0.0015,
        unknownEvents: 0,
        eventCount: 1,
        byBasis: { "provider-reported": 0.0015 },
      });
      expect(store.recentEvents({ limit: 10 }).some((event) => event.type === "observer.usage.recorded")).toBe(true);
    } finally {
      fetchMock.mockRestore();
      store.close();
    }
  });

  it("allows unlimited nesting and concurrency when both agent limits are disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-unlimited-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.agents.maxDepth = null;
    loaded.config.agents.maxConcurrent = null;
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );

    const agent = await coordinator.create({
      workflowId: "unlimited",
      runId: "unlimited-run",
      parentAgentId: null,
      depth: 100,
      mission: { id: "unlimited", revision: 1, hash: "12345678", statement: "Allow an explicitly unbounded graph.", keyResults: [] },
      objective: "Build the requested feature.",
      harness: "codex",
      model: "fixture",
      outputSchema: {
        type: "object",
        properties: { changed: { type: "boolean" } },
        required: ["changed"],
        additionalProperties: false,
      },
      workspace: { path: root, dirtyPolicy: "local-only" },
    });

    expect(agent.depth).toBe(100);
    await new Promise<void>((resolvePromise) => {
      const stop = store.onEvent((event) => {
        if (event.agentId === agent.id && event.type === "driver.run.completed") {
          stop();
          resolvePromise();
        }
      });
    });
    store.close();
  });

  it("runs a schema-gated review loop until the score reaches the objective", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-runtime-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.router.baseUrl = "http://127.0.0.1:1";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const router = new ModelRouter(loaded, new SecretStore("dev.symphony.tests"), drivers, store);
    const observer = new PassiveObserver(loaded, new SecretStore("dev.symphony.tests"), store);
    const coordinator = new AgentCoordinator(loaded, store, drivers, router, observer);
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const ir = new WorkflowCompiler().compile({
      id: "quality-loop",
      name: "Quality loop",
      mission: { statement: "Build the feature until independent review passes.", keyResults: ["Review score is at least eight."] },
      workspace: { path: root, dirtyPolicy: "local-only" },
      output: "steps.review",
      steps: [{
        id: "quality",
        type: "while",
        condition: { path: "steps.review.score", op: "lt", value: 8, default: 0 },
        maxIterations: 3,
        steps: [
          { id: "build", type: "agent", objective: "Build the requested feature and verify it.", harness: "codex", model: "fixture", outputSchema: { type: "object", properties: { changed: { type: "boolean" } }, required: ["changed"], additionalProperties: false } },
          { id: "review", type: "agent", objective: "Review the implementation and return a score.", harness: "codex", model: "fixture", permissions: "read-only", outputSchema: { type: "object", properties: { score: { type: "number", minimum: 0, maximum: 10 } }, required: ["score"], additionalProperties: false } },
        ],
      }],
    }, 1);
    engine.register(ir);
    const run = await engine.run(ir.definition.id, {});
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ score: 9 });
    expect(store.listStepAttempts(run.id).filter((attempt) => attempt.stepId === "review" && attempt.status === "completed")).toHaveLength(2);
    const reviews = coordinator.list({ runId: run.id }).filter((agent) => agent.objective.includes("Review"));
    expect(reviews).toHaveLength(2);
    expect(reviews.every((agent) => agent.permissions === "read-only")).toBe(true);
    expect(store.aggregateCost({ runId: run.id })).toMatchObject({
      knownTotal: 12,
      unknownEvents: 0,
      byBasis: { "token-priced-estimate": 12 },
    });
    store.close();
  });

  it("fails closed when native output violates the requested schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-schema-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.router.baseUrl = "http://127.0.0.1:1";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(loaded, store, drivers, new ModelRouter(loaded, secrets, drivers, store), new PassiveObserver(loaded, secrets, store));
    const agent = await coordinator.create({
      workflowId: "w", runId: "r", depth: 0,
      mission: { id: "w", revision: 1, hash: "12345678", statement: "Return a strict score." },
      objective: "Build something, but the schema expects a score.", harness: "codex", model: "fixture",
      outputSchema: { type: "object", properties: { score: { type: "number" } }, required: ["score"], additionalProperties: false },
      workspace: { path: root },
    });
    const final = await new Promise<ReturnType<AgentCoordinator["get"]>>((resolvePromise) => {
      const stop = store.onEvent((event) => {
        if (event.agentId === agent.id && event.type === "driver.run.completed") { stop(); resolvePromise(coordinator.get(agent.id)); }
      });
    });
    expect(final.status).toBe("failed");
    expect(final.error).toContain("Output schema validation failed");
    store.close();
  });

  it("fails closed when a native run completes without a schema-valid output", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-missing-output-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new MissingOutputDriver());
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const agent = await coordinator.create({
      workflowId: "missing-output",
      runId: "run-missing-output",
      parentAgentId: null,
      depth: 0,
      mission: { id: "missing-output", revision: 1, hash: "12345678", statement: "Require a real structured result.", keyResults: [] },
      objective: "Return the required result.",
      harness: "codex",
      model: "fixture",
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
      workspace: { path: root, dirtyPolicy: "local-only" },
    });
    const final = await new Promise<ReturnType<AgentCoordinator["get"]>>((resolvePromise) => {
      const stop = store.onEvent((event) => {
        if (event.agentId === agent.id && event.type === "agent.failed") {
          stop();
          resolvePromise(coordinator.get(agent.id));
        }
      });
    });
    expect(final.status).toBe("failed");
    expect(final.error).toContain("Output schema validation failed");
    store.close();
  });
});
