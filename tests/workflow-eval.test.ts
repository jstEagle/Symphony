import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, SecretStore, writeDefaultConfig } from "../packages/config/src/index.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { capabilities, emit, makeSession } from "../packages/drivers/src/common.js";
import type {
  AgentRecord,
  DriverDoctorResult,
  DriverEvent,
  DriverSession,
  DriverStartRequest,
  ModelDescriptor,
  WorkerDriver,
} from "../packages/protocol/src/index.js";
import { AgentCoordinator, ModelRouter, PassiveObserver } from "../packages/runtime/src/index.js";
import { createStore, type SymphonyStore } from "../packages/storage/src/index.js";
import { WorkflowCompiler, WorkflowEngine } from "../packages/workflow/src/index.js";

const temporary: string[] = [];
const stores: SymphonyStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * One deterministic native-turn fixture. The first review is deliberately
 * below the quality threshold; a second review is good enough. The fixture
 * has no policy-specific success shortcut: each native start is one bounded
 * turn and the caller decides whether another turn is needed.
 */
class EvaluationDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities();
  readonly starts: string[] = [];
  private reviewCount = 0;

  async doctor(): Promise<DriverDoctorResult> {
    return {
      driver: this.id,
      available: true,
      authenticated: true,
      version: "fixture",
      capabilities: this.capabilities,
      detail: "Deterministic orchestration-evaluation fixture",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{
      id: "fixture",
      harness: this.id,
      name: "Deterministic fixture",
      description: "One bounded native turn with fixed usage",
      modalities: ["text"],
      structuredOutput: true,
      pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      metadata: {},
    }];
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.starts.push(request.agentId);
    const objective = request.workOrder.objective;
    const output = objective.includes("[review]")
      ? { score: ++this.reviewCount === 1 ? 4 : 9 }
      : { changed: true };

    setTimeout(() => {
      emit(onEvent, "usage.recorded", { usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }, `usage-${request.agentId}`);
      emit(onEvent, "output.completed", { structuredOutput: output }, `output-${request.agentId}`);
      emit(onEvent, "run.completed", { status: "finished" }, `run-${request.agentId}`);
    }, 2);
    return makeSession(this.id, `native-${request.agentId}`);
  }

  async resume(session: DriverSession): Promise<DriverSession> {
    return session;
  }

  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> {
    return { receiptId: "unused", queued: false };
  }

  async cancel(): Promise<void> {}
}

type EvaluationMetrics = {
  arm: "dynamic" | "static" | "single-native";
  success: boolean;
  score: number;
  attempts: number;
  nativeTurns: number;
  duplicateDispatches: number;
  costUsd: number;
  unknownCostEvents: number;
  interventions: number;
};

function evaluationDefinition(id: string, dynamic: boolean, root: string): unknown {
  const build = {
    id: "build",
    type: "agent" as const,
    objective: "Build the requested feature and verify it.",
    harness: "codex" as const,
    model: "fixture",
    outputSchema: {
      type: "object",
      properties: { changed: { type: "boolean" } },
      required: ["changed"],
      additionalProperties: false,
    },
  };
  const review = {
    id: "review",
    type: "agent" as const,
    objective: "[review] Independently review the implementation and return a score.",
    harness: "codex" as const,
    model: "fixture",
    permissions: "read-only" as const,
    outputSchema: {
      type: "object",
      properties: { score: { type: "number", minimum: 0, maximum: 10 } },
      required: ["score"],
      additionalProperties: false,
    },
  };

  return {
    id,
    name: `${dynamic ? "Dynamic" : "Fixed one-pass"} review evaluation`,
    mission: {
      statement: "Build the feature until independent review reaches eight.",
      keyResults: ["Review score is at least eight."],
    },
    workspace: { path: root, dirtyPolicy: "local-only" },
    output: "steps.review",
    steps: dynamic
      ? [{
          id: "quality",
          type: "while",
          condition: { path: "steps.review.score", op: "lt", value: 8, default: 0 },
          maxIterations: 3,
          steps: [build, review],
        }]
      : [build, review],
  };
}

function fixture(root: string, driver: EvaluationDriver) {
  writeDefaultConfig(root);
  const loaded = loadConfig({ rootDirectory: root });
  loaded.config.router.provider = "neutral-lexical";
  loaded.config.router.baseUrl = "http://127.0.0.1:1";
  loaded.config.observer.provider = "deterministic";
  const store = createStore(loaded.dataDirectory);
  stores.push(store);
  const drivers = new DriverRegistry();
  drivers.register(driver);
  const secrets = new SecretStore("dev.symphony.workflow-eval");
  const coordinator = new AgentCoordinator(
    loaded,
    store,
    drivers,
    new ModelRouter(loaded, secrets, drivers, store),
    new PassiveObserver(loaded, secrets, store),
  );
  return { coordinator, store, engine: new WorkflowEngine(loaded, store, coordinator) };
}

function metricFields(
  arm: EvaluationMetrics["arm"],
  score: number,
  attempts: number,
  runId: string,
  driver: EvaluationDriver,
  store: SymphonyStore,
): EvaluationMetrics {
  const events = store.eventsAfter(0, { runId, limit: 10_000 });
  const cost = store.aggregateCost({ runId }) as { knownTotal: number; unknownEvents: number };
  const interventions = events.filter((event) =>
    event.type.startsWith("agent.message.") || event.type.startsWith("agent.cancel.") || event.type === "agent.interrupted",
  ).length;
  return {
    arm,
    success: score >= 8,
    score,
    attempts,
    nativeTurns: driver.starts.length,
    duplicateDispatches: driver.starts.length - new Set(driver.starts).size,
    costUsd: cost.knownTotal,
    unknownCostEvents: cost.unknownEvents,
    interventions,
  };
}

async function runWorkflowArm(
  arm: "dynamic" | "static",
  dynamic: boolean,
): Promise<EvaluationMetrics> {
  const root = mkdtempSync(join(tmpdir(), `symphony-eval-${arm}-`));
  temporary.push(root);
  const driver = new EvaluationDriver();
  const { engine, store } = fixture(root, driver);
  const ir = new WorkflowCompiler().compile(evaluationDefinition(`workflow-eval-${arm}`, dynamic, root), 1);
  engine.register(ir);
  const run = await engine.run(ir.definition.id, {});
  const score = Number((run.output as { score?: number } | null)?.score ?? 0);
  const attempts = store.listStepAttempts(run.id).filter((attempt) =>
    ["build", "review"].includes(attempt.stepId) && attempt.status === "completed",
  ).length;
  return metricFields(arm, score, attempts, run.id, driver, store);
}

async function runSingleNativeArm(): Promise<EvaluationMetrics> {
  const root = mkdtempSync(join(tmpdir(), "symphony-eval-single-native-"));
  temporary.push(root);
  const driver = new EvaluationDriver();
  const { coordinator, store } = fixture(root, driver);
  const agent = await coordinator.create({
    id: "single-native-equivalent",
    workflowId: "workflow-eval-single-native",
    runId: "run-eval-single-native",
    parentAgentId: null,
    depth: 0,
    mission: {
      id: "workflow-eval-single-native",
      revision: 1,
      hash: "workflow-eval-single-native-hash",
      statement: "Build the feature until independent review reaches eight.",
      keyResults: ["Review score is at least eight."],
    },
    objective: "[review] Build and review the requested feature in one native turn.",
    harness: "codex",
    model: "fixture",
    permissions: "read-only",
    outputSchema: {
      type: "object",
      properties: { score: { type: "number", minimum: 0, maximum: 10 } },
      required: ["score"],
      additionalProperties: false,
    },
    workspace: { path: root, dirtyPolicy: "local-only" },
    inputs: [],
    metadata: {},
  });
  await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("completed"));
  const final = coordinator.get(agent.id) as AgentRecord;
  const score = Number((final.output as { score?: number } | null)?.score ?? 0);
  return metricFields("single-native", score, 1, agent.runId, driver, store);
}

describe("deterministic orchestration evaluation", () => {
  it("compares dynamic, fixed, and single-native review execution", async () => {
    const dynamic = await runWorkflowArm("dynamic", true);
    const fixed = await runWorkflowArm("static", false);
    const single = await runSingleNativeArm();
    const results = [dynamic, fixed, single];

    expect(dynamic).toMatchObject({
      arm: "dynamic",
      success: true,
      score: 9,
      attempts: 4,
      nativeTurns: 4,
      duplicateDispatches: 0,
      costUsd: 12,
      unknownCostEvents: 0,
      interventions: 0,
    });
    expect(fixed).toMatchObject({
      arm: "static",
      success: false,
      score: 4,
      attempts: 2,
      nativeTurns: 2,
      duplicateDispatches: 0,
      costUsd: 6,
      unknownCostEvents: 0,
      interventions: 0,
    });
    expect(single).toMatchObject({
      arm: "single-native",
      success: false,
      score: 4,
      attempts: 1,
      nativeTurns: 1,
      duplicateDispatches: 0,
      costUsd: 3,
      unknownCostEvents: 0,
      interventions: 0,
    });

    // Keep the evaluation's evidence fields explicit so a future suite cannot
    // accidentally collapse unknown cost or manual intervention into success.
    for (const result of results) {
      expect(result).toEqual(expect.objectContaining({
        costUsd: expect.any(Number),
        unknownCostEvents: expect.any(Number),
        interventions: expect.any(Number),
      }));
    }
  });
});
