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
  CapabilityExecutionBindingSchema,
  JsonValueSchema,
  PermissionSchema,
  RoutingIntentSchema,
  WorkspaceSpecSchema,
  isTerminalAgentStatus,
  nowIso,
  resolveChildPermission,
  type AgentRecord,
  type CapabilityExecutionBinding,
  type JsonValue,
  type WorkflowMission,
  WorkflowStepDependenciesSchema,
} from "@symphony/protocol";
import { AgentCoordinator, idempotencyKey } from "@symphony/runtime";
import type {
  StepAttemptRecord,
  SymphonyStore,
  TriggerOccurrenceRecord,
  WorkflowRevisionRecord,
  WorkflowRunOrigin,
  WorkflowRunRecord,
} from "@symphony/storage";

export * from "./objective-runtime.js";
export * from "./objective-values.js";
export * from "./objective-store-repository.js";
export * from "./objective-control-plan.js";
export * from "./objective-frontier.js";
export * from "./objective-supervisor.js";
export * from "./objective-supervision-runner.js";
export * from "./objective-approval-expiry.js";
export * from "./objective-handoff.js";
export * from "./workspace-containment.js";
export * from "./capability-library.js";
export * from "./capability-execution.js";
export * from "./workspace-manifest.js";
export * from "./agent-message-bus.js";
export * from "./objective-feedback.js";
export * from "./objective-feedback-runtime.js";

const OutputSchema = z.record(z.string(), JsonValueSchema);
const CommonStepSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_.-]+$/u),
  /** Explicit prerequisite step IDs. Dependencies are resolved by the daemon. */
  dependsOn: WorkflowStepDependenciesSchema.optional(),
});

export type AgentStep = z.infer<typeof CommonStepSchema> & {
  type: "agent";
  objective: string;
  model?: string | undefined;
  harness?: "auto" | "codex" | "claude" | "cursor" | "opencode" | "pi" | "acp" | undefined;
  permissions?: "read-only" | "full-access" | undefined;
  outputSchema: Record<string, JsonValue>;
  routing?: z.infer<typeof RoutingIntentSchema> | undefined;
  workspace?: z.infer<typeof WorkspaceSpecSchema> | undefined;
  capabilityExecution?: CapabilityExecutionBinding | undefined;
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
export type EvaluationOperator = "exists" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
export type EvaluateStep = z.infer<typeof CommonStepSchema> & {
  type: "evaluate";
  metric?: string | undefined;
  path: string;
  operator?: EvaluationOperator | undefined;
  op?: EvaluationOperator | undefined;
  target?: JsonValue | undefined;
  default?: JsonValue | undefined;
};
export type TimerStep = z.infer<typeof CommonStepSchema> & {
  type: "timer";
  durationMs: number;
  expiresAfterMs?: number | null | undefined;
};
export type SignalStep = z.infer<typeof CommonStepSchema> & {
  type: "signal";
  signalKey: string;
  expiresAfterMs?: number | null | undefined;
  payloadSchema?: Record<string, JsonValue> | undefined;
};
export type WorkflowStep = AgentStep | SequenceStep | ParallelStep | WhileStep | IfStep | SetStep | EvaluateStep | TimerStep | SignalStep;

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
    capabilityExecution: CapabilityExecutionBindingSchema.optional(),
  }),
  CommonStepSchema.extend({ type: z.literal("sequence"), steps: z.array(WorkflowStepSchema).min(1) }),
  CommonStepSchema.extend({ type: z.literal("parallel"), steps: z.array(WorkflowStepSchema).min(1) }),
  CommonStepSchema.extend({ type: z.literal("while"), condition: ConditionSchema, steps: z.array(WorkflowStepSchema).min(1), maxIterations: z.number().int().positive().optional() }),
  CommonStepSchema.extend({ type: z.literal("if"), condition: ConditionSchema, then: z.array(WorkflowStepSchema).min(1), else: z.array(WorkflowStepSchema).optional() }),
  CommonStepSchema.extend({ type: z.literal("set"), value: JsonValueSchema }),
  CommonStepSchema.extend({
    type: z.literal("evaluate"),
    metric: z.string().min(1).max(500).optional(),
    path: z.string().min(1).max(1_000),
    operator: z.enum(["exists", "eq", "neq", "gt", "gte", "lt", "lte"]).optional(),
    op: z.enum(["exists", "eq", "neq", "gt", "gte", "lt", "lte"]).optional(),
    target: JsonValueSchema.optional(),
    default: JsonValueSchema.optional(),
  }).strict().superRefine((step, context) => {
    if (step.operator === undefined && step.op === undefined) {
      context.addIssue({ code: "custom", path: ["operator"], message: "Evaluation step requires an operator." });
    }
    if (step.operator !== undefined && step.op !== undefined && step.operator !== step.op) {
      context.addIssue({ code: "custom", path: ["operator"], message: "Evaluation step operator and op must agree." });
    }
  }),
  CommonStepSchema.extend({
    type: z.literal("timer"),
    durationMs: z.number().int().positive().max(31_536_000_000),
    expiresAfterMs: z.number().int().positive().max(31_536_000_000).nullable().optional(),
  }).strict().superRefine((step, context) => {
    if (step.expiresAfterMs !== undefined && step.expiresAfterMs !== null && step.expiresAfterMs < step.durationMs) {
      context.addIssue({ code: "custom", path: ["expiresAfterMs"], message: "Timer expiry must be at or after due time." });
    }
  }),
  CommonStepSchema.extend({
    type: z.literal("signal"),
    signalKey: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u),
    expiresAfterMs: z.number().int().positive().max(31_536_000_000).nullable().optional(),
    payloadSchema: z.record(z.string(), JsonValueSchema).optional(),
  }).strict(),
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

/** Construct a strict, data-only evaluation step. */
export function evaluate(
  id: string,
  path: string,
  operator: EvaluationOperator,
  target?: JsonValue,
  metric?: string,
): EvaluateStep {
  return {
    id,
    type: "evaluate",
    path,
    operator,
    ...(target === undefined ? {} : { target }),
    ...(metric === undefined ? {} : { metric }),
  };
}

export function timer(id: string, durationMs: number, expiresAfterMs?: number | null): TimerStep {
  return { id, type: "timer", durationMs, ...(expiresAfterMs === undefined ? {} : { expiresAfterMs }) };
}

export function signal(id: string, signalKey: string, options: Pick<SignalStep, "expiresAfterMs" | "payloadSchema"> = {}): SignalStep {
  return { id, type: "signal", signalKey, ...(options.expiresAfterMs === undefined ? {} : { expiresAfterMs: options.expiresAfterMs }), ...(options.payloadSchema === undefined ? {} : { payloadSchema: options.payloadSchema }) };
}

export class WorkflowCompiler {
  compile(definitionInput: unknown, revision: number): WorkflowIr {
    const definition = WorkflowDefinitionSchema.parse(definitionInput);
    const ids: string[] = [];
    const stepsById = new Map<string, WorkflowStep>();
    const visit = (steps: WorkflowStep[]): void => {
      for (const step of steps) {
        if (ids.includes(step.id)) throw new Error(`Duplicate workflow step id: ${step.id}`);
        ids.push(step.id);
        stepsById.set(step.id, step);
        if (step.type === "sequence" || step.type === "parallel" || step.type === "while") visit(step.steps);
        if (step.type === "if") {
          visit(step.then);
          visit(step.else ?? []);
        }
      }
    };
    visit(definition.steps);
    const knownIds = new Set(ids);
    for (const step of stepsById.values()) {
      const seenDependencies = new Set<string>();
      for (const dependencyId of step.dependsOn ?? []) {
        if (seenDependencies.has(dependencyId)) throw new Error(`Workflow step ${step.id} declares duplicate dependency ${dependencyId}`);
        if (dependencyId === step.id) throw new Error(`Workflow step ${step.id} cannot depend on itself`);
        if (!knownIds.has(dependencyId)) throw new Error(`Workflow step ${step.id} depends on unknown step ${dependencyId}`);
        seenDependencies.add(dependencyId);
      }
    }
    // A dependency graph must be finite before a durable run can be admitted.
    // Container ordering is enforced separately by the runtime scheduler.
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visitDependencies = (stepId: string): void => {
      if (visited.has(stepId)) return;
      if (visiting.has(stepId)) throw new Error(`Workflow dependency cycle detected through ${stepId}`);
      const step = stepsById.get(stepId);
      if (!step) return;
      visiting.add(stepId);
      for (const dependencyId of step.dependsOn ?? []) visitDependencies(dependencyId);
      visiting.delete(stepId);
      visited.add(stepId);
    };
    for (const stepId of ids) visitDependencies(stepId);
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

function hasStepOutput(context: ExecutionContext, stepId: string): boolean {
  return Object.prototype.hasOwnProperty.call(context.steps, stepId);
}

export type WorkflowRunStartOptions = {
  runId?: string;
  workflowRevision?: number;
  workflowHash?: string;
  /** Trusted daemon-owned authority context. Never accept this from workflow input. */
  origin?: WorkflowRunOrigin;
};

/**
 * Validate the authority receipt at the workflow boundary as well as at API
 * boundaries. Workflow runs are persisted as JSON, so a TypeScript-only type
 * cannot protect recovery from a malformed or forged origin.
 */
export const WorkflowRunOriginSchema = z.object({
  kind: z.enum(["user", "agent", "cron"]),
  threadId: z.string().min(1).nullable(),
  parentRunId: z.string().min(1).nullable(),
  parentAgentId: z.string().min(1).nullable(),
  baseDepth: z.number().int().min(-1).max(1_000_000),
  permissionCeiling: PermissionSchema,
}).strict().superRefine((origin, context) => {
  if (origin.kind === "agent") {
    if (origin.parentRunId === null || origin.parentAgentId === null || origin.baseDepth < 0) {
      context.addIssue({ code: "custom", message: "Agent workflow origins require a parent run, parent agent, and non-negative base depth." });
    }
    return;
  }
  if (origin.threadId !== null || origin.parentRunId !== null || origin.parentAgentId !== null || origin.baseDepth !== -1) {
    context.addIssue({ code: "custom", message: `${origin.kind} workflow origins must be root origins.` });
  }
  if (origin.permissionCeiling !== "full-access") {
    context.addIssue({ code: "custom", message: `${origin.kind} workflow origins must retain full-access as their root ceiling.` });
  }
});

export function parseWorkflowRunOrigin(value: unknown): WorkflowRunOrigin {
  return WorkflowRunOriginSchema.parse(value) as WorkflowRunOrigin;
}

const DEFAULT_USER_ORIGIN: WorkflowRunOrigin = {
  kind: "user",
  threadId: null,
  parentRunId: null,
  parentAgentId: null,
  baseDepth: -1,
  permissionCeiling: "full-access",
};

export class WorkflowEngine {
  private readonly running = new Map<string, Promise<WorkflowRunRecord>>();
  private readonly cancelling = new Map<string, Promise<void>>();

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

  async run(
    workflowId: string,
    input: JsonValue = {},
    options: WorkflowRunStartOptions = {},
  ): Promise<WorkflowRunRecord> {
    const record = this.start(workflowId, input, options);
    return this.running.get(record.id) ?? Promise.resolve(record);
  }

  start(
    workflowId: string,
    input: JsonValue = {},
    options: WorkflowRunStartOptions = {},
  ): WorkflowRunRecord {
    const runId = options.runId ?? ulid();
    const existing = this.store.getRun(runId);
    if (existing && existing.workflowId !== workflowId) {
      throw new Error(`Workflow run ${runId} belongs to ${existing.workflowId}, not ${workflowId}.`);
    }
    if (existing && options.workflowRevision !== undefined && existing.workflowRevision !== options.workflowRevision) {
      throw new Error(`Workflow run ${runId} is pinned to ${workflowId}@${existing.workflowRevision}, not revision ${options.workflowRevision}.`);
    }
    const requestedOrigin = options.origin === undefined ? undefined : parseWorkflowRunOrigin(options.origin);
    const existingOrigin = existing?.origin === undefined ? undefined : parseWorkflowRunOrigin(existing.origin);
    if (existing && existingOrigin === undefined && requestedOrigin === undefined) {
      throw new Error(`Workflow run ${runId} has no immutable authority origin; explicit trusted recovery backfill is required.`);
    }
    if (existingOrigin !== undefined && requestedOrigin !== undefined && stableStringify(existingOrigin) !== stableStringify(requestedOrigin)) {
      throw new Error(`Workflow run ${runId} is already bound to a different authority origin.`);
    }
    // A run is authorized against one immutable workflow revision. Recovery
    // must never fall forward to a newer definition just because the workflow
    // file changed while native work was still in flight.
    const requiredRevision = existing?.workflowRevision ?? options.workflowRevision;
    const saved = requiredRevision === undefined
      ? this.store.getWorkflow(workflowId)
      : this.store.getWorkflow(workflowId, requiredRevision);
    if (!saved) {
      const error = existing
        ? `Workflow ${existing.workflowId} revision ${existing.workflowRevision} required by run ${runId} is unavailable; recovery is blocked.`
        : `Workflow not found: ${workflowId}`;
      if (existing) {
        const blocked = { ...existing, status: "interrupted" as const, error, updatedAt: nowIso(), finishedAt: null };
        this.store.saveRun(blocked);
        this.event(blocked, "workflow.run.recovery-blocked", {
          error,
          requiredRevision: existing.workflowRevision,
        });
      }
      throw new Error(error);
    }
    const ir = saved.ir as unknown as WorkflowIr;
    if (ir.definition.id !== saved.id || ir.revision !== saved.revision) {
      throw new Error(`Stored workflow revision ${saved.id}@${saved.revision} has inconsistent compiled identity.`);
    }
    if (options.workflowHash !== undefined && saved.hash !== options.workflowHash) {
      throw new Error(`Workflow ${workflowId}@${saved.revision} hash does not match the pinned trigger occurrence.`);
    }
    // A terminal run ID is an immutable execution receipt. Reusing it must
    // return the recorded outcome rather than replaying steps, even if an API
    // command receipt was lost after the run itself durably settled. Resolve
    // the pinned revision/hash first so trigger recovery cannot attach an
    // occurrence to an unrelated terminal receipt.
    if (existing && ["completed", "failed", "cancelled"].includes(existing.status)) return existing;
    const now = nowIso();
    const record: WorkflowRunRecord = existing
      ? existingOrigin === undefined && requestedOrigin !== undefined
        // Legacy records predate the origin receipt. Permit exactly one trusted
        // recovery-time backfill, after which the mismatch fence above makes
        // the captured authority immutable.
        ? { ...existing, origin: requestedOrigin }
        : existing
      : {
          id: runId, workflowId, workflowRevision: saved.revision, status: "queued", input, output: null,
          error: null, startedAt: null, updatedAt: now, finishedAt: null, cancelRequested: false,
          origin: requestedOrigin ?? DEFAULT_USER_ORIGIN,
        };
    this.store.saveRun(record);
    if (!this.running.has(runId)) {
      const execution = this.execute(record, ir).finally(() => this.running.delete(runId));
      this.running.set(runId, execution);
      // `start()` is deliberately fire-and-observe: callers may use `run()` to
      // await the terminal result, while daemon recovery only needs to restore
      // supervision and then expose the authoritative projection. Attach a
      // rejection observer so a later workflow failure never becomes an
      // unhandled rejection when no caller is awaiting this particular run.
      void execution.catch(() => undefined);
    }
    return record;
  }

  async recover(): Promise<void> {
    // Recovery must restore supervision, not wait for every recovered workflow
    // to finish. Long-running native agents can remain active for hours; the
    // daemon still needs to become ready so clients can inspect, steer, cancel,
    // and observe those runs while they continue in the background.
    for (const run of this.store.listRuns({ status: ["queued", "running", "waiting", "interrupted"] })) {
      // Chat runs are durable conversation containers, not compiled workflow
      // executions. They intentionally have no WorkflowRevisionRecord: native
      // conductor recovery is owned by AgentCoordinator. Older daemons fed
      // these records through start(), which rewrote every healthy chat run to
      // `interrupted` and emitted a false recovery-blocked event on each
      // restart. Repair that legacy projection once and leave execution to the
      // conductor supervisor.
      if (isChatContainerRun(run)) {
        if (run.status !== "running" || run.error !== null || run.finishedAt !== null) {
          this.store.saveRun({
            ...run,
            status: "running",
            error: null,
            updatedAt: nowIso(),
            finishedAt: null,
          });
        }
        continue;
      }
      try {
        this.start(run.workflowId, run.input, { runId: run.id });
        if (run.cancelRequested) this.propagateCancellation(run.id);
      } catch (cause) {
        // `start()` persists an explicit recovery-blocked state/event for a
        // missing pinned revision. Persist any other synchronous failure here
        // as well, while isolating runs so one malformed record cannot hold
        // daemon startup.
        const error = cause instanceof Error ? cause.message : String(cause);
        const latest = this.store.getRun(run.id) ?? run;
        if (latest.status === "interrupted" && latest.error === error) continue;
        const blocked = { ...latest, status: "interrupted" as const, error, updatedAt: nowIso(), finishedAt: null };
        this.store.saveRun(blocked);
        this.event(blocked, "workflow.run.recovery-blocked", { error });
      }
    }
  }

  cancel(runId: string): WorkflowRunRecord {
    const run = this.requireRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    if (run.cancelRequested) {
      // The durable intent is authoritative. A restart or reconstructed API
      // receipt may re-enter here solely to resume bounded cancellation fanout;
      // do not append a second request event or mutate the receipt identity.
      this.propagateCancellation(runId);
      return run;
    }
    const updated = { ...run, cancelRequested: true, updatedAt: nowIso() };
    this.store.durableTransaction(() => {
      this.store.saveRun(updated);
      this.event(updated, "workflow.run.cancel-requested", {});
    });
    this.propagateCancellation(runId);
    return updated;
  }

  private propagateCancellation(runId: string): void {
    if (this.cancelling.has(runId)) return;
    const cancellation = this.cancelAgentsForRun(runId).finally(() => {
      if (this.cancelling.get(runId) === cancellation) this.cancelling.delete(runId);
    });
    this.cancelling.set(runId, cancellation);
    void cancellation.catch((cause) => {
      const run = this.store.getRun(runId);
      if (!run) return;
      this.event(run, "workflow.run.cancel-propagation-failed", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }

  private async cancelAgentsForRun(runId: string): Promise<void> {
    // Persisting the run intent happens first. This asynchronous fan-out keeps
    // the API responsive while native cancellation remains bounded by each
    // driver's acknowledgement and termination deadlines. Recovery invokes
    // the same method, so a crash between intent and fan-out cannot revive the
    // run or leave its durable agents working indefinitely.
    const agents = this.agents.list({ runId, activeOnly: true });
    const results = await Promise.allSettled(agents.map((agent) => this.agents.cancel(agent.id)));
    const failures = results.flatMap((result, index) => result.status === "rejected"
      ? [{
          agentId: agents[index]?.id ?? "unknown",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }]
      : []);
    if (failures.length) throw new Error(`Failed to propagate workflow cancellation: ${JSON.stringify(failures)}`);
  }

  private async execute(run: WorkflowRunRecord, ir: WorkflowIr): Promise<WorkflowRunRecord> {
    const hasStartedEvent = this.store.recentEvents({
      runId: run.id,
      types: ["workflow.run.started"],
      limit: 1,
    }).length > 0;
    let current: WorkflowRunRecord = { ...run, status: "running", startedAt: run.startedAt ?? nowIso(), updatedAt: nowIso(), error: null };
    this.store.durableTransaction(() => {
      this.store.saveRun(current);
      if (!hasStartedEvent) this.event(current, "workflow.run.started", { revision: ir.revision, hash: ir.hash });
    });
    const context: ExecutionContext = { input: current.input, steps: {}, iteration: {} };
    for (const attempt of this.store.listStepAttempts(current.id)) {
      if (attempt.status === "completed") context.steps[attempt.stepId] = attempt.output;
    }
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
      if (cancelled) await this.cancelling.get(current.id)?.catch(() => undefined);
      current = { ...latest, status: cancelled ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error), updatedAt: nowIso(), finishedAt: nowIso() };
      this.store.saveRun(current);
      this.event(current, cancelled ? "workflow.run.cancelled" : "workflow.run.failed", { error: current.error });
      return current;
    }
  }

  private async executeSteps(
    steps: WorkflowStep[],
    run: WorkflowRunRecord,
    ir: WorkflowIr,
    context: ExecutionContext,
    scope: string,
    mode: "sequence" | "parallel" = "sequence",
  ): Promise<void> {
    const pending = [...steps];
    while (pending.length > 0) {
      this.throwIfCancelled(run.id);
      const ready = pending.filter((step) => (step.dependsOn ?? []).every((dependencyId) => hasStepOutput(context, dependencyId)));
      if (ready.length === 0) {
        const blocked = pending.map((step) => `${step.id} after ${(step.dependsOn ?? []).join(", ") || "an unresolved prerequisite"}`).join("; ");
        throw new Error(`Workflow dependencies cannot be satisfied in ${scope}: ${blocked}`);
      }

      if (mode === "parallel") {
        // Execute a ready frontier together. A dependent sibling moves to the
        // next frontier only after this batch has durably completed.
        const readyIds = new Set(ready.map((step) => step.id));
        pending.splice(0, pending.length, ...pending.filter((step) => !readyIds.has(step.id)));
        await Promise.all(ready.map((step) => this.executeStep(step, run, ir, context, scope)));
      } else {
        // Sequence containers retain source order; dependencies can add a
        // prerequisite fence but cannot silently reorder authored steps.
        const next = pending[0];
        if (!next) return;
        if (!(next.dependsOn ?? []).every((dependencyId) => hasStepOutput(context, dependencyId))) {
          const unresolved = (next.dependsOn ?? []).filter((dependencyId) => !hasStepOutput(context, dependencyId));
          throw new Error(`Workflow step ${next.id} is blocked in ${scope} by ${unresolved.join(", ")}. Sequence order cannot satisfy this dependency.`);
        }
        pending.shift();
        await this.executeStep(next, run, ir, context, scope);
      }
    }
  }

  private async executeStep(step: WorkflowStep, run: WorkflowRunRecord, ir: WorkflowIr, context: ExecutionContext, scope: string): Promise<void> {
    const iterationKey = `${scope}:${Object.entries(context.iteration).map(([key, value]) => `${key}=${value}`).join(",")}`;
    const replay = this.store.getLatestStepAttempt(run.id, step.id, iterationKey);
    if (replay?.status === "completed") {
      context.steps[step.id] = replay.output;
      return;
    }
    const attemptNumber = (replay?.attempt ?? 0) + (replay?.status === "failed" ? 1 : 0) || 1;
    const attempt: StepAttemptRecord = replay?.status === "running" ? replay : {
      id: ulid(), runId: run.id, stepId: step.id, iterationKey, attempt: attemptNumber, status: "running",
      input: context as unknown as JsonValue, output: null, error: null,
      idempotencyKey: idempotencyKey(run.id, step.id, iterationKey, String(attemptNumber)),
      startedAt: nowIso(), updatedAt: nowIso(), finishedAt: null,
    };
    if (replay?.status !== "running") {
      this.store.durableTransaction(() => {
        this.store.saveStepAttempt(attempt);
        this.event(run, "workflow.step.started", {
          stepId: step.id,
          stepType: step.type,
          iterationKey,
          attempt: attempt.attempt,
        });
      });
    }
    try {
      let output: JsonValue = null;
      if (step.type === "agent") output = await this.executeAgent(step, run, ir, context, attempt);
      else if (step.type === "set") output = interpolateJson(step.value, context);
      else if (step.type === "sequence") {
        await this.executeSteps(step.steps, run, ir, context, `${scope}/${step.id}`);
        output = Object.fromEntries(step.steps.map((child) => [child.id, context.steps[child.id] ?? null]));
      } else if (step.type === "parallel") {
        await this.executeSteps(step.steps, run, ir, context, `${scope}/${step.id}`, "parallel");
        output = Object.fromEntries(step.steps.map((child) => [child.id, context.steps[child.id] ?? null]));
      } else if (step.type === "if") {
        const branch = evaluateCondition(step.condition, context) ? step.then : step.else ?? [];
        await this.executeSteps(branch, run, ir, context, `${scope}/${step.id}`);
        output = { branch: branch === step.then ? "then" : "else" };
      } else if (step.type === "evaluate") {
        output = evaluateStep(step, context);
      } else if (step.type === "timer" || step.type === "signal") {
        throw new Error(`Workflow ${step.type} step ${step.id} requires an objective control plan runtime.`);
      } else {
        const limit = Math.min(step.maxIterations ?? this.loaded.config.workflows.maxLoopIterations, this.loaded.config.workflows.maxLoopIterations);
        let count = context.iteration[step.id] ?? 0;
        while (evaluateCondition(step.condition, context)) {
          if (count >= limit) throw new Error(`Workflow loop ${step.id} exceeded ${limit} iterations.`);
          count += 1;
          context.iteration[step.id] = count;
          await this.executeSteps(step.steps, run, ir, context, `${scope}/${step.id}/${count}`);
        }
        output = { iterations: count };
      }
      context.steps[step.id] = output;
      const persistedAttempt = this.store.getLatestStepAttempt(run.id, step.id, iterationKey) ?? attempt;
      this.store.durableTransaction(() => {
        this.store.saveStepAttempt({ ...persistedAttempt, status: "completed", output, updatedAt: nowIso(), finishedAt: nowIso() });
        this.event(run, "workflow.step.completed", {
          stepId: step.id,
          stepType: step.type,
          iterationKey,
          attempt: persistedAttempt.attempt,
          output,
        });
      });
    } catch (error) {
      const persistedAttempt = this.store.getLatestStepAttempt(run.id, step.id, iterationKey) ?? attempt;
      const message = error instanceof Error ? error.message : String(error);
      const agentId = stepAttemptAgentId(persistedAttempt);
      this.store.durableTransaction(() => {
        this.store.saveStepAttempt({ ...persistedAttempt, status: "failed", error: message, updatedAt: nowIso(), finishedAt: nowIso() });
        this.event(run, "workflow.step.failed", {
          stepId: step.id,
          stepType: step.type,
          iterationKey,
          attempt: persistedAttempt.attempt,
          ...(agentId ? { agentId } : {}),
          error: message,
        });
      });
      throw error;
    }
  }

  private async executeAgent(step: AgentStep, run: WorkflowRunRecord, ir: WorkflowIr, context: ExecutionContext, attempt: StepAttemptRecord): Promise<JsonValue> {
    const previousAgentId = typeof (attempt.input as Record<string, JsonValue>).agentId === "string" ? (attempt.input as Record<string, JsonValue>).agentId as string : null;
    let agentRecord: AgentRecord;
    if (previousAgentId) agentRecord = this.agents.get(previousAgentId);
    else {
      if (run.origin === undefined) {
        throw new Error(`Workflow run ${run.id} cannot create an agent without an immutable authority origin.`);
      }
      const origin = parseWorkflowRunOrigin(run.origin);
      const permissions = resolveChildPermission(
        origin.permissionCeiling,
        step.permissions ?? this.loaded.config.agents.defaultPermissions,
      );
      agentRecord = await this.agents.create({
        id: attempt.idempotencyKey,
        workflowId: run.workflowId,
        runId: run.id,
        parentAgentId: origin.parentAgentId,
        depth: origin.baseDepth + 1,
        mission: ir.mission,
        objective: interpolate(step.objective, context),
        model: step.model ?? "auto",
        harness: step.harness ?? "auto",
        permissions,
        outputSchema: step.outputSchema,
        routing: step.routing,
        workspace: step.workspace ?? ir.definition.workspace,
        inputs: [],
        metadata: { workflowStepId: step.id, stepAttemptId: attempt.id },
      });
      this.store.saveStepAttempt({ ...attempt, input: { ...context, agentId: agentRecord.id } as unknown as JsonValue, updatedAt: nowIso() });
    }
    // Cancellation can race native routing/start after the initial fan-out
    // snapshot. Fence the newly materialized agent against the durable run
    // intent before waiting for its terminal result.
    if (this.requireRun(run.id).cancelRequested && !isTerminalAgentStatus(agentRecord.status)) {
      await this.agents.cancel(agentRecord.id);
    }
    agentRecord = await this.waitForAgent(agentRecord.id);
    if (agentRecord.status !== "completed") throw new Error(`Agent ${agentRecord.id} ended with ${agentRecord.status}: ${agentRecord.error ?? "unknown error"}`);
    return agentRecord.output ?? { agentId: agentRecord.id, status: agentRecord.status };
  }

  private waitForAgent(agentId: string): Promise<AgentRecord> {
    const initial = this.agents.get(agentId);
    if (isTerminalAgentStatus(initial.status)) return Promise.resolve(initial);
    return new Promise((resolvePromise) => {
      const unsubscribe = this.store.onEvent((event) => {
        if (event.agentId !== agentId) return;
        const current = this.agents.get(agentId);
        if (!isTerminalAgentStatus(current.status)) return;
        unsubscribe();
        resolvePromise(current);
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
  private readonly jobs = new Map<string, Cron[]>();
  /**
   * Agent-authored schedules are retained as proposals until a trusted user
   * or policy explicitly activates them. Keeping these out of `jobs` is
   * intentional: `activate()` during daemon recovery must never turn a newly
   * registered agent schedule into a privileged recurring execution.
   */
  private readonly pending = new Map<string, WorkflowIr>();
  private active: boolean;

  constructor(
    private readonly store: SymphonyStore,
    private readonly engine: WorkflowEngine,
    options: { paused?: boolean } = {},
  ) {
    this.active = options.paused !== true;
  }

  register(ir: WorkflowIr, options: { mode?: "active" | "pending" } = {}): void {
    for (const job of this.jobs.get(ir.definition.id) ?? []) job.stop();
    this.jobs.delete(ir.definition.id);
    this.pending.delete(ir.definition.id);
    if (options.mode === "pending") {
      this.pending.set(ir.definition.id, ir);
      return;
    }
    const registered: Cron[] = [];
    for (const trigger of ir.definition.triggers) {
      if (trigger.type !== "cron") continue;
      const job = new Cron(
        trigger.expression,
        { ...(trigger.timezone ? { timezone: trigger.timezone } : {}), paused: !this.active },
        async (self) => {
          const scheduledAt = (self.currentRun() ?? new Date()).toISOString();
          try {
            await this.dispatch(ir, trigger, scheduledAt);
          } catch {
            // dispatch() durably records the failure while leaving the intent
            // recoverable. Cron callbacks must not become unhandled rejections.
          }
        },
      );
      registered.push(job);
    }
    this.jobs.set(ir.definition.id, registered);
  }

  /** Number of agent-authored schedules waiting for explicit activation. */
  pendingTriggerCount(workflowId?: string): number {
    return workflowId === undefined ? this.pending.size : this.pending.has(workflowId) ? 1 : 0;
  }

  isPending(workflowId: string): boolean {
    return this.pending.has(workflowId);
  }

  /**
   * Promote one previously proposed schedule. This is deliberately a
   * separate operation from `register()` so registration cannot be mistaken
   * for permission to create recurring runs.
   */
  approve(workflowId: string): boolean {
    const ir = this.pending.get(workflowId);
    if (!ir) return false;
    this.register(ir, { mode: "active" });
    return true;
  }

  activeTriggerCount(workflowId?: string): number {
    if (workflowId) return this.jobs.get(workflowId)?.length ?? 0;
    return [...this.jobs.values()].reduce((total, jobs) => total + jobs.length, 0);
  }

  async recover(): Promise<void> {
    for (const occurrence of this.store.listTriggerOccurrences({ state: "dispatching" })) {
      try {
        await this.dispatchOccurrence(occurrence);
      } catch {
        // One malformed or temporarily unavailable pinned revision must not
        // block reconciliation of other durable occurrences or daemon startup.
      }
    }
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    for (const jobs of this.jobs.values()) for (const job of jobs) job.resume();
  }

  stop(): void {
    for (const jobs of this.jobs.values()) for (const job of jobs) job.stop();
    this.jobs.clear();
    this.pending.clear();
    this.active = false;
  }


  private async dispatch(
    ir: WorkflowIr,
    trigger: Extract<WorkflowDefinition["triggers"][number], { type: "cron" }>,
    scheduledAt: string,
  ): Promise<void> {
    const occurrenceKey = `${ir.definition.id}:${trigger.id}:${scheduledAt}`;
    const timestamp = nowIso();
    const planned = {
      version: 1 as const,
      triggerId: trigger.id,
      occurrenceKey,
      workflowId: ir.definition.id,
      workflowRevision: ir.revision,
      workflowHash: ir.hash,
      input: trigger.input,
      scheduledAt,
      runId: `cron-${createHash("sha256").update(occurrenceKey).digest("hex")}`,
      state: "dispatching" as const,
      attempts: 0,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      settledAt: null,
    } satisfies TriggerOccurrenceRecord;
    const claimed = this.store.durableTransaction(() => this.store.claimTriggerOccurrence(planned));
    const occurrence = claimed
      ? planned
      : this.store.getTriggerOccurrence(trigger.id, occurrenceKey);
    if (!occurrence) {
      throw new Error(`Trigger occurrence ${occurrenceKey} was claimed without a recoverable dispatch intent.`);
    }
    if (
      occurrence.workflowId !== planned.workflowId
      || occurrence.workflowRevision !== planned.workflowRevision
      || occurrence.workflowHash !== planned.workflowHash
      || occurrence.runId !== planned.runId
      || stableStringify(occurrence.input) !== stableStringify(planned.input)
    ) {
      throw new Error(`Trigger occurrence ${occurrenceKey} is already bound to a different durable dispatch.`);
    }
    if (occurrence.state === "settled") return;
    await this.dispatchOccurrence(occurrence);
  }

  private async dispatchOccurrence(occurrence: TriggerOccurrenceRecord): Promise<void> {
    if (occurrence.state === "settled") return;
    const attempting: TriggerOccurrenceRecord = {
      ...occurrence,
      attempts: occurrence.attempts + 1,
      error: null,
      updatedAt: nowIso(),
    };
    this.store.durableTransaction(() => this.store.replaceTriggerOccurrence(attempting));
    try {
      const run = this.engine.start(occurrence.workflowId, occurrence.input, {
        runId: occurrence.runId,
        workflowRevision: occurrence.workflowRevision,
        workflowHash: occurrence.workflowHash,
        origin: {
          kind: "cron",
          threadId: null,
          parentRunId: null,
          parentAgentId: null,
          baseDepth: -1,
          permissionCeiling: "full-access",
        },
      });
      const settledAt = nowIso();
      this.store.durableTransaction(() => {
        this.store.replaceTriggerOccurrence({
          ...attempting,
          state: "settled",
          error: null,
          updatedAt: settledAt,
          settledAt,
        });
        this.store.appendEvent({
          type: "workflow.trigger.dispatched",
          workflowId: occurrence.workflowId,
          runId: run.id,
          agentId: null,
          occurredAt: settledAt,
          payload: {
            triggerId: occurrence.triggerId,
            occurrenceKey: occurrence.occurrenceKey,
            scheduledAt: occurrence.scheduledAt,
            workflowRevision: occurrence.workflowRevision,
            workflowHash: occurrence.workflowHash,
            attempts: attempting.attempts,
          },
          provenance: { source: "workflow" },
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updatedAt = nowIso();
      this.store.durableTransaction(() => {
        this.store.replaceTriggerOccurrence({ ...attempting, error: message, updatedAt });
        this.store.appendEvent({
          type: "workflow.trigger.dispatch-failed",
          workflowId: occurrence.workflowId,
          runId: occurrence.runId,
          agentId: null,
          occurredAt: updatedAt,
          payload: {
            triggerId: occurrence.triggerId,
            occurrenceKey: occurrence.occurrenceKey,
            scheduledAt: occurrence.scheduledAt,
            workflowRevision: occurrence.workflowRevision,
            error: message,
          },
          provenance: { source: "workflow" },
        });
      });
      throw error;
    }
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

function isChatContainerRun(run: WorkflowRunRecord): boolean {
  if (!run.workflowId.startsWith("chat:")) return false;
  return run.id === `chat-run:${run.workflowId.slice("chat:".length)}`;
}

function stepAttemptAgentId(attempt: StepAttemptRecord): string | null {
  if (!attempt.input || typeof attempt.input !== "object" || Array.isArray(attempt.input)) return null;
  const agentId = (attempt.input as Record<string, JsonValue>).agentId;
  return typeof agentId === "string" ? agentId : null;
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

function evaluateCondition(condition: Condition, context: ExecutionContext): boolean {
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

function evaluateStep(step: EvaluateStep, context: ExecutionContext): JsonValue {
  const actual = getPath(context as unknown as JsonValue, step.path) ?? step.default;
  const target = step.target ?? null;
  const operator = step.operator ?? step.op;
  if (!operator) throw new Error(`Evaluation step ${step.id} requires an operator.`);
  const pass = operator === "exists"
    ? actual !== undefined && actual !== null
    : operator === "eq"
      ? stableStringify(actual) === stableStringify(target)
      : operator === "neq"
        ? stableStringify(actual) !== stableStringify(target)
        : typeof actual === "number" && typeof target === "number"
          ? operator === "gt" ? actual > target
            : operator === "gte" ? actual >= target
              : operator === "lt" ? actual < target
                : actual <= target
          : false;
  return { actual: actual ?? null, target, operator, pass };
}
