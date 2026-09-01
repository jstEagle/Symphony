import { createHash } from "node:crypto";
import {
  AgentWorkOrderSchema,
  ObjectiveBudgetDebitRecordSchema,
  ObjectiveBudgetReservationRecordSchema,
  ObjectiveBudgetUsageSchema,
  isObjectivePolicyHashValid,
  isTerminalAgentStatus,
  WorkspaceSpecSchema,
  type AgentRecord,
  type AgentWorkOrder,
  type EventEnvelope,
  type JsonValue,
  type ObjectiveApprovalRecord,
  type ObjectiveAttentionEvidenceRef,
  type ObjectiveAttentionAlternative,
  type ObjectiveAttentionBlockedResource,
  type ObjectiveAttentionRecord,
  type ObjectiveAttentionRequest,
  type ObjectiveBudgetLedgerRecord,
  type ObjectiveBudgetLimits,
  type ObjectiveBudgetReservationRecord,
  type ObjectiveBudgetUsage,
  type ObjectiveRunRecord,
  type ObjectiveSideEffectClass,
  type ObjectiveTaskRecord,
  type Permission,
  type WorkspaceSpec,
  objectiveControlExecutionId,
} from "@symphony/protocol";
import type { AgentCoordinator } from "@symphony/runtime";
import { ObjectiveAttentionRegistry, type SymphonyStore } from "@symphony/storage";
import {
  ObjectiveSupervisor,
  type ObjectiveSupervisorIntent,
} from "./objective-supervisor.js";
import {
  ObjectiveRuntime,
  objectiveControlApprovalRequestKey,
  type ObjectiveRepository,
  type ObjectiveRuntimeAuthority,
  type ObjectiveTaskUpdate,
} from "./objective-runtime.js";
import { childWorkspaceGrant, WorkspaceContainmentError } from "./workspace-containment.js";
import {
  type ObjectiveControlAcknowledgement,
  type ObjectiveControlAgentIntent,
  type ObjectiveControlIntent,
} from "./objective-control-plan.js";
import {
  normalizeObjectiveValueCharter,
  objectiveValueCharterBindingForSpec,
} from "./objective-values.js";
import {
  ObjectiveFeedbackRuntime,
  type ObjectiveFeedbackApplyOptions,
  type ObjectiveFeedbackRuntimeResult,
} from "./objective-feedback-runtime.js";
import type { ObjectiveFeedbackContext } from "./objective-feedback.js";

/** The durable projection owned by the daemon for one supervisor intent. */
export type ObjectiveSupervisionRecord = Readonly<{
  version: 1;
  runId: string;
  intentId: string;
  kind: ObjectiveSupervisorIntent["kind"] | ObjectiveControlIntent["kind"] | "malformed";
  state: "dispatched" | "waiting" | "attention" | "settled";
  attempts: Readonly<Record<string, string>>;
  updatedAt: string;
  detail: string | null;
}>;

export type ObjectiveSupervisionRunnerOptions = Readonly<{
  authority: ObjectiveRuntimeAuthority;
  /** Resolve a task workspace when the task did not carry one explicitly. */
  workspaceForTask?: (run: ObjectiveRunRecord, task: ObjectiveTaskRecord) => WorkspaceSpec | null;
  /** Resolve the immutable objective workspace capability for dispatch defense-in-depth. */
  workspaceGrantForRun?: (run: ObjectiveRunRecord) => WorkspaceSpec | null;
  /** Optional shared registry; tests and embedders may let the runner create one from the store. */
  attentionRegistry?: ObjectiveAttentionRegistry;
  /** Optional capability-result feedback seam; admission remains adapter-owned. */
  feedbackRuntime?: ObjectiveFeedbackRuntime;
  feedbackRepository?: import("@symphony/storage").CapabilityResultFeedbackRepository;
  now?: () => string;
}>;

export type ObjectiveSupervisionStepResult = Readonly<{
  runId: string;
  intent: ObjectiveSupervisorIntent | ObjectiveControlIntent;
  run: ObjectiveRunRecord;
  action: "dispatched" | "waiting" | "attention" | "settled" | "noop";
}>;

type BudgetGate =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "blocked"; reason: string; detail: string }>
  | Readonly<{ kind: "enabled"; policyHash: string; limits: ObjectiveBudgetLimits; ledger: ObjectiveBudgetLedgerRecord }>;

type AccountingBudget =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "blocked"; reason: string; detail: string }>
  | Readonly<{ kind: "enabled"; policyHash: string; limits: ObjectiveBudgetLimits; ledger: ObjectiveBudgetLedgerRecord }>;

type ReservationPreparation =
  | Readonly<{ kind: "ready"; reservation: ObjectiveBudgetReservationRecord; agent?: AgentRecord }>
  | Readonly<{ kind: "ambiguous"; detail: string }>
  | Readonly<{ kind: "blocked"; reason: string; detail: string }>;

type BudgetSettlement = Readonly<{ kind: "blocked"; reason: string; detail: string }>;
type AccountingBudgetLedger = ObjectiveBudgetLedgerRecord;
type ObjectiveAssignment = Readonly<{ attemptId: string; agentId: string | null; state: "claimed" | "dispatched" | "failed" }>;

const SUPERVISABLE_OBJECTIVE_STATES: ObjectiveRunRecord["state"][] = [
  "planning",
  "executing",
  "evaluating",
  "awaiting-approval",
  "replanning",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

/**
 * Daemon-owned bridge between the deterministic objective kernel and native
 * agents. One call performs at most one supervisor intent. Native lifecycle
 * events schedule another bounded call, so a malformed or long-running native
 * turn can never make this class spin in an unsafe loop.
 */
export class ObjectiveSupervisionRunner {
  private readonly supervisor: ObjectiveSupervisor;
  private readonly now: () => string;
  private readonly inFlight = new Map<string, Promise<ObjectiveSupervisionStepResult>>();
  private readonly pendingWakeups = new Set<string>();
  /** Daemon-owned wakeups; persisted due/expiry timestamps are re-armed on recovery. */
  private readonly suspensionTimers = new Map<string, NodeJS.Timeout>();
  private unsubscribe: (() => void) | null = null;
  private accepting = true;

  constructor(
    private readonly runtime: ObjectiveRuntime,
    private readonly repository: ObjectiveRepository,
    private readonly agents: AgentCoordinator,
    private readonly store: SymphonyStore,
    options: ObjectiveSupervisionRunnerOptions,
  ) {
    this.supervisor = new ObjectiveSupervisor(runtime, repository, options.authority);
    this.options = options;
    this.attentionRegistry = options.attentionRegistry ?? new ObjectiveAttentionRegistry(store);
    this.now = options.now ?? (() => new Date().toISOString());
    this.feedbackRuntime = options.feedbackRuntime
      ?? (options.feedbackRepository
        ? new ObjectiveFeedbackRuntime({
            feedbackRepository: options.feedbackRepository,
            objectiveRepository: repository,
            runtime,
            authority: options.authority,
            attentionRegistry: this.attentionRegistry,
            now: this.now,
          })
        : null);
  }

  private readonly options: ObjectiveSupervisionRunnerOptions;
  private readonly attentionRegistry: ObjectiveAttentionRegistry;
  private readonly feedbackRuntime: ObjectiveFeedbackRuntime | null;

  /**
   * Consume an accepted capability result at the supervision boundary. This
   * is deliberately explicit: adapters submit records, while this runner
   * owns the only path that may apply objective operations.
   */
  processCapabilityResultFeedback(
    feedback: import("@symphony/protocol").CapabilityResultFeedbackRecord,
    context: ObjectiveFeedbackContext,
    apply: ObjectiveFeedbackApplyOptions = {},
  ): ObjectiveFeedbackRuntimeResult {
    if (!this.feedbackRuntime) throw new Error("Capability-result feedback is not configured for this objective supervisor.");
    return this.feedbackRuntime.processAccepted(feedback, context, apply);
  }

  /** Subscribe to native progress and terminal evidence. Calling this more than once is safe. */
  start(): void {
    this.accepting = true;
    // Replay semantic objective events whose acknowledgement transaction
    // committed before a prior daemon generation reached post-commit delivery.
    // The outbox is idempotent, so this is safe on every runner start.
    try {
      this.repository.drainObjectiveEventOutbox?.();
    } catch {
      // A malformed or temporarily undeliverable entry remains pending and is
      // retried on the next lifecycle/event boundary; startup must stay live.
    }
    if (this.unsubscribe) return;
    this.unsubscribe = this.store.onEvent((event) => {
      const nativeProgress = isNativeProgressEvent(event);
      if (!nativeProgress && (!event.type.startsWith("objective.") || isRunnerNotificationEvent(event.type))) return;
      const agent = nativeProgress && event.agentId ? this.store.getAgent(event.agentId) : null;
      const run = this.store.getObjectiveRun(event.runId ?? agent?.runId ?? "");
      if (!run || !shouldSupervise(run)) return;
      this.wake(run, agent);
    });
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pendingWakeups.clear();
    for (const timer of this.suspensionTimers.values()) clearTimeout(timer);
    this.suspensionTimers.clear();
    // Native callbacks can synchronously race daemon shutdown. Do not let
    // the store close underneath a supervision acknowledgement or assignment
    // write; the daemon awaits this drain before closing SQLite.
    await Promise.allSettled([...this.inFlight.values()]);
  }

  /** Recover active objectives in bounded, per-run-isolated workers. */
  async recover(): Promise<ObjectiveSupervisionStepResult[]> {
    const runs = this.store.listObjectiveRuns({ state: SUPERVISABLE_OBJECTIVE_STATES, limit: 2_000 });
    const results: ObjectiveSupervisionStepResult[] = [];
    let nextRun = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextRun++;
        const run = runs[index];
        if (!run) return;
        try {
          results.push(await this.step(run.runId));
        } catch (error) {
          // A malformed run must be visible and isolated to itself. Recovery
          // of the remaining objectives must still be allowed to proceed.
          if (this.readRecord(run.runId)?.state !== "attention") this.recordAttention(run, error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, runs.length) }, () => worker()));
    return results;
  }

  /** Run exactly one deterministic supervisor intent for a durable run. */
  step(runId: string): Promise<ObjectiveSupervisionStepResult> {
    if (!this.accepting) return Promise.reject(new Error("Objective supervision runner is stopped."));
    const existing = this.inFlight.get(runId);
    if (existing) {
      this.pendingWakeups.add(runId);
      return existing;
    }
    // Put the promise in the in-flight fence before invoking stepOnce. Native
    // adapters may synchronously publish progress from create(); deferring the
    // step by one microtask prevents that callback from entering a duplicate
    // dispatch before this call has claimed the run.
    const operation = Promise.resolve().then(() => this.stepOnce(runId)).catch((error) => {
      const current = this.store.getObjectiveRun(runId);
      if (current) this.recordAttention(current, error);
      throw error;
    }).finally(() => {
      this.inFlight.delete(runId);
      if (!this.pendingWakeups.delete(runId)) return;
      if (!this.accepting) return;
      queueMicrotask(() => {
        void this.step(runId).catch(() => undefined);
      });
    });
    this.inFlight.set(runId, operation);
    return operation;
  }

  private async stepOnce(runId: string): Promise<ObjectiveSupervisionStepResult> {
    const run = this.runtime.get(runId);
    const controlState = this.runtime.controlState(runId);
    if (controlState) return await this.stepControl(run, controlState);
    const intent = this.supervisor.next(run);
    const previous = this.readRecord(runId);
    if (previous?.intentId === intent.intentId && ["attention", "settled"].includes(previous.state)
      && !(previous.state === "attention" && isRetryableBudgetAttention(previous.detail))) {
      return { runId, intent, run, action: "noop" };
    }

    if (intent.kind === "dispatch") return await this.dispatch(run, intent);
    if (intent.kind === "evaluate") return await this.evaluate(run, intent);
    if (intent.kind === "replan") return await this.replan(run, intent);
    if (intent.kind === "wait-for-approval") return this.approval(run, intent);
    return this.finish(run, intent);
  }

  private async stepControl(
    run: ObjectiveRunRecord,
    _state: ReturnType<ObjectiveRuntime["controlState"]> & object,
  ): Promise<ObjectiveSupervisionStepResult> {
    const intent = this.runtime.nextControlIntent(run.runId);
    if (!intent) throw new Error(`Objective ${run.runId} control head disappeared during supervision.`);
    // Completion approval is a run-level durable approval, not a control-node
    // acknowledgement. Once it resolves, the approval transition has already
    // terminally settled the objective; do not ask for it again on the wakeup.
    if (intent.kind === "complete" && run.state === "succeeded") {
      this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "settled", attempts: {}, updatedAt: this.now(), detail: null });
      return { runId: run.runId, intent, run, action: "settled" };
    }
    const previous = this.readRecord(run.runId);
    // Approval attention is re-evaluated after a durable resolveApproval
    // transition. Other attention/settled records remain idempotent noops.
    if (previous && previous.intentId === intent.intentId && ["attention", "settled"].includes(previous.state)
      && !(intent.kind === "agent" && intent.operation === "approval")) {
      return { runId: run.runId, intent, run, action: "noop" };
    }

    if (intent.kind === "agent") return await this.controlAgent(run, intent);
    if (intent.kind === "timer" || intent.kind === "signal") return this.controlSuspension(run, intent);
    if (intent.kind === "wait") {
      // A declarative control wait is a real supervision boundary even though
      // it remains an ordinary waiting action. Materialize the durable item
      // while retaining the existing wake/retry semantics for the reducer.
      this.materializeAttention(run, intent, intent.reason ?? "Control frontier is waiting.", { category: "control-wait" });
      this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "waiting", attempts: {}, updatedAt: this.now(), detail: intent.reason ?? "Control frontier is waiting." });
      return { runId: run.runId, intent, run, action: "waiting" };
    }

    const requestKey = controlAcknowledgementKey(intent.intentId);
    const acknowledgement: ObjectiveControlAcknowledgement = {
      kind: intent.kind,
      intentId: intent.intentId,
      requestKey,
      eventCursor: this.store.latestCursor(),
      now: this.now(),
      ...(intent.kind === "if" || intent.kind === "while" ? { condition: intent.conditionValue ?? false } : {}),
      ...(intent.kind === "complete" ? { evidence: this.controlEvidence(run.runId) } : {}),
      ...(intent.kind === "evaluate" ? {
        actual: intent.actual,
        target: intent.target,
        operator: intent.operator,
        pass: intent.pass,
        output: intent.output,
        evidence: {
          eventCursor: this.store.latestCursor(),
          eventIds: [],
          summary: `Evaluation ${intent.metric} resolved from durable snapshot context.`,
        },
      } : {}),
    };
    const approvalPolicy = run.policy?.approvalPolicy ?? run.spec.approvalPolicy;
    if (intent.kind === "complete" && approvalPolicy.mode === "before-completion") {
      let approvalRun = run;
      if (run.pendingApprovalId === null) {
        try {
          approvalRun = this.runtime.requestApproval(run.runId, {
            kind: "completion",
            taskId: null,
            question: "Approve completion of this objective control plan.",
            scope: { controlIntentId: intent.intentId, evidence: this.controlEvidence(run.runId) },
            operationId: `objective-control-completion:${run.runId}:${intent.intentId}`,
            requestHash: `objective-control-completion:${intent.intentId}`,
            policyHash: run.policyHash ?? run.workflowHash,
            sideEffectClass: "local",
            canonicalTarget: `${run.workflowId}:${run.objectiveId}:control-completion`,
            expiresAt: null,
            requestKey: `objective-control-completion:${intent.intentId}`,
          }, this.options.authority);
        } catch (error) {
          return this.attention(run, intent, messageOf(error));
        }
      }
      return this.attention(approvalRun, intent, "Objective control completion is held for the durable before-completion approval policy.");
    }
    try {
      this.runtime.acknowledgeControl(run.runId, acknowledgement, this.options.authority);
      this.repository.drainObjectiveEventOutbox?.();
    } catch (error) {
      return this.attention(run, intent, messageOf(error));
    }
    const nextRun = this.runtime.get(run.runId);
    const action = intent.kind === "complete" || intent.kind === "evaluate" ? "settled" : "dispatched";
    this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: action === "settled" ? "settled" : "dispatched", attempts: {}, updatedAt: this.now(), detail: null });
    return { runId: run.runId, intent, run: nextRun, action };
  }

  private controlSuspension(
    run: ObjectiveRunRecord,
    intent: Extract<ObjectiveControlIntent, { kind: "timer" | "signal" }>,
  ): ObjectiveSupervisionStepResult {
    const now = this.now();
    if (intent.kind === "timer" && intent.operation === "schedule") {
      const since = now;
      const dueAt = new Date(Date.parse(since) + intent.node.durationMs).toISOString();
      const expiresAt = intent.node.expiresAfterMs === null ? null : new Date(Date.parse(since) + (intent.node.expiresAfterMs ?? intent.node.durationMs)).toISOString();
      try {
        this.runtime.acknowledgeControl(run.runId, {
          kind: "timer",
          intentId: intent.intentId,
          requestKey: `objective-control-timer:${run.runId}:${objectiveControlExecutionId(intent.execution)}`,
          since,
          dueAt,
          expiresAt,
          now,
          eventCursor: this.store.latestCursor(),
        }, this.options.authority);
      } catch (error) {
        return this.attention(run, intent, messageOf(error));
      }
      this.armSuspensionWake(run.runId, dueAt);
      const next = this.runtime.get(run.runId);
      this.materializeAttention(run, intent, `Waiting for timer until ${dueAt}.`, { category: "control-wait", expiresAt });
      this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "waiting", attempts: { [objectiveControlExecutionId(intent.execution)]: intent.attemptId }, updatedAt: now, detail: `Waiting for timer until ${dueAt}.` });
      return { runId: run.runId, intent, run: next, action: "waiting" };
    }
    if (intent.kind === "signal" && intent.operation === "subscribe") {
      const since = now;
      const expiresAt = intent.node.expiresAfterMs === null ? null : new Date(Date.parse(since) + (intent.node.expiresAfterMs ?? 0)).toISOString();
      try {
        this.runtime.acknowledgeControl(run.runId, {
          kind: "signal",
          intentId: intent.intentId,
          requestKey: `objective-control-signal-subscribe:${run.runId}:${objectiveControlExecutionId(intent.execution)}`,
          signalKey: intent.signalKey,
          since,
          expiresAt,
          now,
          eventCursor: this.store.latestCursor(),
        }, this.options.authority);
      } catch (error) {
        return this.attention(run, intent, messageOf(error));
      }
      if (expiresAt) this.armSuspensionWake(run.runId, expiresAt);
      const next = this.runtime.get(run.runId);
      this.materializeAttention(run, intent, expiresAt ? `Waiting for ${intent.signalKey} until ${expiresAt}.` : `Waiting for ${intent.signalKey}.`, { category: "control-wait", expiresAt });
      this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "waiting", attempts: { [objectiveControlExecutionId(intent.execution)]: intent.attemptId }, updatedAt: now, detail: expiresAt ? `Waiting for ${intent.signalKey} until ${expiresAt}.` : `Waiting for ${intent.signalKey}.` });
      return { runId: run.runId, intent, run: next, action: "waiting" };
    }
    const wakeAt = intent.kind === "timer" ? intent.dueAt : intent.expiresAt;
    if (intent.operation === "wait") {
      if (wakeAt) this.armSuspensionWake(run.runId, wakeAt);
      this.materializeAttention(run, intent, intent.kind === "timer"
        ? `Waiting for timer until ${intent.dueAt}.`
        : intent.expiresAt
          ? `Waiting for ${intent.signalKey} until ${intent.expiresAt}.`
          : `Waiting for ${intent.signalKey}.`, { category: "control-wait" });
      this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "waiting", attempts: { [objectiveControlExecutionId(intent.execution)]: intent.attemptId }, updatedAt: now, detail: intent.kind === "timer" ? `Waiting for timer until ${intent.dueAt}.` : intent.expiresAt ? `Waiting for ${intent.signalKey} until ${intent.expiresAt}.` : `Waiting for ${intent.signalKey}.` });
      return { runId: run.runId, intent, run, action: "waiting" };
    }
    const requestKey = `${intent.kind === "timer" ? "objective-control-timer-due" : "objective-control-signal-expiry"}:${run.runId}:${objectiveControlExecutionId(intent.execution)}:${wakeAt ?? "none"}`;
    try {
      this.runtime.acknowledgeControl(run.runId, { kind: intent.kind, intentId: intent.intentId, requestKey, now, eventCursor: this.store.latestCursor() }, this.options.authority);
      this.repository.drainObjectiveEventOutbox?.();
    } catch (error) {
      return this.attention(run, intent, messageOf(error));
    }
    this.clearSuspensionWake(run.runId);
    const next = this.runtime.get(run.runId);
    this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "settled", attempts: { [objectiveControlExecutionId(intent.execution)]: intent.attemptId }, updatedAt: now, detail: null });
    return { runId: run.runId, intent, run: next, action: "settled" };
  }

  private armSuspensionWake(runId: string, at: string): void {
    this.clearSuspensionWake(runId);
    const delay = Math.max(0, Date.parse(at) - Date.now());
    const timer = setTimeout(() => {
      this.suspensionTimers.delete(runId);
      void this.step(runId).catch(() => undefined);
    }, Math.min(delay, 2_147_483_647));
    timer.unref();
    this.suspensionTimers.set(runId, timer);
  }

  private clearSuspensionWake(runId: string): void {
    const timer = this.suspensionTimers.get(runId);
    if (!timer) return;
    clearTimeout(timer);
    this.suspensionTimers.delete(runId);
  }

  private async controlAgent(
    run: ObjectiveRunRecord,
    intent: ObjectiveControlAgentIntent,
  ): Promise<ObjectiveSupervisionStepResult> {
    if (intent.operation === "approval") {
      let approval = this.controlApprovalForIntent(run, intent);
      let approvalRun = run;
      if (!approval) {
        try {
          approvalRun = this.runtime.requestApproval(run.runId, {
            kind: "control",
            taskId: null,
            question: `Approve dispatch of control node ${intent.nodeId}.`,
            scope: {
              controlIntentId: intent.intentId,
              controlNodeId: intent.nodeId,
              controlExecutionKey: intent.execution,
              controlAttemptId: intent.attemptId,
            },
            operationId: `objective-control:${run.runId}:${objectiveControlExecutionId(intent.execution)}`,
            requestHash: `objective-control-approval:${intent.intentId}`,
            policyHash: run.policyHash ?? run.workflowHash,
            sideEffectClass: "local",
            canonicalTarget: `${run.workflowId}:${run.objectiveId}:control:${intent.nodeId}`,
            expiresAt: null,
            requestKey: objectiveControlApprovalRequestKey(intent.intentId),
          }, this.options.authority);
          approval = this.controlApprovalForIntent(approvalRun, intent);
        } catch (error) {
          return this.attention(run, intent, messageOf(error));
        }
      }
      if (!approval) return this.attention(approvalRun, intent, "Control-node approval request was not durably materialized.");
      if (approval.status !== "requested") {
        const approved = approval.status === "approved";
        try {
          this.runtime.acknowledgeControl(run.runId, {
            kind: "agent",
            intentId: intent.intentId,
            requestKey: controlAcknowledgementKey(intent.intentId),
            approved,
            reason: approved ? "Durable control-node approval resolved." : `Control-node approval ${approval.status}.`,
            eventCursor: this.store.latestCursor(),
            now: this.now(),
          }, this.options.authority);
          this.repository.drainObjectiveEventOutbox?.();
          const nextRun = this.runtime.get(run.runId);
          const action = approved ? "dispatched" : "settled";
          this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: action === "settled" ? "settled" : "dispatched", attempts: { [objectiveControlExecutionId(intent.execution)]: intent.attemptId }, updatedAt: this.now(), detail: null });
          return { runId: run.runId, intent, run: nextRun, action };
        } catch (error) {
          return this.attention(approvalRun, intent, messageOf(error));
        }
      }
      const detail = `Control agent ${intent.nodeId} is waiting for durable approval before dispatch.`;
      return this.attention(run, intent, detail, {
        category: "approval",
        attempts: { [objectiveControlExecutionId(intent.execution)]: intent.attemptId },
      });
    }
    const parent = this.parentAgent(run);
    if (!run.conductorAgentId) return this.attention(run, intent, "Objective control dispatch requires an attached conductor; daemon will not guess ownership.");
    if (!parent) return this.attention(run, intent, "The objective control conductor is no longer present; dispatch is held for explicit recovery.");

    const assignment = this.readControlAssignment(run.runId, intent);
    let attemptAgent: AgentRecord | null = assignment?.agentId ? this.store.getAgent(assignment.agentId) : null;
    if (!attemptAgent) attemptAgent = this.store.getAgentByLogicalAgentId(intent.attemptId);
    if (attemptAgent && (
      attemptAgent.workflowId !== run.workflowId
      || attemptAgent.runId !== run.runId
      || attemptAgent.logicalAgentId !== intent.attemptId
    )) {
      return this.attention(run, intent, "Objective control attempt identity belongs to a different workflow/run; dispatch is held for explicit recovery.");
    }
    if (assignment?.state === "failed" && !attemptAgent) {
      return this.attention(run, intent, "Objective control attempt has a durable failed dispatch assignment without a recoverable native identity.");
    }
    let workspace: WorkspaceSpec;
    try {
      const requested = intent.node.workspace ?? this.conductorWorkspace(parent);
      const granted = this.grantedWorkspace(run, requested);
      if (!granted) throw new Error(`Control node ${intent.nodeId} has no workspace; daemon will not guess one.`);
      workspace = granted;
    } catch (error) {
      return this.attention(run, intent, messageOf(error));
    }

    const executionId = objectiveControlExecutionId(intent.execution);
    this.saveControlAssignment(run.runId, intent, intent.attemptId, attemptAgent?.id ?? null, "claimed");
    try {
      const agent = attemptAgent ?? await this.agents.create(this.controlWorkOrder(run, intent, parent, workspace));
      if (agent.status === "cancelled" || agent.status === "interrupted" || agent.status === "lost") {
        return this.attention(run, intent, `Control node ${intent.nodeId} has inconclusive native outcome ${agent.status}; daemon will not report it as success or failure.`);
      }
      if (agent.status === "completed" || agent.status === "failed") {
        if (!this.hasTerminalEvidence(run, agent, intent.attemptId, agent.status)) {
          this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "waiting", attempts: { [executionId]: intent.attemptId }, updatedAt: this.now(), detail: "Waiting for matching durable terminal evidence for the control attempt." });
          return { runId: run.runId, intent, run, action: "waiting" };
        }
        const evidence = this.controlEvidenceForAgent(run.runId, agent, intent.attemptId, agent.status);
        this.runtime.acknowledgeControl(run.runId, {
          kind: "agent",
          intentId: intent.intentId,
          requestKey: controlAcknowledgementKey(intent.intentId),
          attemptId: intent.attemptId,
          agentId: agent.id,
          state: agent.status,
          ...(agent.output === null ? {} : { output: agent.output }),
          ...(agent.error === null ? {} : { error: agent.error }),
          eventCursor: evidence.eventCursor,
          evidence,
          now: this.now(),
        }, this.options.authority);
        this.repository.drainObjectiveEventOutbox?.();
        this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "dispatched", attempts: { [executionId]: intent.attemptId }, updatedAt: this.now(), detail: null });
        return { runId: run.runId, intent, run: this.runtime.get(run.runId), action: "dispatched" };
      }
      if (assignment?.state === "dispatched") {
        this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "waiting", attempts: { [executionId]: intent.attemptId }, updatedAt: this.now(), detail: "Waiting for native control-agent terminal evidence." });
        return { runId: run.runId, intent, run, action: "waiting" };
      }
      if (!["starting", "running"].includes(agent.status)) {
        this.saveControlAssignment(run.runId, intent, intent.attemptId, agent.id, "claimed");
        this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "waiting", attempts: { [executionId]: intent.attemptId }, updatedAt: this.now(), detail: `Waiting for native control attempt startup (${agent.status}).` });
        return { runId: run.runId, intent, run, action: "waiting" };
      }
      this.saveControlAssignment(run.runId, intent, intent.attemptId, agent.id, "dispatched");
      this.runtime.acknowledgeControl(run.runId, {
        kind: "agent",
        intentId: intent.intentId,
        requestKey: controlAcknowledgementKey(intent.intentId),
        attemptId: intent.attemptId,
        agentId: agent.id,
        state: "running",
        eventCursor: this.store.latestCursor(),
        now: this.now(),
      }, this.options.authority);
      this.repository.drainObjectiveEventOutbox?.();
      this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "dispatched", attempts: { [executionId]: intent.attemptId }, updatedAt: this.now(), detail: null });
      return { runId: run.runId, intent, run: this.runtime.get(run.runId), action: "dispatched" };
    } catch (error) {
      this.saveControlAssignment(run.runId, intent, intent.attemptId, attemptAgent?.id ?? null, "failed", messageOf(error));
      return this.attention(run, intent, `Control node ${intent.nodeId} could not be dispatched: ${messageOf(error)}`);
    }
  }

  private async dispatch(
    run: ObjectiveRunRecord,
    intent: Extract<ObjectiveSupervisorIntent, { kind: "dispatch" }>,
  ): Promise<ObjectiveSupervisionStepResult> {
    const parent = this.parentAgent(run);
    if (!run.conductorAgentId) return this.attention(run, intent, "Objective task dispatch requires an attached conductor; daemon will not guess ownership.");
    if (!parent) return this.attention(run, intent, "The objective conductor is no longer present; dispatch is held for explicit recovery.");

    const updates: ObjectiveTaskUpdate[] = [];
    const attempts: Record<string, string> = {};
    let waitingForStartup = false;
    let uncertainOutcome: string | null = null;
    for (const task of intent.tasks) {
      const attemptId = task.attemptId ?? objectiveAttemptId(run.runId, task.task.id, intent.intentId);
      attempts[task.task.id] = attemptId;
      const requestedWorkspace = task.task.workspace ?? this.options.workspaceForTask?.(run, task) ?? this.conductorWorkspace(parent);
      let workspace: WorkspaceSpec;
      try {
        const granted = this.grantedWorkspace(run, requestedWorkspace);
        if (!granted) throw new Error(`Objective task ${task.task.id} has no workspace; daemon will not guess one.`);
        workspace = granted;
      } catch (error) {
        return this.attention(run, intent, messageOf(error));
      }
      const budget = this.dispatchBudget(run, parent.depth + 1);
      if (budget.kind === "blocked") return this.budgetAttention(run, intent, budget.detail, budget.reason);
      let reservation: ObjectiveBudgetReservationRecord | null = null;
      let replayedAgent: AgentRecord | null = null;
      if (budget.kind === "enabled") {
        const prepared = this.prepareReservation(run, intent.intentId, task.task.id, attemptId, budget);
        if (prepared.kind === "blocked") {
          // Saturating the objective's concurrency window is ordinary
          // backpressure, not an exhausted budget. Keep the frontier queued
          // and let the terminal event from an in-flight attempt wake this
          // runner after its reservation is released/consumed.
          if (prepared.reason === "concurrency-backpressure") {
            return this.backpressure(run, intent, prepared.detail, attempts);
          }
          return this.budgetAttention(run, intent, prepared.detail, prepared.reason);
        }
        if (prepared.kind === "ambiguous") return this.budgetAttention(run, intent, prepared.detail, "crash-recovery");
        reservation = prepared.reservation;
        replayedAgent = prepared.agent ?? null;
      }
      // Claim the logical assignment before crossing into native execution.
      // If the daemon dies after this write but before create() returns, the
      // same deterministic work-order id is replayed and AgentCoordinator's
      // logical-agent fence returns the existing agent instead of spawning a
      // second native turn.
      this.saveRecord({
        version: 1,
        runId: run.runId,
        intentId: intent.intentId,
        kind: intent.kind,
        state: "dispatched",
        attempts,
        updatedAt: this.now(),
        detail: null,
      });
      const priorAssignment = this.readAssignment(run.runId, intent.intentId, task.task.id);
      this.saveAssignment(run.runId, intent.intentId, task.task.id, attemptId, priorAssignment?.agentId ?? null, "claimed");
      try {
        const agent = replayedAgent ?? await this.agents.create(this.workOrder(run, task, attemptId, intent.intentId, parent, workspace, reservation));
        if (isTerminalAgentStatus(agent.status)) {
          // AgentCoordinator persists the native agent record before a start
          // request crosses the driver boundary. A completed/failed record
          // returned while replaying a deterministic logical attempt is thus
          // a durable terminal projection, not an in-flight create result.
          // Reconcile it into this dispatch checkpoint immediately; otherwise
          // a fast native completion can leave the objective queued forever.
          if (agent.status === "cancelled" || agent.status === "interrupted" || agent.status === "lost") {
            this.saveAssignment(run.runId, intent.intentId, task.task.id, attemptId, agent.id, "claimed");
            uncertainOutcome = `Task ${task.task.id} has inconclusive native outcome ${agent.status}; daemon will not report it as success or failure.`;
            waitingForStartup = true;
            continue;
          }
          if (agent.status !== "completed" && agent.status !== "failed") {
            this.saveAssignment(run.runId, intent.intentId, task.task.id, attemptId, agent.id, "claimed");
            waitingForStartup = true;
            continue;
          }
          if (!this.hasTerminalEvidence(run, agent, attemptId, agent.status)) {
            this.saveAssignment(run.runId, intent.intentId, task.task.id, attemptId, agent.id, "claimed");
            uncertainOutcome = `Task ${task.task.id} has a durable ${agent.status} projection but no matching terminal event yet; daemon will not acknowledge it until the evidence is durable.`;
            waitingForStartup = true;
            continue;
          }
          const budgetSettlement = this.settleAttemptReservation(run, attemptId, task.task.id, agent);
          if (budgetSettlement) return this.budgetAttention(run, intent, budgetSettlement.detail, budgetSettlement.reason);
          const state = agent.status === "completed" ? "completed" : "failed";
          this.saveAssignment(run.runId, intent.intentId, task.task.id, attemptId, agent.id, "dispatched");
          updates.push({
            taskId: task.task.id,
            state,
            attemptId,
            agentId: agent.id,
            ...(agent.output === null ? {} : { output: agent.output }),
            ...(agent.error === null ? {} : { error: agent.error }),
            ...(agent.startedAt === null ? {} : { startedAt: agent.startedAt }),
            ...(agent.finishedAt === null ? {} : { finishedAt: agent.finishedAt }),
          });
          this.emit(run, state === "completed" ? "objective.task.completed" : "objective.task.failed", {
            taskId: task.task.id,
            attemptId,
            intentId: intent.intentId,
            agentId: agent.id,
            state,
            continuity: "durable-terminal-replay",
          });
          continue;
        }
        const state = agentTaskState(agent);
        this.saveAssignment(run.runId, intent.intentId, task.task.id, attemptId, agent.id, state ? "dispatched" : "claimed");
        if (!state) {
          if (isUncertainAgentStatus(agent.status)) {
            uncertainOutcome = `Task ${task.task.id} has inconclusive native outcome ${agent.status}; daemon will not report it as success or failure.`;
          }
          waitingForStartup = true;
          continue;
        }
        updates.push({
          taskId: task.task.id,
          state,
          attemptId,
          agentId: agent.id,
          ...(agent.output === null ? {} : { output: agent.output }),
          ...(agent.error === null ? {} : { error: agent.error }),
          ...(agent.startedAt === null ? {} : { startedAt: agent.startedAt }),
          ...(agent.finishedAt === null ? {} : { finishedAt: agent.finishedAt }),
        });
        this.emit(run, "objective.task.dispatched", { taskId: task.task.id, attemptId, agentId: agent.id, intentId: intent.intentId, state });
      } catch (error) {
        if (reservation) this.releaseReservation(reservation);
        updates.push({ taskId: task.task.id, state: "failed", attemptId, error: messageOf(error) });
        this.saveAssignment(run.runId, intent.intentId, task.task.id, attemptId, null, "failed", messageOf(error));
        this.emit(run, "objective.task.failed", { taskId: task.task.id, attemptId, intentId: intent.intentId, error: messageOf(error) });
      }
    }

    if (uncertainOutcome) return this.attention(run, intent, uncertainOutcome);
    if (waitingForStartup || updates.length !== intent.tasks.length) {
      this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "waiting", attempts, updatedAt: this.now(), detail: "Waiting for native agent startup evidence before acknowledging dispatch." });
      return { runId: run.runId, intent, run, action: "waiting" };
    }

    let next: ObjectiveRunRecord;
    try {
      next = this.supervisor.acknowledge(run.runId, {
        kind: "dispatch",
        intentId: intent.intentId,
        requestKey: intent.acknowledgementKey,
        eventCursor: Math.max(this.store.latestCursor(), intent.expectedEventCursor),
        taskUpdates: updates,
        reason: "Daemon dispatched the objective frontier through native agents.",
      });
    } catch (error) {
      // Another daemon-owned runner may have acknowledged this same frontier
      // between our read and the durable CAS. Re-read the intent before
      // surfacing an error; a changed intent is successful concurrent replay,
      // not a reason to create another native attempt.
      const latest = this.runtime.get(run.runId);
      if (this.supervisor.next(latest).intentId !== intent.intentId) {
        return { runId: run.runId, intent, run: latest, action: "waiting" };
      }
      throw error;
    }
    this.saveRecord({
      version: 1,
      runId: run.runId,
      intentId: intent.intentId,
      kind: intent.kind,
      state: "dispatched",
      attempts,
      updatedAt: this.now(),
      detail: null,
    });
    return { runId: run.runId, intent, run: next, action: "dispatched" };
  }

  private async evaluate(
    run: ObjectiveRunRecord,
    intent: Extract<ObjectiveSupervisorIntent, { kind: "evaluate" }>,
  ): Promise<ObjectiveSupervisionStepResult> {
    const taskUpdates: ObjectiveTaskUpdate[] = [];
    for (const task of run.tasks) {
      if (!task.agentId) continue;
      const agent = this.store.getAgent(task.agentId);
      if (!agent || agent.runId !== run.runId || !isTerminalAgentStatus(agent.status)) continue;
      if (["cancelled", "interrupted", "lost"].includes(agent.status)) {
        return this.attention(run, intent, `Task ${task.task.id} has inconclusive native outcome ${agent.status}; daemon will not report it as success or failure.`);
      }
      if (agent.status !== "completed" && agent.status !== "failed") continue;
      if (!task.attemptId || !this.hasTerminalEvidence(run, agent, task.attemptId, agent.status)) continue;
      const budgetSettlement = this.settleReservation(run, task, agent);
      if (budgetSettlement) return this.budgetAttention(run, intent, budgetSettlement.detail, budgetSettlement.reason);
      taskUpdates.push({
        taskId: task.task.id,
        state: agent.status === "completed" ? "completed" : "failed",
        ...(task.attemptId === null ? {} : { attemptId: task.attemptId }),
        agentId: agent.id,
        ...(agent.output === null ? {} : { output: agent.output }),
        ...(agent.error === null ? {} : { error: agent.error }),
        ...(agent.startedAt === null ? {} : { startedAt: agent.startedAt }),
        ...(agent.finishedAt === null ? {} : { finishedAt: agent.finishedAt }),
      });
    }
    const allSettled = run.tasks.every((task) => {
      if (["completed", "failed", "blocked", "superseded"].includes(task.state)) return true;
      const agent = task.agentId ? this.store.getAgent(task.agentId) : null;
      return Boolean(agent && agent.runId === run.runId && task.attemptId
        && isTerminalAgentStatus(agent.status)
        && (agent.status === "completed" || agent.status === "failed")
        && this.hasTerminalEvidence(run, agent, task.attemptId, agent.status));
    });
    if (!allSettled) {
      this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "waiting", attempts: {}, updatedAt: this.now(), detail: "Waiting for terminal native agent evidence." });
      return { runId: run.runId, intent, run, action: "waiting" };
    }
    const outputTasks: Record<string, JsonValue> = {};
    const existingTasks = run.context.tasks;
    if (existingTasks && typeof existingTasks === "object" && !Array.isArray(existingTasks)) {
      for (const [taskId, output] of Object.entries(existingTasks)) outputTasks[taskId] = output;
    }
    for (const update of taskUpdates) if (update.state === "completed") outputTasks[update.taskId] = update.output ?? null;
    const context = Object.keys(outputTasks).length > 0
      ? { ...run.context, tasks: outputTasks }
      : run.context;
    const next = this.supervisor.acknowledge(run.runId, {
      kind: "evaluate",
      intentId: intent.intentId,
      requestKey: intent.acknowledgementKey,
      eventCursor: Math.max(this.store.latestCursor(), intent.expectedEventCursor),
      taskUpdates,
      context,
      reason: "Daemon reconciled terminal native agent evidence into an objective checkpoint.",
    });
    this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "dispatched", attempts: {}, updatedAt: this.now(), detail: null });
    this.emit(next, "objective.evaluation.completed", { intentId: intent.intentId, eventCursor: this.store.latestCursor(), state: next.state });
    return { runId: run.runId, intent, run: next, action: "dispatched" };
  }

  private dispatchBudget(run: ObjectiveRunRecord, depth: number): BudgetGate {
    const policy = run.policy;
    if (!policy) return { kind: "disabled" };
    if (!run.policyHash || run.policyHash !== policy.policyHash || !isObjectivePolicyHashValid(policy)) {
      return { kind: "blocked", reason: "crash-recovery", detail: "Objective policy identity is incomplete; dispatch is held for explicit attention." };
    }
    const limits = policy.budget;
    if (policy.expiresAt !== null && Date.parse(policy.expiresAt) <= Date.parse(this.now())) {
      return { kind: "blocked", reason: "policy-expired", detail: "The objective policy has expired; no new objective agent dispatch is allowed." };
    }
    if (limits.maxDepth !== null && depth > limits.maxDepth) {
      return { kind: "blocked", reason: "budget-exhausted", detail: `Objective maximum agent depth ${limits.maxDepth} would be exceeded by depth ${depth}.` };
    }
    const ledger = this.store.getObjectiveBudgetLedger(run.runId);
    if (!ledger) {
      return { kind: "blocked", reason: "crash-recovery", detail: "The objective has a policy budget but no durable budget ledger; dispatch is held for explicit recovery." };
    }
    if (ledger.policyHash !== policy.policyHash || !sameJson(ledger.limits, limits)) {
      return { kind: "blocked", reason: "crash-recovery", detail: "The objective budget ledger does not match its immutable policy snapshot; dispatch is held for explicit recovery." };
    }
    if (ledger.status === "exhausted") {
      return { kind: "blocked", reason: "budget-exhausted", detail: `The objective budget is exhausted${ledger.pauseReason ? ` (${ledger.pauseReason})` : ""}; no new dispatch is allowed.` };
    }
    if (ledger.status === "paused") {
      return { kind: "blocked", reason: ledger.pauseReason ?? "budget-paused", detail: `The objective budget is paused${ledger.pauseReason ? ` (${ledger.pauseReason})` : ""}; no new dispatch is allowed.` };
    }
    if (ledger.status === "settled") {
      return { kind: "blocked", reason: "budget-exhausted", detail: "The objective budget is already settled; no new dispatch is allowed." };
    }
    if (budgetAtLimit(ledger.consumed, limits)) {
      return { kind: "blocked", reason: "budget-exhausted", detail: "The objective budget has reached an immutable limit; no new dispatch is allowed." };
    }
    return { kind: "enabled", policyHash: policy.policyHash, limits, ledger };
  }

  private prepareReservation(
    run: ObjectiveRunRecord,
    intentId: string,
    taskId: string,
    attemptId: string,
    budget: Extract<BudgetGate, { kind: "enabled" }>,
  ): ReservationPreparation {
    const reservationKey = objectiveBudgetReservationKey(run.runId, attemptId);
    const reservationId = objectiveBudgetReservationId(run.runId, attemptId);
    const existing = this.store.getObjectiveBudgetReservationByKey(run.runId, reservationKey);
    if (existing) return this.replayReservation(run, intentId, taskId, attemptId, existing, budget);

    const reservation = ObjectiveBudgetReservationRecordSchema.parse({
      version: 1,
      id: reservationId,
      runId: run.runId,
      objectiveId: run.objectiveId,
      policyHash: budget.policyHash,
      reservationKey,
      attemptId,
      agentId: null,
      amount: { modelCalls: 1 },
      state: "reserved",
      revision: 0,
      requestKey: objectiveBudgetReservationRequestKey(run.runId, attemptId),
      createdAt: this.now(),
      updatedAt: this.now(),
      releasedAt: null,
    });
    try {
      const inserted = this.store.reserveObjectiveBudget(reservation);
      if (inserted) return { kind: "ready", reservation };
    } catch (error) {
      const detail = messageOf(error);
      const reason = /concurrent-agent limit/i.test(detail)
        ? "concurrency-backpressure"
        : /budget reservation exceeds|budget is exhausted|immutable limits/i.test(detail)
          ? "budget-exhausted"
          : "crash-recovery";
      return { kind: "blocked", reason, detail: `Objective task ${taskId} could not reserve durable budget capacity: ${detail}` };
    }
    // A false result is either an idempotent replay or a CAS race. Resolve the
    // durable identity rather than guessing whether native create() succeeded.
    const raced = this.store.getObjectiveBudgetReservationByKey(run.runId, reservationKey);
    if (!raced) return { kind: "ambiguous", detail: `Objective task ${taskId} has an unresolved budget reservation race; daemon will not create native work after restart.` };
    return this.replayReservation(run, intentId, taskId, attemptId, raced, budget);
  }

  private replayReservation(
    run: ObjectiveRunRecord,
    intentId: string,
    taskId: string,
    attemptId: string,
    reservation: ObjectiveBudgetReservationRecord,
    budget: Extract<BudgetGate, { kind: "enabled" }>,
  ): ReservationPreparation {
    if (
      reservation.runId !== run.runId
      || reservation.objectiveId !== run.objectiveId
      || reservation.policyHash !== budget.policyHash
      || reservation.reservationKey !== objectiveBudgetReservationKey(run.runId, attemptId)
      || reservation.attemptId !== attemptId
    ) {
      return { kind: "blocked", reason: "crash-recovery", detail: `Objective task ${taskId} has a budget reservation bound to a different immutable identity.` };
    }
    if (reservation.state !== "reserved") {
      return { kind: "blocked", reason: "crash-recovery", detail: `Objective task ${taskId} has a prior ${reservation.state} budget reservation; daemon will not create a duplicate native attempt.` };
    }
    const assignment = this.readAssignment(run.runId, intentId, taskId);
    const agent = assignment?.agentId
      ? this.store.getAgent(assignment.agentId)
      : this.store.getAgentByLogicalAgentId(attemptId);
    if (!agent) {
      // AgentCoordinator's create contract durably persists the logical agent
      // record before any native start can be accepted. Therefore a durable
      // reservation with no agent is specifically the safe crash window
      // between reservation commit and create: replay the same deterministic
      // work order. If an earlier create had been accepted, the logical-agent
      // lookup above would have found its durable record and fenced a second
      // native attempt.
      return { kind: "ready", reservation };
    }
    if (agent.runId !== run.runId) {
      return { kind: "blocked", reason: "crash-recovery", detail: `Objective task ${taskId} resolves to a native agent belonging to a different objective run.` };
    }
    return { kind: "ready", reservation, agent };
  }

  private releaseReservation(reservation: ObjectiveBudgetReservationRecord): void {
    const current = this.store.getObjectiveBudgetReservation(reservation.runId, reservation.id);
    if (!current || current.state !== "reserved") return;
    const ledger = this.store.getObjectiveBudgetLedger(reservation.runId);
    if (!ledger) return;
    const released = ObjectiveBudgetReservationRecordSchema.parse({
      ...current,
      state: "released",
      revision: current.revision + 1,
      updatedAt: this.now(),
      releasedAt: this.now(),
    });
    try {
      const changed = this.store.releaseObjectiveBudgetReservation(released, {
        expectedRevision: current.revision,
        expectedLedgerRevision: ledger.revision,
      });
      if (!changed) {
        const racedReservation = this.store.getObjectiveBudgetReservation(reservation.runId, reservation.id);
        const racedLedger = this.store.getObjectiveBudgetLedger(reservation.runId);
        if (racedReservation?.state === "reserved" && racedLedger) {
          this.store.releaseObjectiveBudgetReservation(ObjectiveBudgetReservationRecordSchema.parse({
            ...racedReservation,
            state: "released",
            revision: racedReservation.revision + 1,
            updatedAt: this.now(),
            releasedAt: this.now(),
          }), {
            expectedRevision: racedReservation.revision,
            expectedLedgerRevision: racedLedger.revision,
          });
        }
      }
    } catch {
      // A concurrent terminal/recovery pass owns the reservation now. The
      // durable CAS is the authority; never retry by issuing native work.
    }
  }

  private settleReservation(
    run: ObjectiveRunRecord,
    task: ObjectiveTaskRecord,
    agent: AgentRecord,
  ): BudgetSettlement | null {
    return this.settleAttemptReservation(run, task.attemptId, task.task.id, agent);
  }

  private settleAttemptReservation(
    run: ObjectiveRunRecord,
    attemptId: string | null,
    taskLabel: string,
    agent: AgentRecord,
  ): BudgetSettlement | null {
    const context = this.accountingBudget(run);
    if (context.kind === "disabled") return null;
    if (context.kind === "blocked") return context;
    if (!attemptId) return { kind: "blocked", reason: "crash-recovery", detail: `${taskLabel} reached terminal evidence without a deterministic attempt identity.` };
    const reservation = this.store.getObjectiveBudgetReservationByKey(run.runId, objectiveBudgetReservationKey(run.runId, attemptId));
    if (!reservation) return { kind: "blocked", reason: "crash-recovery", detail: `${taskLabel} reached terminal evidence without its durable budget reservation.` };
    if (reservation.policyHash !== context.policyHash || reservation.objectiveId !== run.objectiveId) {
      return { kind: "blocked", reason: "crash-recovery", detail: `${taskLabel} budget reservation policy identity does not match the objective.` };
    }
    if (reservation.state === "consumed") return null;
    if (reservation.state !== "reserved") return { kind: "blocked", reason: "crash-recovery", detail: `${taskLabel} has a ${reservation.state} budget reservation and no safe terminal settlement path.` };
    const usage = this.knownUsage(agent, context.limits, attemptId);
    if (!usage) {
      this.pauseBudget(context.ledger, "budget-unknown-usage");
      return { kind: "blocked", reason: "budget-unknown-usage", detail: `${taskLabel} has authoritative terminal evidence but provider usage is unknown; its reservation remains held pending reconciliation.` };
    }
    const createdAt = this.now();
    const debit = ObjectiveBudgetDebitRecordSchema.parse({
      version: 1,
      id: objectiveBudgetDebitId(run.runId, attemptId),
      runId: run.runId,
      objectiveId: run.objectiveId,
      policyHash: context.policyHash,
      usageEventKey: objectiveBudgetUsageEventKey(run.runId, attemptId),
      reservationId: reservation.id,
      usage,
      usageKnown: true,
      basis: "harness-reported",
      requestKey: objectiveBudgetDebitRequestKey(run.runId, attemptId),
      createdAt,
    });
    try {
      this.store.recordObjectiveBudgetDebit(debit);
    } catch (error) {
      return { kind: "blocked", reason: "budget-exhausted", detail: `${taskLabel} terminal usage could not settle its budget reservation: ${messageOf(error)}` };
    }
    return null;
  }

  /**
   * A terminal AgentRecord is a projection, not by itself an acknowledgement
   * of native completion. Require the matching durable terminal event before
   * an objective task or budget reservation can be advanced. This also makes
   * restart recovery safe when a process died between the projection update
   * and event append.
   */
  private hasTerminalEvidence(
    run: ObjectiveRunRecord,
    agent: AgentRecord,
    attemptId: string,
    status: "completed" | "failed",
  ): boolean {
    if (agent.workflowId !== run.workflowId || agent.runId !== run.runId) return false;
    const logicalAttemptMatches = agent.logicalAgentId === attemptId;
    const types = status === "completed"
      ? ["agent.completed", "driver.run.completed"]
      : ["agent.failed", "driver.run.failed"];
    return this.store.recentEvents({ agentId: agent.id, runId: run.runId, types, limit: 10_000 }).some((event) => {
      if (event.workflowId !== run.workflowId || event.agentId !== agent.id || event.cursor > this.store.latestCursor()) return false;
      const payload = event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? event.payload as Record<string, JsonValue>
        : {};
      const explicitAttempt = payload.objectiveAttemptId ?? payload.attemptId ?? event.provenance?.objectiveAttemptId;
      // Legacy/native events may omit objective attribution. They remain
      // usable for a deterministic logical attempt because the durable agent
      // identity is the attempt fence. If an existing native agent was
      // attached to an objective checkpoint under a different logical id,
      // require the terminal event to carry the checkpoint's attempt id.
      return explicitAttempt === attemptId || (explicitAttempt === undefined && logicalAttemptMatches);
    });
  }

  private accountingBudget(run: ObjectiveRunRecord): AccountingBudget {
    const policy = run.policy;
    if (!policy) return { kind: "disabled" };
    if (!run.policyHash || run.policyHash !== policy.policyHash || !isObjectivePolicyHashValid(policy)) {
      return { kind: "blocked", reason: "crash-recovery", detail: "Objective policy identity is incomplete; budget settlement is held for explicit recovery." };
    }
    const limits = policy.budget;
    const ledger = this.store.getObjectiveBudgetLedger(run.runId);
    if (!ledger || ledger.policyHash !== policy.policyHash || !sameJson(ledger.limits, limits)) {
      return { kind: "blocked", reason: "crash-recovery", detail: "Objective budget settlement cannot prove a matching durable ledger and policy." };
    }
    return { kind: "enabled", policyHash: policy.policyHash, limits, ledger };
  }

  private knownUsage(agent: AgentRecord, limits: ObjectiveBudgetLimits, expectedAttemptId: string | null = null): ObjectiveBudgetUsage | null {
    const rawOrder = this.store.getMetadata<JsonValue>(`work-order:${agent.id}`);
    const order = rawOrder && typeof rawOrder === "object" && !Array.isArray(rawOrder)
      ? AgentWorkOrderSchema.safeParse(rawOrder).data
      : undefined;
    const explicitAttemptId = expectedAttemptId
      ?? agent.objectiveAttemptId
      ?? (order ? metadataString(order.metadata, "objectiveAttemptId", "attemptId") : null);
    const legacyAgentScopedAttempt = /^(?:objective-attempt|objective-planner):/u.test(agent.logicalAgentId)
      ? agent.logicalAgentId
      : null;
    const objectiveAttemptId = explicitAttemptId ?? legacyAgentScopedAttempt;
    // A policy-backed settlement must be tied to one logical objective attempt.
    // Historical usage from a reused agent/session is never a safe substitute.
    if (!objectiveAttemptId) return null;
    const allAgentEvents = this.store.listUsage({ agentId: agent.id });
    // Once an attempt is explicit, an un-attributed row cannot safely be
    // assigned to the current turn. It may be a prior attempt on this reused
    // native session, so keep settlement paused until reconciliation supplies
    // the missing identity instead of silently treating it as zero/current.
    if (explicitAttemptId && explicitAttemptId !== legacyAgentScopedAttempt
      && allAgentEvents.some((event) => event.objectiveAttemptId === null || event.objectiveAttemptId === undefined)) return null;
    const events = legacyAgentScopedAttempt && allAgentEvents.every((event) => event.objectiveAttemptId === null || event.objectiveAttemptId === undefined)
      ? allAgentEvents
      : allAgentEvents.filter((event) => event.objectiveAttemptId === objectiveAttemptId);
    // ObjectiveBudgetUsage.costUsd has no currency field and therefore cannot
    // safely carry a non-USD provider amount. Without a durable FX snapshot,
    // hold settlement for reconciliation instead of folding EUR/JPY/etc. into
    // a value that the ledger and UI necessarily label USD.
    if (events.some((event) => event.costAmount !== null && event.currency.toUpperCase() !== "USD")) return null;
    const needsInput = limits.maxInputTokens !== null || limits.maxTotalTokens !== null;
    const needsOutput = limits.maxOutputTokens !== null || limits.maxTotalTokens !== null;
    const needsCost = limits.maxCostUsd !== null;
    const needsUsage = limits.maxModelCalls !== null || needsInput || needsOutput || needsCost;
    if (needsUsage && events.length === 0) return null;
    if (needsInput && events.some((event) => event.inputTokens === null)) return null;
    if (needsOutput && (events.length === 0 || events.some((event) => event.outputTokens === null))) return null;
    if (needsCost && (events.length === 0 || events.some((event) => event.costAmount === null || event.basis === "unknown" || event.currency.toUpperCase() !== "USD"))) return null;
    if (limits.maxStorageBytes !== null || limits.maxLoopIterations !== null) return null;
    if (limits.maxWallTimeSeconds !== null && (!agent.startedAt || !agent.finishedAt)) return null;
    const startedAt = agent.startedAt ? Date.parse(agent.startedAt) : NaN;
    const finishedAt = agent.finishedAt ? Date.parse(agent.finishedAt) : NaN;
    if (limits.maxWallTimeSeconds !== null && (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt))) return null;
    const toolEvents = limits.maxToolCalls === null
      ? []
      : this.store.recentEvents({ agentId: agent.id, types: ["driver.tool.completed"] })
        .filter((event) => event.provenance?.objectiveAttemptId === objectiveAttemptId);
    if (limits.maxToolCalls !== null && this.store.recentEvents({ agentId: agent.id, types: ["driver.tool.completed"] })
      .some((event) => !event.provenance?.objectiveAttemptId)) return null;
    const toolCalls = new Set(toolEvents.map((event) => event.provenance?.nativeEventId ?? event.id)).size;
    const inputTokens = events.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0);
    const outputTokens = events.reduce((sum, event) => sum + (event.outputTokens ?? 0), 0);
    const costUsd = events.reduce((sum, event) => sum + (event.costAmount ?? 0), 0);
    const wallTimeSeconds = agent.startedAt && agent.finishedAt
      ? Math.max(0, (finishedAt - startedAt) / 1_000)
      : 0;
    const outputBytes = agent.output === null ? 0 : Buffer.byteLength(JSON.stringify(agent.output), "utf8");
    return ObjectiveBudgetUsageSchema.parse({
      costUsd,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      modelCalls: new Set(events.map((event) => event.nativeTurnId ?? event.nativeEventId ?? event.id)).size,
      toolCalls,
      wallTimeSeconds,
      outputBytes,
    });
  }

  private pauseBudget(ledger: AccountingBudgetLedger, reason: string): void {
    if (ledger.status === "settled" || (ledger.status === "paused" && ledger.pauseReason === reason)) return;
    try {
      this.store.updateObjectiveBudgetLedger({
        ...ledger,
        status: "paused",
        pauseReason: reason,
        revision: ledger.revision + 1,
        updatedAt: this.now(),
      }, { expectedRevision: ledger.revision });
    } catch {
      // A concurrent accounting transition is authoritative; this pass stays
      // fail-closed and surfaces attention below.
    }
  }

  private budgetAttention(
    run: ObjectiveRunRecord,
    intent: ObjectiveSupervisorIntent,
    detail: string,
    reason: string,
  ): ObjectiveSupervisionStepResult {
    if (["budget-exhausted", "budget-unknown-usage", "policy-expired"].includes(reason)) {
      const latest = this.store.getObjectiveBudgetLedger(run.runId);
      if (latest && latest.status === "active") this.pauseBudget(latest, reason);
      const next = { ...run, pauseReason: reason, updatedAt: this.now() };
      try { this.repository.saveObjectiveRun(next); } catch { /* attention metadata remains durable */ }
    }
    return this.attention(run, intent, detail, { category: "budget" });
  }

  private backpressure(
    run: ObjectiveRunRecord,
    intent: ObjectiveSupervisorIntent,
    detail: string,
    attempts: Readonly<Record<string, string>>,
  ): ObjectiveSupervisionStepResult {
    const waitingDetail = `${detail} The frontier remains queued and will retry when an in-flight objective attempt settles.`;
    this.saveRecord({
      version: 1,
      runId: run.runId,
      intentId: intent.intentId,
      kind: intent.kind,
      state: "waiting",
      attempts,
      updatedAt: this.now(),
      detail: waitingDetail,
    });
    this.emit(run, "objective.supervisor.backpressure", {
      intentId: intent.intentId,
      reason: "concurrency-backpressure",
      detail,
      attempts,
    });
    return { runId: run.runId, intent, run, action: "waiting" };
  }

  private readAssignment(runId: string, intentId: string, taskId: string): ObjectiveAssignment | null {
    const raw = this.store.getMetadata<JsonValue>(assignmentKey(runId, intentId, taskId));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (value.version !== 1 || value.runId !== runId || value.intentId !== intentId || value.taskId !== taskId || typeof value.attemptId !== "string") return null;
    return {
      agentId: typeof value.agentId === "string" ? value.agentId : null,
      attemptId: value.attemptId,
      state: value.state === "failed" || value.state === "dispatched" ? value.state : "claimed",
    };
  }

  private async replan(
    run: ObjectiveRunRecord,
    intent: Extract<ObjectiveSupervisorIntent, { kind: "replan" }>,
  ): Promise<ObjectiveSupervisionStepResult> {
    const parent = this.parentAgent(run);
    if (!parent) return this.attention(run, intent, "Objective replan requires a conductor; no conductor is attached.");
    // A plan may have been committed by a native conductor event immediately
    // before this bounded step observed its replan intent. Re-read the durable
    // run before treating a completed planner as a no-plan outcome.
    const latest = this.runtime.get(run.runId);
    if (latest.activePlanRevision !== run.activePlanRevision || latest.state !== run.state) {
      return { runId: run.runId, intent, run: latest, action: "waiting" };
    }
    try {
      if (this.hasReusableConductorSession(parent.id)) {
        await this.agents.message(parent.id, `Objective ${run.objectiveId} needs a bounded replacement plan. Failed tasks: ${intent.failedTaskIds.join(", ") || "criteria evaluation"}. Replan allowance remaining: ${intent.remainingReplans}.`, { attemptId: intent.acknowledgementKey });
        this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "waiting", attempts: {}, updatedAt: this.now(), detail: "Waiting for the conductor to commit a replacement plan." });
        this.emit(run, "objective.supervisor.replan-requested", { intentId: intent.intentId, conductorAgentId: parent.id, failedTaskIds: intent.failedTaskIds });
        return { runId: run.runId, intent, run, action: "waiting" };
      }

      if (parent.status !== "completed") {
        return this.attention(run, intent, `The conductor has no reusable native session while in ${parent.status}; replacement planning is held for explicit attention.`);
      }

      return await this.dispatchPlanner(run, intent, parent);
    } catch (error) {
      return this.attention(run, intent, `Replan request could not be delivered: ${messageOf(error)}`);
    }
  }

  private approval(run: ObjectiveRunRecord, intent: Extract<ObjectiveSupervisorIntent, { kind: "wait-for-approval" }>): ObjectiveSupervisionStepResult {
    const detail = `Objective approval ${intent.approvalId} is pending human resolution.`;
    return this.attention(run, intent, detail, { category: "approval" });
  }

  private finish(run: ObjectiveRunRecord, intent: Extract<ObjectiveSupervisorIntent, { kind: "finish" }>): ObjectiveSupervisionStepResult {
    this.supervisor.acknowledge(run.runId, { kind: "finish", intentId: intent.intentId, requestKey: intent.acknowledgementKey });
    this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "settled", attempts: {}, updatedAt: this.now(), detail: null });
    this.emit(run, "objective.supervisor.finished", { intentId: intent.intentId, conductorAgentId: run.conductorAgentId, state: intent.state });
    return { runId: run.runId, intent, run, action: "settled" };
  }

  private attention(
    run: ObjectiveRunRecord,
    intent: ObjectiveSupervisorIntent | ObjectiveControlIntent,
    detail: string,
    options: { category?: ObjectiveAttentionCategory; attempts?: Readonly<Record<string, string>>; expiresAt?: string | null } = {},
  ): ObjectiveSupervisionStepResult {
    this.materializeAttention(run, intent, detail, options);
    this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "attention", attempts: options.attempts ?? {}, updatedAt: this.now(), detail });
    return { runId: run.runId, intent, run, action: "attention" };
  }

  private attentionApproval(
    run: ObjectiveRunRecord,
    intent: ObjectiveSupervisorIntent | ObjectiveControlIntent,
  ): ObjectiveApprovalRecord | null {
    if (intent.kind === "wait-for-approval") return intent.approval;
    if (intent.kind === "agent" && intent.operation === "approval") return this.controlApprovalForIntent(run, intent);
    if (run.pendingApprovalId) return this.repository.getObjectiveApproval(run.runId, run.pendingApprovalId);
    return null;
  }

  /**
   * Cross the supervision boundary exactly once. The generic supervisor
   * metadata remains a local compatibility projection, while the registry is
   * the durable source of truth for operator/conductor attention. Records use
   * execution/approval identity rather than wall-clock or event cursors, so a
   * restart or repeated native callback cannot create a second item.
   */
  private materializeAttention(
    run: ObjectiveRunRecord,
    intent: ObjectiveSupervisorIntent | ObjectiveControlIntent,
    detail: string,
    options: { category?: ObjectiveAttentionCategory; attempts?: Readonly<Record<string, string>>; expiresAt?: string | null } = {},
  ): ObjectiveAttentionRecord {
    const approval = this.attentionApproval(run, intent);
    const operationId = attentionOperationId(run, intent, approval);
    const requestKey = `objective-supervisor-attention:${operationId}`;
    const existingId = `attention:${createAttentionHash(`${run.runId}\u0000${requestKey}`)}`;
    const existing = this.attentionRegistry.get(run.runId, existingId);
    if (existing) return existing;

    const category = options.category ?? attentionCategory(intent, detail);
    const blockedResource = attentionBlockedResource(run, intent, detail, category);
    const expiresAt = options.expiresAt !== undefined
      ? options.expiresAt
      : attentionExpiry(run, intent, approval, category);
    const evidenceRefs = attentionEvidenceRefs(this.store, run.runId);
    const request: ObjectiveAttentionRequest = {
      operationId,
      nodeId: attentionNodeId(intent),
      attemptId: attentionAttemptId(intent),
      reason: attentionReason(intent, category),
      consequence: detail,
      risk: attentionRisk(category),
      urgency: attentionUrgency(category),
      confidence: attentionConfidence(category),
      blockedResource,
      proposedAction: attentionProposedAction(category, intent),
      alternatives: attentionAlternatives(category),
      authorityBoundary: {
        permission: run.policy?.effectivePermission ?? this.options.authority.permissionCeiling,
        sideEffectClass: approval?.sideEffectClass ?? run.policy?.sideEffectClassCeiling ?? "local",
        capability: approval?.capability ?? (blockedResource && typeof blockedResource !== "string" && blockedResource.kind === "capability"
          ? blockedResource.id
          : null),
        resource: approval?.canonicalTarget ?? attentionResourceDescription(blockedResource),
        description: approval
          ? `Approval ${approval.id} is bounded to operation ${approval.operationId}; resolving it cannot widen the objective policy.`
          : `Resolution is bounded to objective run ${run.runId}; it may not widen the run policy or native authority.`,
      },
      evidenceRefs,
      assignee: attentionAssignee(run, approval),
      expiresAt,
      escalation: expiresAt
        ? { at: expiresAt, to: null, policy: "expire", reason: "Unresolved supervision attention expires at the known boundary." }
        : { at: null, to: null, policy: "none", reason: null },
    };

    const record = this.store.durableTransaction(() => {
      const raced = this.attentionRegistry.get(run.runId, existingId);
      if (raced) return raced;
      const next = this.attentionRegistry.create({
        objectiveId: run.objectiveId,
        runId: run.runId,
        operationId,
        requestKey,
        requestedBy: { type: "system", id: "objective-supervisor" },
        now: this.now(),
        id: existingId,
      }, request);
      // Keep the legacy event for existing observers, but publish it only for
      // the first durable record. Both events are committed with the record.
      this.emit(run, "objective.supervisor.attention", {
        intentId: intent.intentId,
        conductorAgentId: run.conductorAgentId,
        kind: intent.kind,
        detail,
        attentionId: next.id,
        operationId: next.operationId,
      });
      this.emit(run, "objective.attention.requested", attentionEventPayload(next, intent));
      return next;
    });
    return record;
  }

  private recordAttention(run: ObjectiveRunRecord, error: unknown): void {
    try {
      this.attention(run, this.supervisor.next(run), messageOf(error));
    } catch (intentError) {
      this.recordMalformedAttention(run, `${messageOf(error)} (supervisor state could not be derived: ${messageOf(intentError)})`);
    }
  }

  private recordMalformedAttention(run: ObjectiveRunRecord, detail: string): void {
    const intentId = `malformed:${run.runId}:${createAttentionHash(detail)}`;
    const intent = malformedAttentionIntent(run, intentId);
    this.materializeAttention(run, intent, detail, { category: "malformed" });
    this.saveRecord({ version: 1, runId: run.runId, intentId, kind: "malformed", state: "attention", attempts: {}, updatedAt: this.now(), detail });
  }

  private hasReusableConductorSession(agentId: string): boolean {
    // A few embedders provide the coordinator through a narrow test adapter;
    // absence of this optional capability is intentionally fail-closed and
    // selects the durable planner path below.
    return typeof this.agents.hasSession === "function" && this.agents.hasSession(agentId);
  }

  private async dispatchPlanner(
    run: ObjectiveRunRecord,
    intent: Extract<ObjectiveSupervisorIntent, { kind: "replan" }>,
    parent: AgentRecord,
  ): Promise<ObjectiveSupervisionStepResult> {
    const requestedWorkspace = this.conductorWorkspace(parent);
    if (!requestedWorkspace) return this.attention(run, intent, "The completed conductor has no reusable session or durable workspace; replacement planning is held for explicit attention.");
    let workspace: WorkspaceSpec;
    try {
      const granted = this.grantedWorkspace(run, requestedWorkspace);
      if (!granted) return this.attention(run, intent, "The completed conductor has no reusable session or durable workspace; replacement planning is held for explicit attention.");
      workspace = granted;
    } catch (error) {
      return this.attention(run, intent, `Replacement planner workspace is outside the objective grant: ${messageOf(error)}`);
    }

    const plannerId = objectivePlannerId(run.runId, intent.intentId);
    const taskId = "__objective_planner__";
    const attemptId = plannerId;
    const budget = this.dispatchBudget(run, parent.depth + 1);
    if (budget.kind === "blocked") return this.budgetAttention(run, intent, budget.detail, budget.reason);
    let reservation: ObjectiveBudgetReservationRecord | null = null;
    let replayedPlanner: AgentRecord | null = null;
    if (budget.kind === "enabled") {
      const prepared = this.prepareReservation(run, intent.intentId, taskId, attemptId, budget);
      if (prepared.kind === "blocked") {
        if (prepared.reason === "concurrency-backpressure") {
          return this.backpressure(run, intent, prepared.detail, { [taskId]: attemptId });
        }
        return this.budgetAttention(run, intent, prepared.detail, prepared.reason);
      }
      if (prepared.kind === "ambiguous") return this.budgetAttention(run, intent, prepared.detail, "crash-recovery");
      reservation = prepared.reservation;
      replayedPlanner = prepared.agent ?? null;
    }
    const planner = this.store.getAgentByLogicalAgentId(plannerId);
    if (planner && planner.runId !== run.runId) {
      return this.attention(run, intent, "The durable replacement planner identity is bound to a different objective run.");
    }
    if (!planner) this.saveAssignment(run.runId, intent.intentId, taskId, attemptId, null, "claimed");

    const order = this.plannerWorkOrder(run, intent, parent, workspace, plannerId, reservation);
    let agent: AgentRecord;
    try {
      agent = replayedPlanner ?? await this.agents.create(order);
    } catch (error) {
      if (reservation) this.releaseReservation(reservation);
      this.saveAssignment(run.runId, intent.intentId, taskId, attemptId, null, "failed", messageOf(error));
      return this.attention(run, intent, `Replacement planner could not be created: ${messageOf(error)}`);
    }
    if (agent.status === "failed" && !this.hasTerminalEvidence(run, agent, attemptId, "failed")) {
      this.saveAssignment(run.runId, intent.intentId, taskId, attemptId, agent.id, "claimed");
      this.saveRecord({
        version: 1,
        runId: run.runId,
        intentId: intent.intentId,
        kind: intent.kind,
        state: "waiting",
        attempts: { [taskId]: attemptId },
        updatedAt: this.now(),
        detail: "Waiting for durable replacement-planner terminal evidence.",
      });
      return { runId: run.runId, intent, run, action: "waiting" };
    }
    if (agent.status === "failed") {
      if (reservation) this.releaseReservation(reservation);
      this.saveAssignment(run.runId, intent.intentId, taskId, attemptId, agent.id, "failed", agent.error ?? "Replacement planner failed during creation.");
      return this.attention(run, intent, `Replacement planner could not be created: ${agent.error ?? "native create failed"}.`);
    }
    if (agent.status === "completed" && !this.hasTerminalEvidence(run, agent, attemptId, "completed")) {
      this.saveAssignment(run.runId, intent.intentId, taskId, attemptId, agent.id, "claimed");
      this.saveRecord({
        version: 1,
        runId: run.runId,
        intentId: intent.intentId,
        kind: intent.kind,
        state: "waiting",
        attempts: { [taskId]: attemptId },
        updatedAt: this.now(),
        detail: "Waiting for durable replacement-planner terminal evidence.",
      });
      return { runId: run.runId, intent, run, action: "waiting" };
    }
    if (agent.status === "completed" && reservation) {
      const settlement = this.settleAttemptReservation(run, attemptId, taskId, agent);
      if (settlement) return this.budgetAttention(run, intent, settlement.detail, settlement.reason);
    }
    this.saveAssignment(run.runId, intent.intentId, taskId, attemptId, agent.id, plannerStatus(agent));

    if (["queued", "routing", "starting", "running"].includes(agent.status)) {
      this.saveRecord({ version: 1, runId: run.runId, intentId: intent.intentId, kind: intent.kind, state: "waiting", attempts: { [taskId]: attemptId }, updatedAt: this.now(), detail: "Waiting for the deterministic replacement planner to commit a plan." });
      this.emit(run, "objective.supervisor.replan-requested", { intentId: intent.intentId, conductorAgentId: parent.id, plannerAgentId: agent.id, failedTaskIds: intent.failedTaskIds, fallback: true });
      return { runId: run.runId, intent, run, action: "waiting" };
    }

    const current = this.runtime.get(run.runId);
    if (current.activePlanRevision !== run.activePlanRevision || current.state !== run.state) {
      return { runId: run.runId, intent, run: current, action: "waiting" };
    }
    if (agent.status === "completed") {
      return this.attention(run, intent, "The replacement planner completed without committing a replacement plan.");
    }
    return this.attention(run, intent, `The replacement planner ended with inconclusive native outcome ${agent.status}; daemon will not report a plan.`);
  }

  private plannerWorkOrder(
    run: ObjectiveRunRecord,
    intent: Extract<ObjectiveSupervisorIntent, { kind: "replan" }>,
    parent: AgentRecord,
    workspace: WorkspaceSpec,
    plannerId: string,
    reservation: ObjectiveBudgetReservationRecord | null = null,
  ): AgentWorkOrder {
    const parentOrder = this.parentWorkOrder(parent);
    const permissions = minPermission(parent.permissions, run.policy?.effectivePermission);
    const capabilities = intersectCapabilityCeilings(
      run.policy?.allowedCapabilities,
      parentOrder?.capabilities,
    );
    const sideEffectClassCeiling = minSideEffectClass(
      run.policy?.sideEffectClassCeiling,
      parentOrder?.sideEffectClassCeiling,
    );
    return {
      id: plannerId,
      workflowId: run.workflowId,
      runId: run.runId,
      parentAgentId: parent.id,
      depth: parent.depth + 1,
      mission: { id: run.workflowId, revision: run.workflowRevision, hash: run.workflowHash, statement: run.spec.statement.slice(0, 2_000), keyResults: [] },
      objective: `Commit a bounded replacement plan for objective ${run.objectiveId}. Use commit_objective_plan for run ${run.runId}, expected plan revision ${run.activePlanRevision}. Failed tasks: ${intent.failedTaskIds.join(", ") || "criteria evaluation"}. If a valid plan cannot be produced, leave a clear failure outcome.`,
      ...valueCharterWorkOrderFields(run),
      model: "auto",
      harness: "auto",
      permissions,
      ...(capabilities ? { capabilities } : {}),
      ...(sideEffectClassCeiling ? { sideEffectClassCeiling } : {}),
      outputSchema: {},
      inputs: [],
      workspace,
      metadata: {
        objectiveRunId: run.runId,
        objectivePlanner: true,
        intentId: intent.intentId,
        objectiveAttemptId: plannerId,
        ...(run.policyHash ? {
          policyHash: run.policyHash,
          ...(capabilities ? { allowedCapabilities: capabilities } : {}),
          ...(sideEffectClassCeiling ? { sideEffectClassCeiling } : {}),
          ...(reservation ? {
            budgetReservationId: reservation.id,
            budgetReservationKey: reservation.reservationKey,
            reservationId: reservation.id,
            reservationKey: reservation.reservationKey,
          } : {}),
        } : {}),
      },
    };
  }

  private parentAgent(run: ObjectiveRunRecord): AgentRecord | null {
    if (!run.conductorAgentId) return null;
    return this.store.getAgent(run.conductorAgentId);
  }

  private workOrder(
    run: ObjectiveRunRecord,
    task: ObjectiveTaskRecord,
    attemptId: string,
    intentId: string,
    parent: AgentRecord | null,
    workspace: WorkspaceSpec,
    reservation: ObjectiveBudgetReservationRecord | null = null,
  ): AgentWorkOrder {
    const parentOrder = parent ? this.parentWorkOrder(parent) : null;
    const permissions = minPermission(
      parent?.permissions,
      task.task.permissions ?? "read-only",
      run.policy?.effectivePermission,
    );
    const capabilities = intersectCapabilityCeilings(
      run.policy?.allowedCapabilities,
      parentOrder?.capabilities,
      task.task.capabilities,
    );
    const sideEffectClassCeiling = minSideEffectClass(
      run.policy?.sideEffectClassCeiling,
      parentOrder?.sideEffectClassCeiling,
    );
    return {
      id: attemptId,
      workflowId: run.workflowId,
      runId: run.runId,
      parentAgentId: parent?.id ?? null,
      depth: parent ? parent.depth + 1 : 0,
      mission: {
        id: run.workflowId,
        revision: run.workflowRevision,
        hash: run.workflowHash,
        statement: run.spec.statement.slice(0, 2_000),
        keyResults: [],
      },
      objective: task.task.objective,
      ...valueCharterWorkOrderFields(run),
      model: task.task.model,
      harness: task.task.harness,
      // Objective tasks default to read-only. Every inherited, task, and
      // objective policy ceiling is intersected before native execution.
      permissions,
      ...(capabilities ? { capabilities } : {}),
      ...(sideEffectClassCeiling ? { sideEffectClassCeiling } : {}),
      outputSchema: task.task.outputSchema,
      inputs: task.task.inputs,
      routing: task.task.routing,
      workspace,
      metadata: {
        objectiveRunId: run.runId,
        objectiveTaskId: task.task.id,
        intentId,
        objectiveAttemptId: attemptId,
        ...(run.policyHash ? {
          policyHash: run.policyHash,
          ...(capabilities ? { allowedCapabilities: capabilities } : {}),
          ...(sideEffectClassCeiling ? { sideEffectClassCeiling } : {}),
          ...(reservation ? {
            budgetReservationId: reservation.id,
            budgetReservationKey: reservation.reservationKey,
            reservationId: reservation.id,
            reservationKey: reservation.reservationKey,
          } : {}),
        } : {}),
      },
    };
  }

  private controlWorkOrder(
    run: ObjectiveRunRecord,
    intent: ObjectiveControlAgentIntent,
    parent: AgentRecord,
    workspace: WorkspaceSpec,
  ): AgentWorkOrder {
    const parentOrder = this.parentWorkOrder(parent);
    const node = intent.node;
    const permissions = minPermission(parent.permissions, node.permissions ?? "read-only", run.policy?.effectivePermission);
    const capabilities = intersectCapabilityCeilings(run.policy?.allowedCapabilities, parentOrder?.capabilities, node.capabilities);
    const sideEffectClassCeiling = minSideEffectClass(run.policy?.sideEffectClassCeiling, parentOrder?.sideEffectClassCeiling);
    const executionKey = intent.execution;
    return AgentWorkOrderSchema.parse({
      id: intent.attemptId,
      workflowId: run.workflowId,
      runId: run.runId,
      parentAgentId: parent.id,
      depth: parent.depth + 1,
      mission: {
        id: run.workflowId,
        revision: run.workflowRevision,
        hash: run.workflowHash,
        statement: run.spec.statement.slice(0, 2_000),
        keyResults: [],
      },
      objective: intent.objective,
      ...valueCharterWorkOrderFields(run),
      model: intent.model,
      harness: intent.harness,
      permissions,
      ...(capabilities ? { capabilities } : {}),
      ...(sideEffectClassCeiling ? { sideEffectClassCeiling } : {}),
      outputSchema: node.outputSchema,
      // Control-plan inputs are already reducer-interpolated JSON values. The
      // protocol currently models work-order inputs as a JSON-compatible
      // reference union; preserve the values on the native order (and in
      // metadata) so the driver prompt cannot silently lose them.
      inputs: intent.inputs as AgentWorkOrder["inputs"],
      routing: node.routing,
      workspace,
      metadata: {
        objectiveRunId: run.runId,
        objectiveAttemptId: intent.attemptId,
        controlNodeId: intent.nodeId,
        controlExecutionKey: executionKey,
        controlExecutionId: objectiveControlExecutionId(executionKey),
        controlIterationPath: executionKey.iterationKey,
        controlIntentId: intent.intentId,
        controlOperation: intent.operation,
        controlAttemptId: intent.attemptId,
        controlInputs: intent.inputs,
        ...(run.policyHash ? { policyHash: run.policyHash } : {}),
      },
    });
  }

  private conductorWorkspace(parent: AgentRecord): WorkspaceSpec | null {
    const order = this.parentWorkOrder(parent);
    return order ? WorkspaceSpecSchema.parse(order.workspace) : null;
  }

  private parentWorkOrder(parent: AgentRecord): AgentWorkOrder | null {
    const raw = this.store.getMetadata<JsonValue>(`work-order:${parent.id}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const parsed = AgentWorkOrderSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Re-check a persisted or fallback workspace immediately before crossing
   * into native execution. The mutation API and runtime perform the same
   * realpath-aware containment check; this guard protects recovery from an
   * old/corrupt record and prevents a broader conductor fallback from being
   * dispatched after a restart.
   */
  private grantedWorkspace(run: ObjectiveRunRecord, workspace: WorkspaceSpec | null): WorkspaceSpec | null {
    if (!workspace) return null;
    const grant = this.options.workspaceGrantForRun?.(run) ?? this.options.authority.workspace ?? null;
    if (!grant) return workspace;
    try {
      return childWorkspaceGrant(grant, workspace, grant.path);
    } catch (error) {
      const detail = error instanceof WorkspaceContainmentError ? error.message : messageOf(error);
      throw new Error(`Workspace for objective task is outside the objective grant: ${detail}`);
    }
  }

  private readRecord(runId: string): ObjectiveSupervisionRecord | null {
    const value = this.store.getMetadata<JsonValue>(supervisionKey(runId));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || record.runId !== runId || typeof record.intentId !== "string" || typeof record.kind !== "string" || typeof record.state !== "string") return null;
    return record as ObjectiveSupervisionRecord;
  }

  private saveRecord(record: ObjectiveSupervisionRecord): void {
    this.store.durableTransaction(() => this.store.setMetadata(supervisionKey(record.runId), record as unknown as JsonValue));
  }

  private saveAssignment(
    runId: string,
    intentId: string,
    taskId: string,
    attemptId: string,
    agentId: string | null,
    state: "claimed" | "dispatched" | "failed",
    error?: string,
  ): void {
    this.store.durableTransaction(() => this.store.setMetadata(assignmentKey(runId, intentId, taskId), {
      version: 1,
      runId,
      intentId,
      taskId,
      attemptId,
      agentId,
      state,
      ...(error ? { error } : {}),
      updatedAt: this.now(),
    }));
  }

  private readControlAssignment(
    runId: string,
    intent: ObjectiveControlAgentIntent,
  ): { attemptId: string; agentId: string | null; state: "claimed" | "dispatched" | "failed" } | null {
    const raw = this.store.getMetadata<JsonValue>(controlAssignmentKey(runId, intent));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const executionKey = value.executionKey;
    const executionMatches = executionKey !== null
      && typeof executionKey === "object"
      && !Array.isArray(executionKey)
      && objectiveControlExecutionId(executionKey as ObjectiveControlAgentIntent["execution"]) === objectiveControlExecutionId(intent.execution);
    if (value.version !== 1 || value.runId !== runId || !executionMatches || value.attemptId !== intent.attemptId) return null;
    return {
      attemptId: intent.attemptId,
      agentId: typeof value.agentId === "string" ? value.agentId : null,
      state: value.state === "failed" || value.state === "dispatched" ? value.state : "claimed",
    };
  }

  private saveControlAssignment(
    runId: string,
    intent: ObjectiveControlAgentIntent,
    attemptId: string,
    agentId: string | null,
    state: "claimed" | "dispatched" | "failed",
    error?: string,
  ): void {
    this.store.durableTransaction(() => this.store.setMetadata(controlAssignmentKey(runId, intent), {
      version: 1,
      runId,
      intentId: intent.intentId,
      nodeId: intent.nodeId,
      executionKey: intent.execution,
      attemptId,
      agentId,
      state,
      ...(error ? { error } : {}),
      updatedAt: this.now(),
    }));
  }

  private controlEvidence(runId: string): { eventCursor: number; eventIds: string[]; summary: string } {
    const events = this.store.recentEvents({ runId, limit: 256 });
    return {
      eventCursor: Math.max(this.store.latestCursor(), ...events.map((event) => event.cursor), 0),
      eventIds: events.slice(-256).map((event) => event.id),
      summary: "Objective control plan reached a terminal reducer state.",
    };
  }

  private controlApprovalForIntent(
    run: ObjectiveRunRecord,
    intent: ObjectiveControlAgentIntent,
  ): ObjectiveApprovalRecord | null {
    let approval = run.pendingApprovalId
      ? this.repository.getObjectiveApproval(run.runId, run.pendingApprovalId)
      : null;
    if (!approval || approval.kind !== "control") {
      const receipt = this.repository.getObjectiveActionReceipt(objectiveControlApprovalRequestKey(intent.intentId));
      const approvalId = receipt?.kind === "objective.approval.request" && typeof receipt.result === "string"
        ? receipt.result
        : null;
      approval = approvalId ? this.repository.getObjectiveApproval(run.runId, approvalId) : null;
    }
    return approval?.kind === "control" ? approval : null;
  }

  private controlEvidenceForAgent(
    runId: string,
    agent: AgentRecord,
    attemptId: string,
    status: "completed" | "failed",
  ): { eventCursor: number; eventIds: string[]; summary: string } {
    const types = status === "completed"
      ? ["agent.completed", "driver.run.completed"]
      : ["agent.failed", "driver.run.failed"];
    const events = this.store.recentEvents({ runId, agentId: agent.id, types, limit: 256 });
    return {
      eventCursor: Math.max(this.store.latestCursor(), ...events.map((event) => event.cursor), 0),
      eventIds: events.slice(-256).map((event) => event.id),
      summary: `Control attempt ${attemptId} produced durable ${status} evidence.`,
    };
  }

  private emit(run: ObjectiveRunRecord, type: string, payload: JsonValue): EventEnvelope {
    return this.store.appendEvent({ type, workflowId: run.workflowId, runId: run.runId, agentId: null, occurredAt: this.now(), payload, provenance: { source: "daemon" } });
  }

  private wake(run: ObjectiveRunRecord, agent: AgentRecord | null): void {
    if (agent && agent.runId !== run.runId) return;
    if (!this.accepting) return;
    void this.step(run.runId).catch(() => undefined);
  }
}

export function objectiveAttemptId(runId: string, taskId: string, intentId: string): string {
  return `objective-attempt:${runId}:${taskId}:${intentId}`;
}

export function objectivePlannerId(runId: string, intentId: string): string {
  return `objective-planner:${runId}:${intentId}`;
}

export function objectiveBudgetReservationKey(runId: string, attemptId: string): string {
  return `objective-budget-reservation:${runId}:${attemptId}`;
}

export function objectiveBudgetReservationId(runId: string, attemptId: string): string {
  return `objective-budget-hold:${runId}:${attemptId}`;
}

export function objectiveBudgetReservationRequestKey(runId: string, attemptId: string): string {
  return `objective-budget-reserve:${runId}:${attemptId}`;
}

export function objectiveBudgetUsageEventKey(runId: string, attemptId: string): string {
  return `objective-budget-usage:${runId}:${attemptId}`;
}

export function objectiveBudgetDebitId(runId: string, attemptId: string): string {
  return `objective-budget-debit:${runId}:${attemptId}`;
}

export function objectiveBudgetDebitRequestKey(runId: string, attemptId: string): string {
  return `objective-budget-debit-request:${runId}:${attemptId}`;
}

function supervisionKey(runId: string): string {
  return `objective-supervision:${runId}`;
}

function assignmentKey(runId: string, intentId: string, taskId: string): string {
  return `objective-assignment:${runId}:${intentId}:${taskId}`;
}

function controlAssignmentKey(runId: string, intent: ObjectiveControlAgentIntent): string {
  // Assignment identity follows the concrete execution, not the reducer
  // intent. The intent id changes from dispatch to wait after the running ack,
  // and must still resolve to the same native attempt after a restart.
  return `objective-control-assignment:${runId}:${objectiveControlExecutionId(intent.execution)}`;
}

function controlAcknowledgementKey(intentId: string): string {
  return `objective-control-ack:${intentId}`;
}

type ObjectiveAttentionCategory = "approval" | "native-uncertain" | "budget" | "recovery" | "control-wait" | "malformed";

function createAttentionHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 48);
}

function attentionOperationId(
  run: ObjectiveRunRecord,
  intent: ObjectiveSupervisorIntent | ObjectiveControlIntent,
  approval: ObjectiveApprovalRecord | null,
): string {
  if (approval) return approval.operationId;
  const candidate = intent as unknown as Record<string, unknown>;
  if (intent.kind === "agent" && typeof candidate.attemptId === "string") {
    return `objective-control-attempt:${run.runId}:${candidate.attemptId}`;
  }
  if ((intent.kind === "timer" || intent.kind === "signal" || intent.kind === "wait") && candidate.execution) {
    return `objective-control-wait:${run.runId}:${intent.kind}:${objectiveControlExecutionId(candidate.execution as ObjectiveControlAgentIntent["execution"])}`;
  }
  return `objective-supervisor:${run.runId}:${intent.intentId}`;
}

function attentionCategory(
  intent: ObjectiveSupervisorIntent | ObjectiveControlIntent,
  detail: string,
): ObjectiveAttentionCategory {
  if (intent.kind === "wait-for-approval" || (intent.kind === "agent" && intent.operation === "approval")) return "approval";
  if (intent.kind === "wait" || ((intent.kind === "timer" || intent.kind === "signal") && intent.operation === "wait")) return "control-wait";
  if (/budget|policy|usage|reservation|ledger/iu.test(detail)) return "budget";
  if (/inconclusive|unknown|terminal evidence|native outcome|provider/iu.test(detail)) return "native-uncertain";
  if (/malformed/iu.test(detail)) return "malformed";
  return "recovery";
}

function attentionRisk(category: ObjectiveAttentionCategory): "low" | "medium" | "high" | "critical" {
  if (category === "native-uncertain" || category === "malformed") return "critical";
  if (category === "approval" || category === "recovery") return "high";
  if (category === "budget") return "high";
  return "medium";
}

function attentionUrgency(category: ObjectiveAttentionCategory): "low" | "normal" | "high" | "critical" {
  if (category === "native-uncertain" || category === "malformed") return "critical";
  if (category === "approval" || category === "budget") return "high";
  if (category === "recovery") return "high";
  return "normal";
}

function attentionConfidence(category: ObjectiveAttentionCategory): number {
  if (category === "approval" || category === "budget" || category === "control-wait") return 1;
  if (category === "native-uncertain") return 0.9;
  if (category === "recovery") return 0.85;
  return 0.65;
}

function attentionReason(
  intent: ObjectiveSupervisorIntent | ObjectiveControlIntent,
  category: ObjectiveAttentionCategory,
): string {
  return `Objective ${category} boundary reached while supervising ${intent.kind} intent ${intent.intentId}.`;
}

function attentionProposedAction(
  category: ObjectiveAttentionCategory,
  intent: ObjectiveSupervisorIntent | ObjectiveControlIntent,
): string {
  if (category === "approval") return "Resolve the bound objective approval through its existing idempotent approval command.";
  if (category === "native-uncertain") return "Reconcile matching native evidence before retrying or settling this objective operation.";
  if (category === "budget") return "Reconcile the durable objective budget or policy state before resuming dispatch.";
  if (category === "control-wait") return `Wait for the bound control ${intent.kind} condition or evidence; no authority expansion is implied.`;
  if (category === "malformed") return "Repair the malformed durable objective state, then retry the existing supervision operation.";
  return "Reconcile the bound objective state and retry the existing idempotent supervision operation when safe.";
}

function attentionAlternatives(category: ObjectiveAttentionCategory): ObjectiveAttentionAlternative[] {
  if (category === "approval") return [
    { id: "approve", label: "Approve", consequence: "The existing approval command resumes the bound objective operation." },
    { id: "reject", label: "Reject", consequence: "The existing approval command records a terminal rejection." },
  ];
  if (category === "control-wait") return [
    { id: "continue-wait", label: "Continue waiting", consequence: "The control frontier remains durably suspended." },
    { id: "recover", label: "Recover", consequence: "An operator reconciles the bound control evidence." },
  ];
  return [
    { id: "reconcile", label: "Reconcile", consequence: "Durable evidence is repaired or supplied before resumption." },
    { id: "stop", label: "Stop", consequence: "The objective remains blocked until an existing cancellation or recovery command is used." },
  ];
}

function attentionNodeId(intent: ObjectiveSupervisorIntent | ObjectiveControlIntent): string | null {
  const candidate = intent as unknown as Record<string, unknown>;
  if (typeof candidate.nodeId === "string") return candidate.nodeId;
  if (intent.kind === "wait-for-approval" && intent.approval.taskId) return intent.approval.taskId;
  if (intent.kind === "dispatch") return intent.tasks[0]?.task.id ?? null;
  if (intent.kind === "evaluate" && "taskIds" in intent) return intent.taskIds[0] ?? null;
  return null;
}

function attentionAttemptId(intent: ObjectiveSupervisorIntent | ObjectiveControlIntent): string | null {
  const candidate = intent as unknown as Record<string, unknown>;
  if (typeof candidate.attemptId === "string") return candidate.attemptId;
  if (intent.kind === "dispatch") return intent.tasks[0]?.attemptId ?? null;
  return null;
}

function attentionBlockedResource(
  run: ObjectiveRunRecord,
  intent: ObjectiveSupervisorIntent | ObjectiveControlIntent,
  detail: string,
  category: ObjectiveAttentionCategory,
): ObjectiveAttentionBlockedResource | null {
  const candidate = intent as unknown as Record<string, unknown>;
  if (intent.kind === "wait-for-approval") return { kind: "other", id: intent.approvalId, description: "Pending objective approval." };
  if (intent.kind === "agent" && intent.operation === "approval") return { kind: "other", id: `control-approval:${intent.nodeId}`, description: "Pending control-node approval." };
  if (typeof candidate.attemptId === "string") return { kind: "agent", id: candidate.attemptId, description: "Bound native objective attempt." };
  if (category === "budget") return { kind: "capability", id: "objective-budget", description: "Durable budget or policy state." };
  if (category === "control-wait" && candidate.execution) return { kind: "other", id: createAttentionHash(JSON.stringify(candidate.execution)), description: detail };
  if (/workspace|file/iu.test(detail)) return { kind: "workspace", id: run.runId, description: detail };
  if (/conductor|planner|agent/iu.test(detail)) return { kind: "agent", id: run.conductorAgentId ?? "objective-conductor", description: detail };
  return null;
}

function attentionResourceDescription(resource: ObjectiveAttentionBlockedResource | null): string | null {
  if (!resource) return null;
  return typeof resource === "string" ? resource : `${resource.kind}:${resource.id}`;
}

function attentionExpiry(
  run: ObjectiveRunRecord,
  intent: ObjectiveSupervisorIntent | ObjectiveControlIntent,
  approval: ObjectiveApprovalRecord | null,
  category: ObjectiveAttentionCategory,
): string | null {
  if (approval?.expiresAt) return approval.expiresAt;
  const candidate = intent as unknown as Record<string, unknown>;
  if ((intent.kind === "signal" || intent.kind === "timer") && typeof candidate.expiresAt === "string") return candidate.expiresAt;
  if (category === "budget" && run.policy?.expiresAt) return run.policy.expiresAt;
  return null;
}

function attentionAssignee(run: ObjectiveRunRecord, approval: ObjectiveApprovalRecord | null): { type: "user" | "agent" | "system"; id: string } | null {
  if (approval?.requestedBy) return approval.requestedBy;
  if (run.conductorAgentId) return { type: "agent", id: run.conductorAgentId };
  return { type: "user", id: "local-user" };
}

function attentionEvidenceRefs(store: SymphonyStore, runId: string): ObjectiveAttentionEvidenceRef[] {
  const cursor = store.latestCursor();
  const refs: ObjectiveAttentionEvidenceRef[] = [{ kind: "trace", id: `objective-event-cursor:${runId}:${cursor}`, cursor }];
  for (const event of store.recentEvents({ runId, limit: 16 })) {
    refs.push({ kind: "event", id: event.id, cursor: event.cursor });
  }
  return refs.slice(-128);
}

function attentionEventPayload(
  attention: ObjectiveAttentionRecord,
  intent: ObjectiveSupervisorIntent | ObjectiveControlIntent,
): JsonValue {
  return {
    attentionId: attention.id,
    operationId: attention.operationId,
    intentId: intent.intentId,
    objectiveId: attention.objectiveId,
    runId: attention.runId,
    nodeId: attention.nodeId,
    attemptId: attention.attemptId,
    status: attention.status,
    risk: attention.risk,
    urgency: attention.urgency,
    confidence: attention.confidence,
    reason: attention.reason,
    consequence: attention.consequence,
    blockedResource: attention.blockedResource as JsonValue,
    proposedAction: attention.proposedAction,
    authorityBoundary: attention.authorityBoundary as JsonValue,
    evidenceRefs: attention.evidenceRefs as JsonValue,
    expiresAt: attention.expiresAt,
    requestKey: attention.requestKey,
  } as unknown as JsonValue;
}

function malformedAttentionIntent(run: ObjectiveRunRecord, intentId: string): ObjectiveSupervisorIntent {
  return {
    runId: run.runId,
    objectiveId: run.objectiveId,
    planRevision: run.activePlanRevision,
    intentId,
    acknowledgementKey: `objective-malformed-attention:${intentId}`,
    kind: "finish",
    state: "failed",
    output: null,
    error: "Malformed supervisor state.",
  };
}

function budgetAtLimit(usage: ObjectiveBudgetUsage, limits: ObjectiveBudgetLimits): boolean {
  const checks: Array<[keyof ObjectiveBudgetUsage, keyof ObjectiveBudgetLimits]> = [
    ["costUsd", "maxCostUsd"],
    ["inputTokens", "maxInputTokens"],
    ["outputTokens", "maxOutputTokens"],
    ["totalTokens", "maxTotalTokens"],
    ["modelCalls", "maxModelCalls"],
    ["toolCalls", "maxToolCalls"],
    ["wallTimeSeconds", "maxWallTimeSeconds"],
    ["outputBytes", "maxOutputBytes"],
    ["storageBytes", "maxStorageBytes"],
    ["loopIterations", "maxLoopIterations"],
  ];
  return checks.some(([usageKey, limitKey]) => {
    const limit = limits[limitKey];
    return limit !== null && usage[usageKey] >= limit;
  });
}

function minPermission(...permissions: Array<Permission | undefined>): Permission {
  return permissions.some((permission) => permission === "read-only") ? "read-only" : "full-access";
}

function valueCharterWorkOrderFields(
  run: ObjectiveRunRecord,
): Pick<AgentWorkOrder, "valueCharter" | "valueCharterRevision" | "valueCharterHash"> {
  if (!run.spec.valueCharter) return {};
  const charter = normalizeObjectiveValueCharter(run.spec.valueCharter);
  const binding = objectiveValueCharterBindingForSpec({ ...run.spec, valueCharter: charter });
  if (!binding) return {};
  if (run.valueCharterRevision !== undefined && run.valueCharterRevision !== binding.revision) {
    throw new Error(`Objective ${run.runId} carries a charter revision that disagrees with its immutable charter.`);
  }
  if (run.valueCharterHash !== undefined && run.valueCharterHash !== binding.hash) {
    throw new Error(`Objective ${run.runId} carries a charter hash that disagrees with its immutable charter.`);
  }
  return {
    valueCharter: charter,
    valueCharterRevision: binding.revision,
    valueCharterHash: binding.hash,
  };
}

function intersectCapabilityCeilings(...ceilings: Array<readonly string[] | undefined>): string[] | undefined {
  const present = ceilings.filter((ceiling): ceiling is readonly string[] => ceiling !== undefined);
  if (present.length === 0) return undefined;
  const intersection = new Set(present[0]);
  for (const ceiling of present.slice(1)) {
    for (const capability of intersection) if (!ceiling.includes(capability)) intersection.delete(capability);
  }
  return [...intersection].sort((left, right) => left.localeCompare(right));
}

function minSideEffectClass(...ceilings: Array<ObjectiveSideEffectClass | undefined>): ObjectiveSideEffectClass | undefined {
  const present = ceilings.filter((ceiling): ceiling is ObjectiveSideEffectClass => ceiling !== undefined);
  if (present.length === 0) return undefined;
  const rank: Record<ObjectiveSideEffectClass, number> = { read: 0, local: 1, external: 2, irreversible: 3 };
  return present.sort((left, right) => rank[left] - rank[right])[0];
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRetryableBudgetAttention(detail: string | null): boolean {
  return detail?.includes("provider usage is unknown") ?? false;
}

function metadataString(metadata: Record<string, JsonValue>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function agentTaskState(agent: AgentRecord): Extract<ObjectiveTaskUpdate["state"], "running" | "completed" | "failed"> | null {
  if (agent.status === "completed") return "completed";
  if (agent.status === "failed") return "failed";
  if (agent.status === "starting" || agent.status === "running") return "running";
  // The objective protocol currently has no dispatching state. Keep the
  // assignment claimed in durable metadata until native startup reaches
  // starting/running, then acknowledge the dispatch as objective-running.
  return null;
}

function isUncertainAgentStatus(status: AgentRecord["status"]): boolean {
  return status === "cancelled" || status === "interrupted" || status === "lost";
}

function plannerStatus(agent: AgentRecord): "claimed" | "dispatched" | "failed" {
  if (agent.status === "failed" || agent.status === "cancelled" || agent.status === "interrupted" || agent.status === "lost") return "failed";
  return ["starting", "running", "completed"].includes(agent.status) ? "dispatched" : "claimed";
}

function isNativeProgressEvent(event: EventEnvelope): boolean {
  return [
    "agent.queued",
    "agent.routed",
    "agent.starting",
    "agent.running",
    "agent.completed",
    "agent.failed",
    "agent.cancelled",
    "agent.interrupted",
    "agent.lost",
    "driver.run.completed",
    "driver.run.failed",
    "driver.run.cancelled",
    "driver.usage.recorded",
  ].includes(event.type);
}

function isRunnerNotificationEvent(type: string): boolean {
  return [
    "objective.task.dispatched",
    "objective.task.completed",
    "objective.task.failed",
    "objective.evaluation.completed",
    "objective.control.evaluation.completed",
    "objective.supervisor.replan-requested",
    "objective.supervisor.attention",
    "objective.attention.requested",
    "objective.attention.resolved",
    "objective.attention.expired",
    "objective.attention.escalated",
    "objective.supervisor.backpressure",
    "objective.supervisor.finished",
  ].includes(type);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldSupervise(run: ObjectiveRunRecord): boolean {
  if (!SUPERVISABLE_OBJECTIVE_STATES.includes(run.state)) return false;
  if (run.state === "failed") return run.tasks.some((task) => task.state === "failed" || task.state === "blocked") && run.replanCount < run.spec.maxReplans;
  return true;
}
