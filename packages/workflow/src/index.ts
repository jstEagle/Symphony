import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Cron } from "croner";
import { createJiti } from "jiti";
import { ulid } from "ulid";
import { z } from "zod";
import type { LoadedConfig } from "@symphony/config";
import {
  JsonValueSchema,
  PermissionSchema,
  RoutingIntentSchema,
  WorkspaceSpecSchema,
  nowIso,
  type AgentRecord,
  type JsonValue,
  type WorkflowMission,
} from "@symphony/protocol";
import { AgentCoordinator, idempotencyKey } from "@symphony/runtime";
import type { StepAttemptRecord, SymphonyStore, WorkflowRevisionRecord, WorkflowRunRecord } from "@symphony/storage";

const OutputSchema = z.record(z.string(), JsonValueSchema);
const CommonStepSchema = z.object({ id: z.string().min(1).regex(/^[a-zA-Z0-9_.-]+$/u) });

export type AgentStep = z.infer<typeof CommonStepSchema> & {
  type: "agent";
  objective: string;
  model?: string | undefined;
  harness?: "auto" | "codex" | "claude" | "cursor" | "opencode" | "pi" | "acp" | undefined;
  permissions?: "read-only" | "full-access" | undefined;
  outputSchema: Record<string, JsonValue>;
  routing?: z.infer<typeof RoutingIntentSchema> | undefined;
  workspace?: z.infer<typeof WorkspaceSpecSchema> | undefined;
};
export type SequenceStep = z.infer<typeof CommonStepSchema> & { type: "sequence"; steps: WorkflowStep[] };
export type ParallelStep = z.infer<typeof CommonStepSchema> & { type: "parallel"; steps: WorkflowStep[] };
export type WhileStep = z.infer<typeof CommonStepSchema> & {
  type: "while";
  condition: Condition;
  steps: WorkflowStep[];
  maxIterations?: number | undefined;
};
export type IfStep = z.infer<typeof CommonStepSchema> & { type: "if"; condition: Condition; then: WorkflowStep[]; else?: WorkflowStep[] | undefined };
export type SetStep = z.infer<typeof CommonStepSchema> & { type: "set"; value: JsonValue };
export type WorkflowStep = AgentStep | SequenceStep | ParallelStep | WhileStep | IfStep | SetStep;

export type Condition = {
  path: string;
  op: "exists" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  value?: JsonValue | undefined;
  default?: JsonValue | undefined;
};

const ConditionSchema: z.ZodType<Condition> = z.object({
  path: z.string().min(1),
  op: z.enum(["exists", "eq", "neq", "gt", "gte", "lt", "lte"]),
  value: JsonValueSchema.optional(),
  default: JsonValueSchema.optional(),
});

const WorkflowStepSchema: z.ZodType<WorkflowStep> = z.lazy(() => z.discriminatedUnion("type", [
  CommonStepSchema.extend({
    type: z.literal("agent"), objective: z.string().min(1), model: z.string().optional(),
    harness: z.enum(["auto", "codex", "claude", "cursor", "opencode", "pi", "acp"]).optional(),
    permissions: PermissionSchema.optional(), outputSchema: OutputSchema,
    routing: RoutingIntentSchema.optional(), workspace: WorkspaceSpecSchema.optional(),
  }),
  CommonStepSchema.extend({ type: z.literal("sequence"), steps: z.array(WorkflowStepSchema).min(1) }),
  CommonStepSchema.extend({ type: z.literal("parallel"), steps: z.array(WorkflowStepSchema).min(1) }),
  CommonStepSchema.extend({ type: z.literal("while"), condition: ConditionSchema, steps: z.array(WorkflowStepSchema).min(1), maxIterations: z.number().int().positive().optional() }),
  CommonStepSchema.extend({ type: z.literal("if"), condition: ConditionSchema, then: z.array(WorkflowStepSchema).min(1), else: z.array(WorkflowStepSchema).optional() }),
  CommonStepSchema.extend({ type: z.literal("set"), value: JsonValueSchema }),
]));

export const WorkflowDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mission: z.object({ statement: z.string().min(1), keyResults: z.array(z.string()).default([]) }),
  workspace: WorkspaceSpecSchema,
  inputSchema: OutputSchema.default({ type: "object", additionalProperties: true }),
  output: z.string().default("$"),
  steps: z.array(WorkflowStepSchema).min(1),
  triggers: z.array(z.discriminatedUnion("type", [
    z.object({ id: z.string(), type: z.literal("manual") }),
    z.object({ id: z.string(), type: z.literal("cron"), expression: z.string(), timezone: z.string().optional(), input: JsonValueSchema.default({}) }),
  ])).default([{ id: "manual", type: "manual" }]),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export type WorkflowIr = {
  definition: WorkflowDefinition;
  revision: number;
  hash: string;
  mission: WorkflowMission;
  stepIds: string[];
};

export function defineWorkflow<const T extends WorkflowDefinition>(definition: T): T {
  return WorkflowDefinitionSchema.parse(definition) as T;
}

export function agent(step: Omit<AgentStep, "type">): AgentStep {
  return { type: "agent", ...step };
}

export function sequence(id: string, ...steps: WorkflowStep[]): SequenceStep {
  return { id, type: "sequence", steps };
}

export function parallel(id: string, ...steps: WorkflowStep[]): ParallelStep {
  return { id, type: "parallel", steps };
}

export function whileLoop(id: string, condition: Condition, steps: WorkflowStep[], maxIterations?: number): WhileStep {
  return { id, type: "while", condition, steps, ...(maxIterations ? { maxIterations } : {}) };
}

export class WorkflowCompiler {
  compile(definitionInput: unknown, revision: number): WorkflowIr {
    const definition = WorkflowDefinitionSchema.parse(definitionInput);
    const ids: string[] = [];
    const visit = (steps: WorkflowStep[]): void => {
      for (const step of steps) {
        if (ids.includes(step.id)) throw new Error(`Duplicate workflow step id: ${step.id}`);
        ids.push(step.id);
        if (step.type === "sequence" || step.type === "parallel" || step.type === "while") visit(step.steps);
        if (step.type === "if") {
          visit(step.then);
          visit(step.else ?? []);
        }
      }
    };
    visit(definition.steps);
    const canonical = stableStringify(definition);
    const hash = createHash("sha256").update(canonical).digest("hex");
    return {
      definition,
      revision,
      hash,
      stepIds: ids,
      mission: { id: definition.id, revision, hash, statement: definition.mission.statement, keyResults: definition.mission.keyResults },
    };
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class WorkflowLoader {
  private readonly jiti = createJiti(pathToFileURL(resolve(process.cwd(), "symphony.workflow-loader.mjs")).href, {
    interopDefault: true,
    moduleCache: false,
  });

  constructor(private readonly compiler = new WorkflowCompiler()) {}

  async load(path: string, currentRevision = 0): Promise<WorkflowIr> {
    const extension = extname(path);
    let value: unknown;
    if (extension === ".json") value = JSON.parse(readFileSync(path, "utf8"));
    else if ([".ts", ".mts", ".js", ".mjs"].includes(extension)) value = await this.jiti.import(path, { default: true });
    else throw new Error(`Unsupported workflow file: ${path}`);
    return this.compiler.compile(value, currentRevision + 1);
  }

  discover(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(workflow\.)?(json|ts|mts|js|mjs)$/u.test(entry.name))
      .map((entry) => resolve(directory, entry.name));
  }
}

type ExecutionContext = { input: JsonValue; steps: Record<string, JsonValue>; iteration: Record<string, number> };

export class WorkflowEngine {
  private readonly running = new Map<string, Promise<WorkflowRunRecord>>();

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly store: SymphonyStore,
    private readonly agents: AgentCoordinator,
  ) {}

  register(ir: WorkflowIr): WorkflowRevisionRecord {
    const record: WorkflowRevisionRecord = {
      id: ir.definition.id, revision: ir.revision, mission: ir.mission as unknown as JsonValue,
      definition: ir.definition as unknown as JsonValue, ir: ir as unknown as JsonValue, hash: ir.hash, createdAt: nowIso(),
    };
    this.store.saveWorkflow(record);
    this.store.appendEvent({ type: "workflow.registered", workflowId: record.id, runId: null, agentId: null, occurredAt: nowIso(), payload: { revision: record.revision, hash: record.hash }, provenance: { source: "workflow" } });
    return record;
  }

  async run(workflowId: string, input: JsonValue = {}, options: { runId?: string } = {}): Promise<WorkflowRunRecord> {
    const record = this.start(workflowId, input, options);
    return this.running.get(record.id) as Promise<WorkflowRunRecord>;
  }

  start(workflowId: string, input: JsonValue = {}, options: { runId?: string } = {}): WorkflowRunRecord {
    const saved = this.store.getWorkflow(workflowId);
    if (!saved) throw new Error(`Workflow not found: ${workflowId}`);
    const ir = saved.ir as unknown as WorkflowIr;
    const runId = options.runId ?? ulid();
    const existing = this.store.getRun(runId);
    const now = nowIso();
    const record: WorkflowRunRecord = existing ?? {
      id: runId, workflowId, workflowRevision: saved.revision, status: "queued", input, output: null,
      error: null, startedAt: null, updatedAt: now, finishedAt: null, cancelRequested: false,
    };
    this.store.saveRun(record);
    if (!this.running.has(runId)) this.running.set(runId, this.execute(record, ir).finally(() => this.running.delete(runId)));
    return record;
  }

  async recover(): Promise<void> {
    await Promise.allSettled(this.store.listRuns({ status: ["queued", "running", "waiting", "interrupted"] }).map((run) => this.run(run.workflowId, run.input, { runId: run.id })));
  }

  cancel(runId: string): WorkflowRunRecord {
    const run = this.requireRun(runId);
    const updated = { ...run, cancelRequested: true, updatedAt: nowIso() };
    this.store.saveRun(updated);
    return updated;
  }

  private async execute(run: WorkflowRunRecord, ir: WorkflowIr): Promise<WorkflowRunRecord> {
    let current: WorkflowRunRecord = { ...run, status: "running", startedAt: run.startedAt ?? nowIso(), updatedAt: nowIso(), error: null };
    this.store.saveRun(current);
    this.event(current, "workflow.run.started", { revision: ir.revision, hash: ir.hash });
    const context: ExecutionContext = { input: current.input, steps: {}, iteration: {} };
    for (const attempt of this.store.listStepAttempts(current.id)) if (attempt.status === "completed" && attempt.output !== null) context.steps[attempt.stepId] = attempt.output;
    try {
      await this.executeSteps(ir.definition.steps, current, ir, context, "root");
      this.throwIfCancelled(current.id);
      const output = getPath(context as unknown as JsonValue, ir.definition.output) ?? context.steps;
      current = { ...this.requireRun(current.id), status: "completed", output: output as JsonValue, updatedAt: nowIso(), finishedAt: nowIso() };
      this.store.saveRun(current);
      this.event(current, "workflow.run.completed", { output: current.output });
      return current;
    } catch (error) {
      const latest = this.requireRun(current.id);
      const cancelled = latest.cancelRequested;
      current = { ...latest, status: cancelled ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error), updatedAt: nowIso(), finishedAt: nowIso() };
      this.store.saveRun(current);
      this.event(current, cancelled ? "workflow.run.cancelled" : "workflow.run.failed", { error: current.error });
      return current;
    }
  }

  private async executeSteps(steps: WorkflowStep[], run: WorkflowRunRecord, ir: WorkflowIr, context: ExecutionContext, scope: string): Promise<void> {
    for (const step of steps) {
      this.throwIfCancelled(run.id);
      await this.executeStep(step, run, ir, context, scope);
    }
  }

  private async executeStep(step: WorkflowStep, run: WorkflowRunRecord, ir: WorkflowIr, context: ExecutionContext, scope: string): Promise<void> {
    const iterationKey = `${scope}:${Object.entries(context.iteration).map(([key, value]) => `${key}=${value}`).join(",")}`;
    const replay = this.store.getLatestStepAttempt(run.id, step.id, iterationKey);
    if (replay?.status === "completed") {
      if (replay.output !== null) context.steps[step.id] = replay.output;
      return;
    }
    const attemptNumber = (replay?.attempt ?? 0) + (replay?.status === "failed" ? 1 : 0) || 1;
    const attempt: StepAttemptRecord = replay?.status === "running" ? replay : {
      id: ulid(), runId: run.id, stepId: step.id, iterationKey, attempt: attemptNumber, status: "running",
      input: context as unknown as JsonValue, output: null, error: null,
      idempotencyKey: idempotencyKey(run.id, step.id, iterationKey, String(attemptNumber)),
      startedAt: nowIso(), updatedAt: nowIso(), finishedAt: null,
    };
    this.store.saveStepAttempt(attempt);
    try {
      let output: JsonValue = null;
      if (step.type === "agent") output = await this.executeAgent(step, run, ir, context, attempt);
      else if (step.type === "set") output = interpolateJson(step.value, context);
      else if (step.type === "sequence") {
        await this.executeSteps(step.steps, run, ir, context, `${scope}/${step.id}`);
        output = Object.fromEntries(step.steps.map((child) => [child.id, context.steps[child.id] ?? null]));
      } else if (step.type === "parallel") {
        await Promise.all(step.steps.map((child) => this.executeStep(child, run, ir, context, `${scope}/${step.id}`)));
        output = Object.fromEntries(step.steps.map((child) => [child.id, context.steps[child.id] ?? null]));
      } else if (step.type === "if") {
        const branch = evaluate(step.condition, context) ? step.then : step.else ?? [];
        await this.executeSteps(branch, run, ir, context, `${scope}/${step.id}`);
        output = { branch: branch === step.then ? "then" : "else" };
      } else {
        const limit = Math.min(step.maxIterations ?? this.loaded.config.workflows.maxLoopIterations, this.loaded.config.workflows.maxLoopIterations);
        let count = context.iteration[step.id] ?? 0;
        while (evaluate(step.condition, context)) {
          if (count >= limit) throw new Error(`Workflow loop ${step.id} exceeded ${limit} iterations.`);
          count += 1;
          context.iteration[step.id] = count;
          await this.executeSteps(step.steps, run, ir, context, `${scope}/${step.id}/${count}`);
        }
        output = { iterations: count };
      }
      context.steps[step.id] = output;
      const persistedAttempt = this.store.getLatestStepAttempt(run.id, step.id, iterationKey) ?? attempt;
      this.store.saveStepAttempt({ ...persistedAttempt, status: "completed", output, updatedAt: nowIso(), finishedAt: nowIso() });
      this.event(run, "workflow.step.completed", { stepId: step.id, iterationKey, output });
    } catch (error) {
      this.store.saveStepAttempt({ ...attempt, status: "failed", error: error instanceof Error ? error.message : String(error), updatedAt: nowIso(), finishedAt: nowIso() });
      throw error;
    }
  }

  private async executeAgent(step: AgentStep, run: WorkflowRunRecord, ir: WorkflowIr, context: ExecutionContext, attempt: StepAttemptRecord): Promise<JsonValue> {
    const previousAgentId = typeof (attempt.input as Record<string, JsonValue>).agentId === "string" ? (attempt.input as Record<string, JsonValue>).agentId as string : null;
    let agentRecord: AgentRecord;
    if (previousAgentId) agentRecord = this.agents.get(previousAgentId);
    else {
      agentRecord = await this.agents.create({
        id: attempt.idempotencyKey,
        workflowId: run.workflowId,
        runId: run.id,
        parentAgentId: null,
        depth: 0,
        mission: ir.mission,
        objective: interpolate(step.objective, context),
        model: step.model ?? "auto",
        harness: step.harness ?? "auto",
        permissions: step.permissions ?? this.loaded.config.agents.defaultPermissions,
        outputSchema: step.outputSchema,
        routing: step.routing,
        workspace: step.workspace ?? ir.definition.workspace,
        inputs: [],
        metadata: { workflowStepId: step.id, stepAttemptId: attempt.id },
      });
      this.store.saveStepAttempt({ ...attempt, input: { ...context, agentId: agentRecord.id } as unknown as JsonValue, updatedAt: nowIso() });
    }
    agentRecord = await this.waitForAgent(agentRecord.id);
    if (agentRecord.status !== "completed") throw new Error(`Agent ${agentRecord.id} ended with ${agentRecord.status}: ${agentRecord.error ?? "unknown error"}`);
    return agentRecord.output ?? { agentId: agentRecord.id, status: agentRecord.status };
  }

  private waitForAgent(agentId: string): Promise<AgentRecord> {
    const initial = this.agents.get(agentId);
    if (["completed", "failed", "cancelled", "interrupted", "lost"].includes(initial.status)) return Promise.resolve(initial);
    return new Promise((resolvePromise) => {
      const unsubscribe = this.store.onEvent((event) => {
        if (event.agentId !== agentId || !["driver.run.completed", "driver.run.failed", "driver.run.cancelled", "agent.failed"].includes(event.type)) return;
        unsubscribe();
        resolvePromise(this.agents.get(agentId));
      });
    });
  }

  private throwIfCancelled(runId: string): void {
    if (this.requireRun(runId).cancelRequested) throw new Error("Workflow run was cancelled.");
  }

  private requireRun(runId: string): WorkflowRunRecord {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Workflow run not found: ${runId}`);
    return run;
  }

  private event(run: WorkflowRunRecord, type: string, payload: JsonValue): void {
    this.store.appendEvent({ type, workflowId: run.workflowId, runId: run.id, agentId: null, occurredAt: nowIso(), payload, provenance: { source: "workflow" } });
  }
}

export class TriggerManager {
  private readonly jobs: Cron[] = [];

  constructor(private readonly store: SymphonyStore, private readonly engine: WorkflowEngine) {}

  register(ir: WorkflowIr): void {
    for (const trigger of ir.definition.triggers) {
      if (trigger.type !== "cron") continue;
      const job = new Cron(trigger.expression, trigger.timezone ? { timezone: trigger.timezone } : {}, async () => {
        const occurrenceKey = `${ir.definition.id}:${trigger.id}:${new Date().toISOString().slice(0, 16)}`;
        if (!this.store.claimTriggerOccurrence(trigger.id, occurrenceKey)) return;
        const run = this.engine.start(ir.definition.id, trigger.input);
        this.store.attachTriggerRun(trigger.id, occurrenceKey, run.id);
      });
      this.jobs.push(job);
    }
  }

  stop(): void {
    for (const job of this.jobs) job.stop();
    this.jobs.length = 0;
  }
}

export async function loadWorkflowDirectory(loaded: LoadedConfig, store: SymphonyStore, engine: WorkflowEngine, triggers?: TriggerManager): Promise<WorkflowIr[]> {
  const loader = new WorkflowLoader();
  const results: WorkflowIr[] = [];
  for (const path of loader.discover(loaded.workflowDirectory)) {
    const provisional = await loader.load(path, 0);
    const previous = store.getWorkflow(provisional.definition.id);
    const ir = previous ? await loader.load(path, previous.revision) : provisional;
    const existing = store.getWorkflow(ir.definition.id);
    const effective = existing?.hash === ir.hash ? { ...ir, revision: existing.revision, mission: existing.mission as unknown as WorkflowMission } : ir;
    if (!existing || existing.hash !== effective.hash) engine.register(effective);
    triggers?.register(effective);
    results.push(effective);
  }
  return results;
}

function interpolate(template: string, context: ExecutionContext): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/gu, (_match, path: string) => {
    const value = getPath(context as unknown as JsonValue, path);
    return typeof value === "string" ? value : JSON.stringify(value ?? null);
  });
}

function interpolateJson(value: JsonValue, context: ExecutionContext): JsonValue {
  if (typeof value === "string") return interpolate(value, context);
  if (Array.isArray(value)) return value.map((item) => interpolateJson(item, context));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateJson(item, context)]));
  return value;
}

function getPath(root: JsonValue, rawPath: string): JsonValue | undefined {
  const path = rawPath.replace(/^\$\.?/u, "").split(".").filter(Boolean);
  let current: JsonValue | undefined = root;
  for (const part of path) {
    if (Array.isArray(current)) current = current[Number(part)];
    else if (current && typeof current === "object") current = current[part];
    else return undefined;
  }
  return current;
}

function evaluate(condition: Condition, context: ExecutionContext): boolean {
  const actual = getPath(context as unknown as JsonValue, condition.path) ?? condition.default;
  if (condition.op === "exists") return actual !== undefined && actual !== null;
  if (condition.op === "eq") return stableStringify(actual) === stableStringify(condition.value);
  if (condition.op === "neq") return stableStringify(actual) !== stableStringify(condition.value);
  if (typeof actual !== "number" || typeof condition.value !== "number") return false;
  if (condition.op === "gt") return actual > condition.value;
  if (condition.op === "gte") return actual >= condition.value;
  if (condition.op === "lt") return actual < condition.value;
  return actual <= condition.value;
}
