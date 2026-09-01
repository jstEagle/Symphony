import { createHash } from "node:crypto";
import { ulid } from "ulid";
import {
  ObjectiveApprovalRecordSchema,
  ObjectiveBudgetLimitsSchema,
  ObjectivePolicyRequestSchema,
  ObjectivePolicySnapshotSchema,
  ObjectiveActorSchema,
  ObjectiveCheckpointRecordSchema,
  ObjectiveRunRecordSchema,
  ObjectiveSpecSchema,
  ObjectiveTaskSchema,
  ObjectiveTaskRecordSchema,
  ObjectiveControlPlanSchema,
  ObjectiveControlMutationSchema,
  isObjectivePolicyHashValid,
  objectivePolicyHash,
  PermissionSchema,
  parseWorkspaceManifest,
  WorkspaceSpecSchema,
  resolveChildPermission,
  type JsonValue,
  type EventEnvelope,
  type ObjectiveActor,
  type ObjectiveApprovalRecord,
  type ObjectiveApprovalPolicy,
  type ObjectiveBudgetLimits,
  type ObjectiveCheckpointRecord,
  type ObjectiveCriterion,
  type ObjectiveCriterionResult,
  type ObjectiveRunRecord,
  type ObjectiveRunState,
  type ObjectivePolicyRequest,
  type ObjectivePolicySnapshot,
  type ObjectiveSpec,
  type ObjectiveTask,
  type ObjectiveTaskRecord,
  type ObjectiveTaskState,
  type Permission,
  type WorkspaceSpec,
  type ObjectiveSideEffectClass,
  type ObjectiveControlPlan,
  type ObjectiveControlPlanRevision,
  type ObjectiveControlPlanSnapshot,
  type ObjectiveControlMutation,
  type ObjectiveControlExecutionKey,
  objectiveControlExecutionId,
  ObjectiveControlSignalDeliveryInputSchema,
  objectiveControlSubscriptionKey,
  ObjectiveControlSignalDeliveryRecordSchema,
  type ObjectiveControlSignalDeliveryInput,
  type ObjectiveControlSignalDeliveryRecord,
  type ObjectiveControlSuspensionRecord,
  type WorkspaceManifest,
} from "@symphony/protocol";
import { childWorkspaceGrant, WorkspaceContainmentError } from "./workspace-containment.js";
import {
  applyObjectiveControlAcknowledgement,
  createObjectiveControlSnapshot,
  nextObjectiveControlIntent,
  pinObjectiveControlPlan,
  ObjectiveControlAcknowledgementSchema,
  type ObjectiveControlAcknowledgement,
  type ObjectiveControlAgentIntent,
  type ObjectiveControlIntent,
} from "./objective-control-plan.js";
import {
  bindObjectiveValueCharterToMutation,
  normalizeObjectiveSpecValueCharter,
  objectiveValueCharterBindingForSpec,
} from "./objective-values.js";

/**
 * The Objective Runtime deliberately depends on a small repository contract,
 * rather than SymphonyStore. This keeps the kernel usable by the daemon and
 * test harnesses while making all durable boundaries explicit to the caller.
 */
export type ObjectiveActionKind =
  | "objective.create"
  | "objective.plan.commit"
  | "objective.checkpoint.commit"
  | "objective.approval.request"
  | "objective.approval.resolve"
  | "objective.supervisor.ack"
  | "objective.control.ack";

export type ObjectiveActionReceipt = Readonly<{
  requestKey: string;
  kind: ObjectiveActionKind;
  fingerprint: string;
  result: JsonValue;
  createdAt: string;
}>;

/**
 * A semantic objective event that is committed with the state transition that
 * caused it.  The repository may persist this intent in an outbox and publish
 * the concrete event only after the enclosing durable transaction commits.
 */
export type ObjectiveSemanticEventIntent = Readonly<{
  eventKey: string;
  eventId: string;
  event: Omit<EventEnvelope, "id" | "cursor">;
}>;

/** Provider-neutral view of the durable control head. */
export type ObjectiveControlHead = Readonly<{
  version: 1;
  runId: string;
  objectiveId: string;
  planId: string;
  source: ObjectiveControlPlanRevision["source"];
  activeRevision: number;
  latestSnapshotSequence: number;
  createdAt: string;
  updatedAt: string;
}>;

export interface ObjectiveRepository {
  /** Wraps one complete action in the adapter's durable transaction when available. */
  withDurableTransaction?<T>(callback: () => T): T;
  getObjectiveRun(runId: string): ObjectiveRunRecord | null;
  getObjectiveRunByRequestKey(requestKey: string): ObjectiveRunRecord | null;
  /** The adapter owns persistence ordering; the kernel does not provide a transaction. */
  saveObjectiveRun(run: ObjectiveRunRecord): void;
  /** Optional durable admission hook for the initial budget aggregate. */
  initializeObjectiveBudgetLedger?: (run: ObjectiveRunRecord) => void;

  getObjectiveActionReceipt(requestKey: string): ObjectiveActionReceipt | null;
  saveObjectiveActionReceipt(receipt: ObjectiveActionReceipt): boolean;

  /** Optional durable semantic-event outbox, implemented by the daemon adapter. */
  appendObjectiveEventIntent?: (event: ObjectiveSemanticEventIntent) => boolean;
  /** Publish committed outbox entries and replay any entries left pending by a crash. */
  drainObjectiveEventOutbox?: (options?: { batchSize?: number }) => number;

  /** Checkpoint identity is scoped by run in the durable store. */
  getObjectiveCheckpoint(runId: string, checkpointId: string): ObjectiveCheckpointRecord | null;
  /** Prefer appendObjectiveCheckpoint; saveObjectiveCheckpoint is a legacy adapter alias. */
  appendObjectiveCheckpoint?: (checkpoint: ObjectiveCheckpointRecord) => boolean;
  saveObjectiveCheckpoint?: (checkpoint: ObjectiveCheckpointRecord) => boolean;

  /** Approval identity is scoped by run in the durable store. */
  getObjectiveApproval(runId: string, approvalId: string): ObjectiveApprovalRecord | null;
  saveObjectiveApproval(approval: ObjectiveApprovalRecord): boolean;

  /** Optional tree-shaped control plane. Legacy repositories may omit it. */
  getObjectiveControlHead?: (runId: string) => ObjectiveControlHead | null;
  getObjectiveControlPlanRevision?: (runId: string, revision: number) => ObjectiveControlPlanRevision | null;
  getLatestObjectiveControlPlanRevision?: (runId: string) => ObjectiveControlPlanRevision | null;
  /** Alias for adapters that expose the storage method name directly. */
  latestObjectiveControlPlanRevision?: (runId: string) => ObjectiveControlPlanRevision | null;
  getLatestObjectiveControlSnapshot?: (runId: string) => ObjectiveControlPlanSnapshot | null;
  /** Alias for adapters that expose the storage method name directly. */
  latestObjectiveControlSnapshot?: (runId: string) => ObjectiveControlPlanSnapshot | null;
  saveObjectiveControlPlanRevision?: (
    revision: ObjectiveControlPlanRevision,
    snapshot: ObjectiveControlPlanSnapshot,
    options?: { expectedActiveRevision?: number; expectedRevision?: number },
  ) => boolean;
  saveObjectiveControlSnapshot?: (snapshot: ObjectiveControlPlanSnapshot) => boolean;
  /** Storage performs the pure mutation reduction and durable CAS in one transaction. */
  commitObjectiveControlMutationDerived?: (mutation: ObjectiveControlMutation) => ObjectiveControlMutationCommit;
  getObjectiveControlMutation?: (mutationId: string) => ObjectiveControlMutationRecord | null;
  getObjectiveControlMutationByRequestKey?: (runId: string, requestKey: string) => ObjectiveControlMutationRecord | null;
  listObjectiveControlMutations?: (runId: string) => ObjectiveControlMutationRecord[];
  getObjectiveControlSuspension?: (runId: string, executionId: string) => import("@symphony/protocol").ObjectiveControlSuspensionRecord | null;
  listObjectiveControlSuspensions?: (runId: string, options?: { status?: import("@symphony/protocol").ObjectiveControlSuspensionRecord["status"] }) => import("@symphony/protocol").ObjectiveControlSuspensionRecord[];
  getObjectiveControlSignalDelivery?: (subscriptionKey: string, deliveryId: string) => ObjectiveControlSignalDeliveryRecord | null;
  saveObjectiveControlSignalDelivery?: (record: ObjectiveControlSignalDeliveryRecord) => boolean;
}

/**
 * Authority is intentionally a required argument to every mutating method.
 * The runtime never invents a principal or upgrades an omitted permission
 * envelope to full-access. A daemon should derive this envelope from its
 * authenticated command/agent capability before entering the kernel.
 */
export type ObjectiveRuntimeAuthority = Readonly<{
  actor: ObjectiveActor;
  permissionCeiling: Permission;
  /**
   * Optional immutable filesystem capability inherited from the daemon's
   * caller. Objective tasks may narrow this grant, never widen it.
   */
  workspace?: WorkspaceSpec | null;
  /** Capabilities available to the authenticated caller. */
  allowedCapabilities?: readonly string[];
  /** Additional caller policy ceilings, supplied by the daemon. */
  policy?: ObjectivePolicyRequest | null;
}>;

export type ObjectiveRuntimeOperation = ObjectiveActionKind;

export type ObjectiveRuntimeOptions = Readonly<{
  now?: () => string;
  id?: () => string;
  /** Current daemon-wide safety ceiling used at admission. */
  policyCeiling?: ObjectivePolicyRequest | null | (() => ObjectivePolicyRequest | null);
}>;

export type ObjectiveControlState = Readonly<{
  head: ObjectiveControlHead;
  revision: ObjectiveControlPlanRevision;
  snapshot: ObjectiveControlPlanSnapshot;
}>;

export type ObjectiveControlMutationCommit = Readonly<{
  status: "committed" | "replayed" | "conflict";
  head: ObjectiveControlHead | null;
  revision: ObjectiveControlPlanRevision | null;
  snapshot: ObjectiveControlPlanSnapshot | null;
  reason?: string;
}>;

export type ObjectiveControlMutationRecord = Readonly<{
  version: 1;
  mutationId: string;
  requestKey: string;
  planId: string;
  objectiveId: string;
  runId: string;
  expectedRevision: number;
  resultingRevision: number;
  snapshotSequence: number;
  revisionId: string;
  mutation: ObjectiveControlMutation;
  createdAt: string;
}>;

export type ObjectiveControlSignalDeliveryResult = Readonly<{
  status: "delivered" | "replayed";
  runId: string;
  objectiveId: string;
  execution: { nodeId: string; iterationKey: string };
  attemptId: string;
  signalKey: string;
  subscriptionKey: string;
  deliveryId: string;
  payload: JsonValue;
}>;

export type ObjectiveCreateInput = Readonly<{
  runId?: string;
  objectiveId?: string;
  /** Objective aggregate revision selected by the daemon before admission. */
  objectiveRevision?: number;
  workflowId: string;
  workflowRevision: number;
  workflowHash: string;
  conductorAgentId?: string | null;
  /** Persisted by the daemon as the objective's immutable authority input. */
  workspace?: WorkspaceSpec | null;
  /** Optional caller request; the daemon derives the effective snapshot. */
  policy?: ObjectivePolicyRequest | null;
  /** Alias accepted by integrations that call this an admission policy. */
  requestedPolicy?: ObjectivePolicyRequest | null;
  spec: ObjectiveSpec;
  tasks?: readonly ObjectiveTask[];
  context?: Readonly<Record<string, JsonValue>>;
  /** Optional immutable tree-shaped plan admitted alongside the objective run. */
  controlPlan?: ObjectiveControlPlan | null;
  requestKey: string;
}>;

export type ObjectivePlanCommitInput = Readonly<{
  expectedPlanRevision: number;
  tasks: readonly ObjectiveTask[];
  reason?: string;
  policyHash?: string;
  requestKey: string;
}>;

export type ObjectiveTaskUpdate = Readonly<{
  taskId: string;
  state: Extract<ObjectiveTaskState, "queued" | "waiting-approval" | "running" | "completed" | "failed">;
  attemptId?: string | null;
  agentId?: string | null;
  output?: JsonValue | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}>;

export type ObjectiveCheckpointInput = Readonly<{
  eventCursor: number;
  /**
   * A shallow top-level patch over the run's durable context. Keys omitted
   * here remain unchanged; a supplied value (including null) replaces the
   * existing value for that key. Nested objects are values, not deep-merged.
   */
  context?: Readonly<Record<string, JsonValue>>;
  taskUpdates?: readonly ObjectiveTaskUpdate[];
  reason: string;
  policyHash?: string;
  /** Portable checkpoint evidence. The daemon derives identity fields. */
  objectiveRevision?: number;
  workflowRevision?: number;
  workflowHash?: string;
  controlPlanRevision?: number | null;
  controlPlanHash?: string | null;
  flatExecution?: ObjectiveCheckpointRecord["flatExecution"];
  treeExecution?: ObjectiveCheckpointRecord["treeExecution"];
  outputs?: Readonly<Record<string, JsonValue>>;
  attemptHighWater?: number;
  eventHighWater?: number;
  artifactHashes?: ObjectiveCheckpointRecord["artifactHashes"];
  workspaceEvidence?: ObjectiveCheckpointRecord["workspaceEvidence"];
  /** Optional content-addressed workspace boundary for portable recovery. */
  workspaceManifest?: WorkspaceManifest | null;
  nativeSessions?: ObjectiveCheckpointRecord["nativeSessions"];
  continuity?: ObjectiveCheckpointRecord["continuity"];
  unresolvedExternalOperations?: ObjectiveCheckpointRecord["unresolvedExternalOperations"];
  unresolvedExternalSideEffects?: ObjectiveCheckpointRecord["unresolvedExternalSideEffects"];
  policySnapshotHash?: string | null;
  configSnapshotHash?: string | null;
  provenance?: ObjectiveCheckpointRecord["provenance"];
  requestKey: string;
}>;

export type ObjectiveApprovalRequestInput = Readonly<{
  kind: ObjectiveApprovalRecord["kind"];
  taskId?: string | null;
  question: string;
  scope?: Readonly<Record<string, JsonValue>>;
  operationId: string;
  requestHash: string;
  policyHash: string;
  sideEffectClass: ObjectiveApprovalRecord["sideEffectClass"];
  canonicalTarget: string;
  expiresAt?: string | null;
  capability?: string;
  requestKey: string;
}>;

export type ObjectiveApprovalResolutionInput = Readonly<{
  status: Extract<ObjectiveApprovalRecord["status"], "approved" | "rejected" | "expired" | "cancelled">;
  decision?: JsonValue | null;
  requestKey: string;
}>;

export class ObjectiveRuntimeError extends Error {
  constructor(message: string, readonly code: ObjectiveRuntimeErrorCode) {
    super(message);
    this.name = "ObjectiveRuntimeError";
  }
}

export type ObjectiveRuntimeErrorCode =
  | "not-found"
  | "invalid-authority"
  | "idempotency-conflict"
  | "revision-conflict"
  | "invalid-state"
  | "invalid-plan"
  | "replan-limit"
  | "approval-required"
  | "approval-not-found"
  | "authority-exceeded"
  | "policy-expired"
  | "policy-mismatch";

const MAX_TASKS = 128;

export class ObjectiveRuntime {
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly policyCeiling: () => ObjectivePolicyRequest | null;

  constructor(
    private readonly repository: ObjectiveRepository,
    options: ObjectiveRuntimeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => ulid());
    const configuredPolicyCeiling = options.policyCeiling;
    this.policyCeiling = typeof configuredPolicyCeiling === "function"
      ? () => {
          const current = configuredPolicyCeiling();
          return current ? ObjectivePolicyRequestSchema.parse(current) : null;
        }
      : () => configuredPolicyCeiling ? ObjectivePolicyRequestSchema.parse(configuredPolicyCeiling) : null;
  }

  create(input: ObjectiveCreateInput, authority: ObjectiveRuntimeAuthority): ObjectiveRunRecord {
    return this.withDurableTransaction(() => this.createAction(input, authority));
  }

  private createAction(input: ObjectiveCreateInput, authority: ObjectiveRuntimeAuthority): ObjectiveRunRecord {
    this.assertAuthority(authority);
    const spec = normalizeObjectiveSpecValueCharter(ObjectiveSpecSchema.parse(input.spec));
    const valueCharterBinding = objectiveValueCharterBindingForSpec(spec);
    const tasks = (input.tasks ?? []).map((task) => ObjectiveTaskSchema.parse(task));
    const controlPlan = input.controlPlan === undefined || input.controlPlan === null
      ? null
      : ObjectiveControlPlanSchema.parse(input.controlPlan);
    // Admission policy is the task authority envelope. Derive it before
    // checking task permissions/capabilities so a requested read-only policy
    // cannot be bypassed by a full-access task in the same request.
    this.assertRequestKey(input.requestKey);

    const payload = {
      runId: input.runId ?? null,
      objectiveId: input.objectiveId ?? null,
      objectiveRevision: input.objectiveRevision ?? null,
      workflowId: input.workflowId,
      workflowRevision: input.workflowRevision,
      workflowHash: input.workflowHash,
      conductorAgentId: input.conductorAgentId ?? null,
      workspace: input.workspace ?? null,
      policy: input.policy ?? input.requestedPolicy ?? null,
      spec,
      tasks,
      context: input.context ?? {},
      controlPlan,
    };
    const existingReceipt = this.replayReceipt(input.requestKey, "objective.create", payload);
    if (existingReceipt) return this.requireRun(asString(existingReceipt.result, "objective.create result"));
    const existingByRequestKey = this.repository.getObjectiveRunByRequestKey(input.requestKey);
    if (existingByRequestKey) {
      const existingIntent = {
        objectiveId: existingByRequestKey.objectiveId,
        workflowId: existingByRequestKey.workflowId,
        workflowRevision: existingByRequestKey.workflowRevision,
        workflowHash: existingByRequestKey.workflowHash,
        conductorAgentId: existingByRequestKey.conductorAgentId,
        workspace: existingByRequestKey.policy?.workspace ?? null,
        policy: existingByRequestKey.policy
          ? policyRequestFromSnapshot(existingByRequestKey.policy)
          : null,
        spec: existingByRequestKey.spec,
        tasks: existingByRequestKey.tasks.map((record) => record.task),
        context: existingByRequestKey.context,
        controlPlan: this.repository.getObjectiveControlPlanRevision?.(existingByRequestKey.runId, 0)?.plan
          ?? this.repository.getLatestObjectiveControlPlanRevision?.(existingByRequestKey.runId)?.plan
          ?? this.repository.latestObjectiveControlPlanRevision?.(existingByRequestKey.runId)?.plan
          ?? null,
      };
      const requestedIntent = {
        objectiveId: input.objectiveId ?? spec.id,
        workflowId: input.workflowId,
        workflowRevision: input.workflowRevision,
        workflowHash: input.workflowHash,
        conductorAgentId: input.conductorAgentId ?? null,
        workspace: input.workspace ?? null,
        policy: input.policy ?? input.requestedPolicy ?? null,
        spec,
        tasks,
        context: input.context ?? {},
        controlPlan,
      };
      if (fingerprint(existingIntent) !== fingerprint(requestedIntent)) throw new ObjectiveRuntimeError(`Request ${input.requestKey} was already used for a different objective.`, "idempotency-conflict");
      return existingByRequestKey;
    }

    const now = this.now();
    const runId = input.runId ?? this.id();
    // Direct legacy runtime callers did not have an admission authority
    // envelope. Keep those records policy-less for compatibility; the daemon
    // always supplies `authority.policy` (including the default ceiling), so
    // every API-admitted objective receives a real snapshot.
    const shouldAdmitPolicy = input.policy !== undefined
      || input.requestedPolicy !== undefined
      || authority.policy !== undefined
      || this.policyCeiling() !== null
      || input.workspace !== undefined
      || authority.workspace !== undefined
      || authority.allowedCapabilities !== undefined;
    const policy = shouldAdmitPolicy
      ? deriveObjectivePolicySnapshot({
          runId,
          objectiveId: input.objectiveId ?? spec.id,
          workflowId: input.workflowId,
          workflowRevision: input.workflowRevision,
          workflowHash: input.workflowHash,
          actor: authority.actor,
          workspace: input.workspace ?? authority.workspace ?? null,
          spec,
          requestedPolicy: input.policy ?? input.requestedPolicy ?? null,
          authority,
          globalCeiling: this.policyCeiling(),
          createdAt: now,
        })
      : null;
    const taskAuthority = policy
      ? this.authorityWithinPolicy(policy, authority)
      : authority;
    this.assertTaskAuthority(tasks, taskAuthority);
    this.assertGraph(tasks);
    const records = tasks.map((task) => this.newTaskRecord(task));
    const run = ObjectiveRunRecordSchema.parse({
      version: 1,
      runId,
      objectiveId: input.objectiveId ?? spec.id,
      ...(input.objectiveRevision === undefined ? {} : { objectiveRevision: input.objectiveRevision }),
      workflowId: input.workflowId,
      workflowRevision: input.workflowRevision,
      workflowHash: input.workflowHash,
      conductorAgentId: input.conductorAgentId ?? null,
      ...(policy ? { policy, policyHash: policy.policyHash, pauseReason: null } : {}),
      ...(valueCharterBinding ? {
        valueCharterRevision: valueCharterBinding.revision,
        valueCharterHash: valueCharterBinding.hash,
      } : {}),
      spec,
      state: controlPlan || records.length > 0 ? "executing" : "planning",
      // Revision zero is the initial plan baseline. A persisted revision-1
      // record is created only by commitPlan, where the repository can fence
      // it against this baseline in one durable operation.
      activePlanRevision: 0,
      latestCheckpointId: null,
      pendingApprovalId: null,
      replanCount: 0,
      tasks: records,
      context: input.context ?? {},
      output: null,
      error: null,
      requestKey: input.requestKey,
      createdAt: now,
      updatedAt: now,
      startedAt: controlPlan || records.length > 0 ? now : null,
      finishedAt: null,
    });

    const duplicateRun = this.repository.getObjectiveRun(run.runId);
    if (duplicateRun) {
      if (duplicateRun.requestKey !== input.requestKey || stableStringify(duplicateRun) !== stableStringify(run)) {
        throw new ObjectiveRuntimeError(`Objective run ${run.runId} already exists with different intent.`, "idempotency-conflict");
      }
      return duplicateRun;
    }
    if (controlPlan && !this.repository.saveObjectiveControlPlanRevision) {
      throw new ObjectiveRuntimeError("The objective repository cannot admit control plans.", "invalid-state");
    }
    this.repository.saveObjectiveRun(run);
    if (controlPlan) this.admitControlPlan(run, controlPlan, authority);
    this.repository.initializeObjectiveBudgetLedger?.(run);
    this.saveReceipt({
      requestKey: input.requestKey,
      kind: "objective.create",
      fingerprint: fingerprint(payload),
      result: run.runId,
      createdAt: now,
    });

    if (records.some((record) => record.task.requiresApproval)) {
      const awaiting = this.requestApprovalInternal(run, {
        kind: "plan",
        taskId: null,
        question: "Approve the initial objective plan before its tasks start.",
        scope: { planRevision: run.activePlanRevision },
        operationId: `objective-plan:${run.runId}:${run.activePlanRevision}`,
        requestHash: fingerprint({ runId: run.runId, planRevision: run.activePlanRevision, tasks }),
        policyHash: policy?.policyHash ?? fingerprint(run.spec),
        sideEffectClass: "local",
        canonicalTarget: `${run.workflowId}:${run.objectiveId}:plan:${run.activePlanRevision}`,
        expiresAt: null,
        requestKey: `${input.requestKey}:initial-approval`,
      }, authority);
      return this.requireRun(awaiting.runId);
    }
    return run;
  }

  get(runId: string): ObjectiveRunRecord {
    return this.requireRun(runId);
  }

  /** Read the immutable control revision and its latest durable snapshot. */
  controlState(runId: string): ObjectiveControlState | null {
    const head = this.repository.getObjectiveControlHead?.(runId);
    if (!head) return null;
    const revision = this.repository.getObjectiveControlPlanRevision?.(runId, head.activeRevision)
      ?? this.repository.getLatestObjectiveControlPlanRevision?.(runId)
      ?? this.repository.latestObjectiveControlPlanRevision?.(runId);
    const snapshot = this.repository.getLatestObjectiveControlSnapshot?.(runId)
      ?? this.repository.latestObjectiveControlSnapshot?.(runId);
    if (!revision || !snapshot) {
      throw new ObjectiveRuntimeError(`Objective ${runId} has an incomplete durable control projection.`, "invalid-state");
    }
    if (
      revision.runId !== runId
      || revision.planId !== head.planId
      || revision.revision !== head.activeRevision
      || snapshot.runId !== runId
      || snapshot.planId !== head.planId
      || snapshot.planRevision !== head.activeRevision
      || snapshot.sequence !== head.latestSnapshotSequence
    ) {
      throw new ObjectiveRuntimeError(`Objective ${runId} control head does not match its durable revision/snapshot.`, "invalid-state");
    }
    const run = this.requireRun(runId);
    this.assertControlPlanCharterBinding(run, revision);
    return { head, revision, snapshot };
  }

  /** Derive one pure control intent from the latest durable snapshot. */
  nextControlIntent(runId: string): ObjectiveControlIntent | null {
    const state = this.controlState(runId);
    return state ? nextObjectiveControlIntent(state.revision.plan, state.snapshot, this.now()) : null;
  }

  /**
   * Apply one control acknowledgement and persist exactly one new snapshot.
   * The same request key is a durable receipt, so a crash before publication
   * can replay the acknowledgement without advancing the projection twice.
   */
  acknowledgeControl(
    runId: string,
    rawAcknowledgement: ObjectiveControlAcknowledgement,
    authority: ObjectiveRuntimeAuthority,
  ): ObjectiveControlState {
    return this.withDurableTransaction(() => this.acknowledgeControlAction(runId, rawAcknowledgement, authority));
  }

  /**
   * Deliver one external signal to a durable signal node.  Delivery identity
   * is deliberately derived from the scoped subscription and producer
   * delivery id, so a retry cannot resume another objective/run/execution.
   */
  deliverControlSignal(
    runId: string,
    rawInput: ObjectiveControlSignalDeliveryInput,
    authority: ObjectiveRuntimeAuthority,
  ): ObjectiveControlSignalDeliveryResult {
    return this.withDurableTransaction(() => {
      this.assertAuthority(authority);
      const input = ObjectiveControlSignalDeliveryInputSchema.parse(rawInput);
      const run = this.requireRun(runId);
      this.assertRunPolicy(run, authority);
      // A retry may arrive after the signal advanced the frontier to its
      // parent join. Consult the immutable delivery table before deriving the
      // current intent, otherwise a valid exactly-once retry would be rejected
      // merely because the wait is no longer the active frontier.
      const deliveredSuspension = input.subscriptionKey
        ? null
        : this.repository.listObjectiveControlSuspensions?.(runId, { status: "delivered" })
          ?.find((entry): entry is Extract<ObjectiveControlSuspensionRecord, { kind: "signal" }> => entry.kind === "signal" && entry.deliveryId === input.deliveryId && entry.signalKey === input.signalKey) ?? null;
      const priorSubscriptionKey = input.subscriptionKey ?? deliveredSuspension?.subscriptionKey;
      const priorDelivery = priorSubscriptionKey
        ? this.repository.getObjectiveControlSignalDelivery?.(priorSubscriptionKey, input.deliveryId) ?? null
        : null;
      if (priorDelivery) {
        if (
          priorDelivery.runId !== runId
          || priorDelivery.objectiveId !== run.objectiveId
          || priorDelivery.signalKey !== input.signalKey
          || fingerprint(priorDelivery.payload) !== fingerprint(input.payload)
          || (input.subscriptionKey !== undefined && input.subscriptionKey !== priorDelivery.subscriptionKey)
          || (input.attemptId !== undefined && input.attemptId !== priorDelivery.attemptId)
        ) throw new ObjectiveRuntimeError("Signal delivery identity conflicts with an existing durable delivery receipt.", "idempotency-conflict");
        return {
          status: "replayed",
          runId,
          objectiveId: run.objectiveId,
          execution: priorDelivery.execution,
          attemptId: priorDelivery.attemptId,
          signalKey: priorDelivery.signalKey,
          subscriptionKey: priorDelivery.subscriptionKey,
          deliveryId: priorDelivery.deliveryId,
          payload: priorDelivery.payload,
        };
      }
      const state = this.controlState(runId);
      if (!state) throw new ObjectiveRuntimeError(`Objective control plan not found: ${runId}.`, "not-found");
      const intent = nextObjectiveControlIntent(state.revision.plan, state.snapshot, this.now());
      if (intent.kind !== "signal") throw new ObjectiveRuntimeError(`Objective ${runId} is not waiting for an external signal.`, "invalid-state");
      const subscription = state.snapshot.executions.find((entry) => objectiveControlExecutionId(entry.key) === objectiveControlExecutionId(intent.execution))?.suspension;
      if (!subscription || subscription.kind !== "signal") throw new ObjectiveRuntimeError(`Objective ${runId} has no durable signal subscription.`, "invalid-state");
      if (input.signalKey !== subscription.signalKey) throw new ObjectiveRuntimeError(`Signal ${input.signalKey} does not match subscription ${subscription.signalKey}.`, "invalid-state");
      const expectedSubscriptionKey = objectiveControlSubscriptionKey({ objectiveId: run.objectiveId, runId, nodeId: intent.execution.nodeId, execution: intent.execution, attemptId: subscription.attemptId, signalKey: subscription.signalKey });
      if (subscription.subscriptionKey !== expectedSubscriptionKey) throw new ObjectiveRuntimeError("Durable signal subscription identity is invalid.", "invalid-state");
      if (input.subscriptionKey !== undefined && input.subscriptionKey !== subscription.subscriptionKey) throw new ObjectiveRuntimeError("Signal subscription key does not match the objective execution.", "authority-exceeded");
      if (input.attemptId !== undefined && input.attemptId !== subscription.attemptId) throw new ObjectiveRuntimeError("Signal attempt identity does not match the objective execution.", "authority-exceeded");
      const requestKey = `objective-control-signal:${runId}:${subscription.subscriptionKey}:${input.deliveryId}`;
      const payload = { runId, input };
      const activePriorDelivery = this.repository.getObjectiveControlSignalDelivery?.(subscription.subscriptionKey, input.deliveryId) ?? null;
      if (activePriorDelivery) {
        if (
          activePriorDelivery.runId !== runId
          || activePriorDelivery.objectiveId !== run.objectiveId
          || activePriorDelivery.nodeId !== intent.execution.nodeId
          || activePriorDelivery.execution.iterationKey !== intent.execution.iterationKey
          || activePriorDelivery.attemptId !== subscription.attemptId
          || activePriorDelivery.signalKey !== input.signalKey
          || fingerprint(activePriorDelivery.payload) !== fingerprint(input.payload)
        ) {
          throw new ObjectiveRuntimeError("Signal delivery identity conflicts with an existing durable delivery receipt.", "idempotency-conflict");
        }
        const latest = this.controlState(runId);
        const record = latest?.snapshot.executions.find((entry) => objectiveControlExecutionId(entry.key) === objectiveControlExecutionId(intent.execution));
        if (!latest || !record?.suspension || record.suspension.kind !== "signal") throw new ObjectiveRuntimeError("Signal delivery receipt points to missing durable state.", "invalid-state");
        return {
          status: "replayed",
          runId,
          objectiveId: run.objectiveId,
          execution: intent.execution,
          attemptId: activePriorDelivery.attemptId,
          signalKey: activePriorDelivery.signalKey,
          subscriptionKey: activePriorDelivery.subscriptionKey,
          deliveryId: activePriorDelivery.deliveryId,
          payload: activePriorDelivery.payload,
        };
      }
      const replay = this.replayReceipt(requestKey, "objective.control.ack", payload);
      if (replay) {
        const latest = this.controlState(runId);
        const record = latest?.snapshot.executions.find((entry) => objectiveControlExecutionId(entry.key) === objectiveControlExecutionId(intent.execution));
        if (!latest || !record?.suspension || record.suspension.kind !== "signal") throw new ObjectiveRuntimeError("Signal delivery receipt points to missing durable state.", "invalid-state");
        return {
          status: "replayed",
          runId,
          objectiveId: run.objectiveId,
          execution: intent.execution,
          attemptId: record.suspension.attemptId,
          signalKey: record.suspension.signalKey,
          subscriptionKey: record.suspension.subscriptionKey,
          deliveryId: record.suspension.deliveryId ?? input.deliveryId,
          payload: record.suspension.payload ?? input.payload,
        };
      }
      if (intent.operation === "expire") throw new ObjectiveRuntimeError(`Signal subscription ${subscription.subscriptionKey} has expired.`, "invalid-state");
      const next = this.acknowledgeControlAction(runId, {
        kind: "signal",
        intentId: intent.intentId,
        requestKey,
        signalKey: input.signalKey,
        subscriptionKey: subscription.subscriptionKey,
        deliveryId: input.deliveryId,
        payload: input.payload,
        attemptId: subscription.attemptId,
        now: input.occurredAt ?? this.now(),
        eventCursor: state.snapshot.eventCursor,
      }, authority);
      const record = next.snapshot.executions.find((entry) => objectiveControlExecutionId(entry.key) === objectiveControlExecutionId(intent.execution));
      if (!record?.suspension || record.suspension.kind !== "signal") throw new ObjectiveRuntimeError("Signal delivery did not produce a durable suspension record.", "invalid-state");
      const delivery = ObjectiveControlSignalDeliveryRecordSchema.parse({
        version: 1,
        id: `objective-control-signal-delivery:${fingerprint({ subscriptionKey: subscription.subscriptionKey, deliveryId: input.deliveryId })}`,
        objectiveId: run.objectiveId,
        runId,
        nodeId: intent.execution.nodeId,
        execution: intent.execution,
        attemptId: subscription.attemptId,
        signalKey: input.signalKey,
        subscriptionKey: subscription.subscriptionKey,
        deliveryId: input.deliveryId,
        payload: input.payload,
        deliveredAt: input.occurredAt ?? this.now(),
        deliveredBy: authority.actor,
      });
      if (this.repository.saveObjectiveControlSignalDelivery) {
        const saved = this.repository.saveObjectiveControlSignalDelivery(delivery);
        if (!saved) {
          const raced = this.repository.getObjectiveControlSignalDelivery?.(subscription.subscriptionKey, input.deliveryId);
          if (!raced || fingerprint(raced) !== fingerprint(delivery)) throw new ObjectiveRuntimeError("Signal delivery receipt lost an idempotency race.", "revision-conflict");
        }
      }
      return {
        status: "delivered",
        runId,
        objectiveId: run.objectiveId,
        execution: intent.execution,
        attemptId: record.suspension.attemptId,
        signalKey: record.suspension.signalKey,
        subscriptionKey: record.suspension.subscriptionKey,
        deliveryId: record.suspension.deliveryId ?? input.deliveryId,
        payload: record.suspension.payload ?? input.payload,
      };
    });
  }

  /** Expire a due timer/signal through the same typed reducer path. */
  expireControlSuspension(runId: string, executionId: string, authority: ObjectiveRuntimeAuthority): ObjectiveControlState {
    return this.withDurableTransaction(() => {
      this.assertAuthority(authority);
      const state = this.controlState(runId);
      if (!state) throw new ObjectiveRuntimeError(`Objective control plan not found: ${runId}.`, "not-found");
      const execution = state.snapshot.executions.find((entry) => objectiveControlExecutionId(entry.key) === executionId);
      if (!execution?.suspension) throw new ObjectiveRuntimeError(`Objective control suspension not found: ${executionId}.`, "not-found");
      const intent = nextObjectiveControlIntent(state.revision.plan, state.snapshot, this.now());
      if ((intent.kind !== "timer" && intent.kind !== "signal") || objectiveControlExecutionId(intent.execution) !== executionId || intent.operation !== "expire") {
        throw new ObjectiveRuntimeError(`Objective control suspension ${executionId} is not expired.`, "invalid-state");
      }
      return this.acknowledgeControlAction(runId, {
        kind: intent.kind,
        intentId: intent.intentId,
        requestKey: `objective-control-expiry:${runId}:${executionId}:${execution.suspension.expiresAt ?? "none"}`,
        now: this.now(),
        eventCursor: state.snapshot.eventCursor,
      }, authority);
    });
  }

  /** Terminally cancel all waiting control suspensions for a run. */
  cancelControlSuspensions(runId: string, authority: ObjectiveRuntimeAuthority): ObjectiveControlState | null {
    return this.withDurableTransaction(() => {
      this.assertAuthority(authority);
      let state = this.controlState(runId);
      if (!state) return null;
      for (const execution of [...state.snapshot.executions]) {
        const current = state.snapshot.executions.find((entry) => objectiveControlExecutionId(entry.key) === objectiveControlExecutionId(execution.key));
        if (!current?.suspension || current.suspension.status !== "waiting") continue;
        // A parallel control node may have several durable suspensions in its
        // frontier. Derive and acknowledge each target against a scoped
        // frontier; deriving only the global next intent would repeatedly see
        // the first waiting suspension and silently leave its siblings live.
        const scopedSnapshot = ObjectiveControlPlanSnapshotSchema.parse({ ...state.snapshot, frontier: [current.key] });
        const intent = nextObjectiveControlIntent(state.revision.plan, scopedSnapshot, this.now());
        if ((intent.kind !== "timer" && intent.kind !== "signal") || objectiveControlExecutionId(intent.execution) !== objectiveControlExecutionId(execution.key)) continue;
        state = this.acknowledgeControlAction(runId, {
          kind: intent.kind,
          intentId: intent.intentId,
          requestKey: `objective-control-cancel:${runId}:${objectiveControlExecutionId(execution.key)}`,
          reason: "Objective control suspension cancelled with its objective run.",
          state: "cancelled",
          now: this.now(),
          eventCursor: state.snapshot.eventCursor,
        }, authority, current.key);
      }
      return state;
    });
  }

  /**
   * Commit one typed control-plan mutation through the repository's durable
   * reducer/CAS boundary. The runtime only authenticates the caller and
   * returns the resulting durable head; storage remains the authority for
   * calculating and persisting the next immutable revision and snapshot.
   */
  mutateControlPlan(
    runId: string,
    rawMutation: ObjectiveControlMutation,
    authority: ObjectiveRuntimeAuthority,
  ): ObjectiveControlState {
    return this.withDurableTransaction(() => {
      this.assertAuthority(authority);
      const mutation = ObjectiveControlMutationSchema.parse(rawMutation);
      this.assertRequestKey(mutation.requestKey);
      const run = this.requireRun(runId);
      this.assertRunPolicy(run, authority);
      if (
        mutation.runId !== run.runId
        || mutation.objectiveId !== run.objectiveId
        || mutation.actor.type !== authority.actor.type
        || mutation.actor.id !== authority.actor.id
      ) {
        throw new ObjectiveRuntimeError("Objective control mutation identity is outside the authenticated run authority.", "authority-exceeded");
      }
      let boundMutation: ObjectiveControlMutation;
      try {
        boundMutation = bindObjectiveValueCharterToMutation(mutation, run.spec.valueCharter);
      } catch (error) {
        throw new ObjectiveRuntimeError(error instanceof Error ? error.message : "Objective strategy mutation violates its value charter.", "invalid-plan");
      }
      const commit = this.repository.commitObjectiveControlMutationDerived?.(boundMutation);
      if (!commit) throw new ObjectiveRuntimeError("The objective repository cannot commit control-plan mutations.", "invalid-state");
      if (commit.status === "conflict" || !commit.head || !commit.revision || !commit.snapshot) {
        throw new ObjectiveRuntimeError(commit.reason ?? `Objective control-plan mutation ${mutation.requestKey} conflicted.`, "revision-conflict");
      }
      if (commit.status === "replayed") {
        const current = this.controlState(runId);
        if (current) return current;
      }
      return { head: commit.head, revision: commit.revision, snapshot: commit.snapshot };
    });
  }

  private acknowledgeControlAction(
    runId: string,
    rawAcknowledgement: ObjectiveControlAcknowledgement,
    authority: ObjectiveRuntimeAuthority,
    executionOverride?: ObjectiveControlExecutionKey,
  ): ObjectiveControlState {
    this.assertAuthority(authority);
    const acknowledgement = ObjectiveControlAcknowledgementSchema.parse(rawAcknowledgement);
    this.assertRequestKey(acknowledgement.requestKey);
    const payload = { runId, acknowledgement };
    const replay = this.replayReceipt(acknowledgement.requestKey, "objective.control.ack", payload);
    if (replay) {
      const state = this.controlState(runId);
      if (!state) throw new ObjectiveRuntimeError(`Objective control plan not found: ${runId}.`, "not-found");
      return state;
    }

    const run = this.requireRun(runId);
    this.assertRunPolicy(run, authority);
    const state = this.controlState(runId);
    if (!state) throw new ObjectiveRuntimeError(`Objective control plan not found: ${runId}.`, "not-found");
    // Internal lifecycle operations such as cancelling all suspensions may
    // target a waiting execution that is not the first global frontier item.
    // Keep the override private and scope only intent derivation/reduction;
    // the persisted snapshot still contains every other frontier entry.
    const controlSnapshot = executionOverride
      ? ObjectiveControlPlanSnapshotSchema.parse({ ...state.snapshot, frontier: [executionOverride] })
      : state.snapshot;
    const intent = nextObjectiveControlIntent(state.revision.plan, controlSnapshot, this.now());
    if (intent.intentId !== acknowledgement.intentId) {
      throw new ObjectiveRuntimeError(`Objective control acknowledgement ${acknowledgement.requestKey} is stale.`, "revision-conflict");
    }
    if (acknowledgement.kind !== intent.kind) {
      throw new ObjectiveRuntimeError(`Objective control acknowledgement kind ${acknowledgement.kind} does not match ${intent.kind}.`, "invalid-state");
    }
    if (intent.kind === "agent" && intent.operation === "approval") {
      const approval = this.controlApprovalForIntent(run, intent);
      if (!approval) {
        throw new ObjectiveRuntimeError(
          `Control node ${intent.nodeId} requires a durable approval record before acknowledgement.`,
          "approval-required",
        );
      }
      if (approval.status === "requested") {
        throw new ObjectiveRuntimeError(
          `Control node ${intent.nodeId} is still waiting for approval ${approval.id}.`,
          "approval-required",
        );
      }
      const approved = acknowledgement.approved;
      if (approved === undefined) {
        throw new ObjectiveRuntimeError("Control-node approval acknowledgement requires the resolved approval decision.", "approval-required");
      }
      if (approved !== (approval.status === "approved")) {
        throw new ObjectiveRuntimeError(
          `Control-node approval acknowledgement does not match durable approval ${approval.id} (${approval.status}).`,
          "approval-required",
        );
      }
    }
    if (intent.kind === "complete") {
      if (run.pendingApprovalId !== null) {
        throw new ObjectiveRuntimeError(`Objective control completion is held for pending approval ${run.pendingApprovalId}.`, "approval-required");
      }
      const approvalPolicy = run.policy?.approvalPolicy ?? run.spec.approvalPolicy;
      if (approvalPolicy.mode === "before-completion" && run.state !== "succeeded") {
        throw new ObjectiveRuntimeError("Objective control completion requires before-completion approval.", "approval-required");
      }
    }
    if (intent.kind === "complete") {
      const evidence = acknowledgement.evidence;
      if (!evidence || (evidence.eventCursor <= 0 && evidence.eventIds.length === 0 && !evidence.summary)) {
        throw new ObjectiveRuntimeError("Objective control terminal completion requires durable evidence.", "invalid-state");
      }
    }
    if (intent.kind === "agent" && intent.operation !== "approval" && acknowledgement.state !== "running") {
      const evidence = acknowledgement.evidence;
      if (!evidence || (evidence.eventCursor <= state.snapshot.eventCursor && evidence.eventIds.length === 0 && !evidence.summary)) {
        throw new ObjectiveRuntimeError("Objective control agent terminal acknowledgement requires durable evidence.", "invalid-state");
      }
    }

    const nextSnapshot = applyObjectiveControlAcknowledgement(state.revision.plan, controlSnapshot, acknowledgement);
    const advanced = nextSnapshot.sequence !== state.snapshot.sequence;
    if (advanced) {
      if (!this.repository.saveObjectiveControlSnapshot) {
        throw new ObjectiveRuntimeError("The objective repository cannot persist control snapshots.", "invalid-state");
      }
      const saved = this.repository.saveObjectiveControlSnapshot(nextSnapshot);
      if (!saved) {
        const latest = this.controlState(runId);
        if (!latest || latest.snapshot.sequence < nextSnapshot.sequence) {
          throw new ObjectiveRuntimeError(`Objective control snapshot ${runId}/${nextSnapshot.sequence} could not be committed deterministically.`, "revision-conflict");
        }
      }
    }

    let latestRun = run;
    const rootExecutionId = objectiveControlExecutionId({ nodeId: state.revision.plan.root.id, iterationKey: "root" });
    const rootState = nextSnapshot.nodeStates[rootExecutionId];
    if (intent.kind === "complete") {
      const now = acknowledgement.now ?? this.now();
      latestRun = ObjectiveRunRecordSchema.parse({
        ...run,
        state: "succeeded",
        output: intent.output,
        error: null,
        updatedAt: now,
        finishedAt: now,
      });
      this.repository.saveObjectiveRun(latestRun);
    } else if (rootState === "failed" || rootState === "blocked") {
      const now = acknowledgement.now ?? this.now();
      latestRun = ObjectiveRunRecordSchema.parse({
        ...run,
        state: "failed",
        output: null,
        error: intent.kind === "agent" && acknowledgement.error
          ? acknowledgement.error
          : "Objective control plan reached a failed terminal state.",
        updatedAt: now,
        finishedAt: now,
      });
      this.repository.saveObjectiveRun(latestRun);
    }
    this.saveReceipt({
      requestKey: acknowledgement.requestKey,
      kind: "objective.control.ack",
      fingerprint: fingerprint(payload),
      result: { runId, intentId: acknowledgement.intentId, sequence: nextSnapshot.sequence, state: latestRun.state },
      createdAt: acknowledgement.now ?? this.now(),
    });
    if (this.repository.appendObjectiveEventIntent) {
      const eventKey = `objective-control-ack:${acknowledgement.requestKey}`;
      this.repository.appendObjectiveEventIntent({
        eventKey,
        eventId: `objective-control-event-${fingerprint({ eventKey, runId })}`,
        event: {
          type: "objective.control.acknowledged",
          workflowId: run.workflowId,
          runId,
          agentId: authority.actor.type === "agent" ? authority.actor.id : run.conductorAgentId,
          occurredAt: acknowledgement.now ?? this.now(),
          payload: {
            acknowledgementKey: acknowledgement.requestKey,
            intentId: acknowledgement.intentId,
            kind: acknowledgement.kind,
            sequence: nextSnapshot.sequence,
            ...(acknowledgement.kind === "evaluate"
              ? {
                  evaluation: {
                    actual: acknowledgement.actual ?? acknowledgement.evaluation?.actual ?? null,
                    target: acknowledgement.target ?? acknowledgement.evaluation?.target ?? null,
                    operator: acknowledgement.operator ?? acknowledgement.evaluation?.operator ?? null,
                    pass: acknowledgement.pass ?? acknowledgement.evaluation?.pass ?? false,
                  },
                }
              : {}),
          },
          provenance: { source: "daemon" },
        },
      });
      if (intent.kind === "evaluate") {
        const evaluationEventKey = `objective-control-evaluation:${acknowledgement.requestKey}`;
        this.repository.appendObjectiveEventIntent({
          eventKey: evaluationEventKey,
          eventId: `objective-control-evaluation-event-${fingerprint({ evaluationEventKey, runId })}`,
          event: {
            type: "objective.control.evaluation.completed",
            workflowId: run.workflowId,
            runId,
            agentId: authority.actor.type === "agent" ? authority.actor.id : run.conductorAgentId,
            occurredAt: acknowledgement.now ?? this.now(),
            payload: {
              acknowledgementKey: acknowledgement.requestKey,
              intentId: intent.intentId,
              executionKey: intent.execution,
              metric: intent.metric,
              path: intent.path,
              actual: intent.actual,
              target: intent.target,
              operator: intent.operator,
              pass: intent.pass,
              iterationContext: intent.execution.iterationKey,
              sequence: nextSnapshot.sequence,
              evidence: { eventCursor: nextSnapshot.eventCursor, source: "objective-control-snapshot" },
            },
            provenance: { source: "daemon" },
          },
        });
      }
      if (intent.kind === "signal" && acknowledgement.deliveryId !== undefined) {
        const signalEventKey = `objective-control-signal-delivered:${acknowledgement.requestKey}`;
        this.repository.appendObjectiveEventIntent({
          eventKey: signalEventKey,
          eventId: `objective-control-signal-delivered-event-${fingerprint({ signalEventKey, runId })}`,
          event: {
            type: "objective.control.signal.delivered",
            workflowId: run.workflowId,
            runId,
            agentId: authority.actor.type === "agent" ? authority.actor.id : run.conductorAgentId,
            occurredAt: acknowledgement.now ?? this.now(),
            payload: {
              acknowledgementKey: acknowledgement.requestKey,
              intentId: acknowledgement.intentId,
              executionKey: intent.execution,
              signalKey: acknowledgement.signalKey ?? intent.signalKey,
              subscriptionKey: acknowledgement.subscriptionKey ?? intent.subscriptionKey,
              deliveryId: acknowledgement.deliveryId,
              attemptId: acknowledgement.attemptId ?? intent.attemptId,
              payload: acknowledgement.payload ?? null,
              sequence: nextSnapshot.sequence,
            },
            provenance: { source: "daemon" },
          },
        });
      }
      const suspensionEvent = intent.kind === "timer"
        ? acknowledgement.state === "cancelled"
          ? { type: "objective.control.suspension.cancelled", payload: { executionKey: intent.execution, attemptId: intent.attemptId, kind: "timer" } }
          : intent.operation === "schedule"
          ? { type: "objective.control.timer.scheduled", payload: { executionKey: intent.execution, attemptId: intent.attemptId, dueAt: acknowledgement.dueAt ?? intent.dueAt, expiresAt: acknowledgement.expiresAt ?? intent.expiresAt } }
          : intent.operation === "due"
            ? { type: "objective.control.timer.due", payload: { executionKey: intent.execution, attemptId: intent.attemptId, dueAt: intent.dueAt } }
            : intent.operation === "expire"
              ? { type: "objective.control.timer.expired", payload: { executionKey: intent.execution, attemptId: intent.attemptId, expiresAt: intent.expiresAt } }
                : null
        : intent.kind === "signal"
          ? acknowledgement.deliveryId !== undefined
            ? null
            : acknowledgement.state === "cancelled"
              ? { type: "objective.control.suspension.cancelled", payload: { executionKey: intent.execution, attemptId: intent.attemptId, kind: "signal", signalKey: intent.signalKey, subscriptionKey: intent.subscriptionKey } }
            : intent.operation === "subscribe"
              ? { type: "objective.control.signal.subscribed", payload: { executionKey: intent.execution, attemptId: intent.attemptId, signalKey: intent.signalKey, subscriptionKey: acknowledgement.subscriptionKey ?? intent.subscriptionKey, expiresAt: acknowledgement.expiresAt ?? intent.expiresAt } }
              : intent.operation === "expire"
                ? { type: "objective.control.signal.expired", payload: { executionKey: intent.execution, attemptId: intent.attemptId, signalKey: intent.signalKey, subscriptionKey: intent.subscriptionKey, expiresAt: intent.expiresAt } }
                : null
          : null;
      if (suspensionEvent) {
        const suspensionEventKey = `${suspensionEvent.type}:${acknowledgement.requestKey}`;
        this.repository.appendObjectiveEventIntent({
          eventKey: suspensionEventKey,
          eventId: `objective-control-suspension-event-${fingerprint({ suspensionEventKey, runId })}`,
          event: {
            type: suspensionEvent.type,
            workflowId: run.workflowId,
            runId,
            agentId: authority.actor.type === "agent" ? authority.actor.id : run.conductorAgentId,
            occurredAt: acknowledgement.now ?? this.now(),
            payload: { acknowledgementKey: acknowledgement.requestKey, intentId: acknowledgement.intentId, ...suspensionEvent.payload },
            provenance: { source: "daemon" },
          },
        });
      }
      this.repository.drainObjectiveEventOutbox?.();
    }
    const final = this.controlState(runId);
    if (!final) throw new ObjectiveRuntimeError(`Objective control plan not found after acknowledgement: ${runId}.`, "not-found");
    return final;
  }

  /** Return queued tasks whose dependencies are all durably completed. */
  frontier(runOrId: ObjectiveRunRecord | string): ObjectiveTaskRecord[] {
    const run = typeof runOrId === "string" ? this.requireRun(runOrId) : runOrId;
    const states = new Map(run.tasks.map((record) => [record.task.id, record.state]));
    return run.tasks.filter((record) => {
      if (record.state !== "queued") return false;
      return record.task.dependsOn.every((dependencyId) => {
        const state = states.get(dependencyId);
        return state === "completed" || state === "superseded";
      });
    });
  }

  commitPlan(
    runId: string,
    input: ObjectivePlanCommitInput,
    authority: ObjectiveRuntimeAuthority,
  ): ObjectiveRunRecord {
    return this.withDurableTransaction(() => this.commitPlanAction(runId, input, authority));
  }

  private commitPlanAction(
    runId: string,
    input: ObjectivePlanCommitInput,
    authority: ObjectiveRuntimeAuthority,
  ): ObjectiveRunRecord {
    this.assertAuthority(authority);
    this.assertRequestKey(input.requestKey);
    const run = this.requireRun(runId);
    const tasks = input.tasks.map((task) => ObjectiveTaskSchema.parse(task));
    const payload = {
      runId,
      expectedPlanRevision: input.expectedPlanRevision,
      tasks,
      reason: input.reason ?? null,
      policyHash: input.policyHash ?? null,
    };
    const existingReceipt = this.replayReceipt(input.requestKey, "objective.plan.commit", payload);
    if (existingReceipt) return this.requireRun(runId);
    this.assertRunPolicy(run, authority, input.policyHash);
    const runAuthority = this.authorityWithinRun(run, authority);
    this.assertTaskAuthority(tasks, runAuthority);
    this.assertMutable(run);
    if (run.activePlanRevision !== input.expectedPlanRevision) {
      throw new ObjectiveRuntimeError(
        `Objective plan revision conflict: expected ${input.expectedPlanRevision}, actual ${run.activePlanRevision}.`,
        "revision-conflict",
      );
    }
    const isReplan = run.activePlanRevision > 0 || run.tasks.length > 0;
    if (isReplan && run.replanCount >= run.spec.maxReplans) {
      throw new ObjectiveRuntimeError(`Objective ${run.objectiveId} exhausted its ${run.spec.maxReplans} replan allowance.`, "replan-limit");
    }
    if (tasks.length === 0) throw new ObjectiveRuntimeError("Objective plan commits must append at least one task.", "invalid-plan");
    if (run.tasks.length + tasks.length > MAX_TASKS) throw new ObjectiveRuntimeError(`Objective plans cannot exceed ${MAX_TASKS} tasks.`, "invalid-plan");
    if (run.pendingApprovalId !== null) {
      throw new ObjectiveRuntimeError(`Objective ${run.runId} already has a pending approval.`, "approval-required");
    }
    const combined = [...run.tasks.map((record) => record.task), ...tasks];
    this.assertGraph(combined);

    const now = this.now();
    const nextRevision = run.activePlanRevision + 1;
    // A replan replaces the failed branch in the live projection while the
    // preceding checkpoint keeps the failed/blocked evidence immutable. This
    // lets a retry task settle the objective without pretending the failed
    // attempt completed successfully.
    const replacedFailureBranch = isReplan
      ? run.tasks.map((record) => record.state === "failed" || record.state === "blocked"
        ? { ...record, state: "superseded" as const }
        : record)
      : run.tasks;
    const nextTasks = [
      ...replacedFailureBranch,
      ...tasks.map((task) => this.newTaskRecord(task)),
    ];
    const requiresApproval = run.spec.approvalPolicy.mode === "on-replan" && isReplan
      || tasks.some((task) => task.requiresApproval);
    const next = ObjectiveRunRecordSchema.parse({
      ...run,
      state: requiresApproval ? "awaiting-approval" : "executing",
      activePlanRevision: nextRevision,
      replanCount: isReplan ? run.replanCount + 1 : run.replanCount,
      tasks: nextTasks.map((record) => requiresApproval && tasks.some((task) => task.id === record.task.id)
        ? { ...record, state: "waiting-approval" }
        : record),
      pendingApprovalId: null,
      error: null,
      updatedAt: now,
      startedAt: run.startedAt ?? now,
      finishedAt: null,
    });
    this.repository.saveObjectiveRun(next);
    this.saveReceipt({
      requestKey: input.requestKey,
      kind: "objective.plan.commit",
      fingerprint: fingerprint(payload),
      result: runId,
      createdAt: now,
    });
    if (!requiresApproval) return next;

    const approval = this.requestApprovalInternal(next, {
      kind: "plan",
      taskId: null,
      question: "Approve the next objective plan revision before its new tasks start.",
      scope: { planRevision: nextRevision, reason: input.reason ?? null },
      operationId: `objective-plan:${next.runId}:${nextRevision}`,
      requestHash: fingerprint(payload),
      policyHash: next.policyHash ?? fingerprint(next.spec),
      sideEffectClass: "local",
      canonicalTarget: `${next.workflowId}:${next.objectiveId}:plan:${nextRevision}`,
      expiresAt: null,
      requestKey: `${input.requestKey}:approval`,
    }, authority);
    return this.requireRun(approval.runId);
  }

  checkpoint(
    runId: string,
    input: ObjectiveCheckpointInput,
    authority: ObjectiveRuntimeAuthority,
  ): ObjectiveRunRecord {
    return this.withDurableTransaction(() => this.checkpointAction(runId, input, authority));
  }

  private checkpointAction(
    runId: string,
    input: ObjectiveCheckpointInput,
    authority: ObjectiveRuntimeAuthority,
  ): ObjectiveRunRecord {
    this.assertAuthority(authority);
    this.assertRequestKey(input.requestKey);
    const run = this.requireRun(runId);
    // Checkpoint context is a patch, not a replacement snapshot. Keep the
    // canonical patch in the idempotency payload so replay remains stable
    // even if a later checkpoint has changed the run's accumulated context.
    const contextPatch = input.context ?? {};
    const nextContext = mergeCheckpointContext(run.context, contextPatch);
    const requestedWorkspaceManifest = input.workspaceManifest ?? input.workspaceEvidence?.workspaceManifest ?? null;
    let boundWorkspaceManifest: WorkspaceManifest | null = null;
    if (requestedWorkspaceManifest !== null && requestedWorkspaceManifest !== undefined) {
      try {
        boundWorkspaceManifest = parseWorkspaceManifest(requestedWorkspaceManifest);
      } catch (error) {
        throw new ObjectiveRuntimeError(`Checkpoint workspace manifest is invalid: ${error instanceof Error ? error.message : String(error)}`, "invalid-plan");
      }
    }
    const payload = {
      runId,
      eventCursor: input.eventCursor,
      context: contextPatch,
      taskUpdates: input.taskUpdates ?? [],
      reason: input.reason,
      policyHash: input.policyHash ?? null,
      workspaceManifest: boundWorkspaceManifest,
    };
    const existingReceipt = this.replayReceipt(input.requestKey, "objective.checkpoint.commit", payload);
    if (existingReceipt) return this.requireRun(runId);
    this.assertRunPolicy(run, authority, input.policyHash);
    this.assertMutable(run);
    if (!Number.isInteger(input.eventCursor) || input.eventCursor < 0) throw new ObjectiveRuntimeError("Checkpoint eventCursor must be non-negative.", "invalid-plan");
    const latest = this.latestCheckpoint(run);
    if (run.latestCheckpointId !== null && latest === null) {
      throw new ObjectiveRuntimeError(
        `Objective ${run.runId} references missing checkpoint ${run.latestCheckpointId}.`,
        "invalid-state",
      );
    }
    if (latest && input.eventCursor < latest.eventCursor) {
      throw new ObjectiveRuntimeError(
        `Checkpoint eventCursor ${input.eventCursor} is behind durable cursor ${latest.eventCursor}.`,
        "revision-conflict",
      );
    }
    if (run.pendingApprovalId !== null && (
      (input.taskUpdates?.length ?? 0) > 0
      || stableStringify(nextContext) !== stableStringify(run.context)
    )) {
      throw new ObjectiveRuntimeError(
        `Objective ${run.runId} cannot change task state or context while approval ${run.pendingApprovalId} is pending.`,
        "approval-required",
      );
    }

    const updateMap = new Map<string, ObjectiveTaskUpdate>();
    for (const update of input.taskUpdates ?? []) {
      if (updateMap.has(update.taskId)) throw new ObjectiveRuntimeError(`Checkpoint repeats task ${update.taskId}.`, "invalid-plan");
      updateMap.set(update.taskId, update);
    }
    this.assertTaskUpdates(run.tasks, updateMap);
    const now = this.now();
    let tasks = run.tasks.map((record) => {
      const update = updateMap.get(record.task.id);
      if (!update) return record;
      return ObjectiveTaskRecordSchema.parse({
        ...record,
        state: update.state,
        ...(update.attemptId === undefined ? {} : { attemptId: update.attemptId }),
        ...(update.agentId === undefined ? {} : { agentId: update.agentId }),
        ...(update.output === undefined ? {} : { output: update.output }),
        ...(update.error === undefined ? {} : { error: update.error }),
        ...(update.startedAt === undefined ? {} : { startedAt: update.startedAt }),
        ...(update.finishedAt === undefined ? {} : { finishedAt: update.finishedAt }),
      });
    });
    for (const taskId of updateMap.keys()) if (!run.tasks.some((record) => record.task.id === taskId)) throw new ObjectiveRuntimeError(`Checkpoint references unknown task ${taskId}.`, "invalid-plan");
    tasks = markBlockedTasks(tasks);
    const criteria = evaluateCriteria(run.spec, nextContext, now);
    const allComplete = tasks.length > 0 && tasks.every((record) => record.state === "completed" || record.state === "superseded");
    const requiredCriteriaPass = criteria.filter((result) => isRequiredCriterion(run.spec, result.criterionId)).every((result) => result.passed);
    const hasFailure = tasks.some((record) => record.state === "failed" || record.state === "blocked");
    let state: ObjectiveRunState;
    let error: string | null = null;
    if (run.pendingApprovalId !== null) state = "awaiting-approval";
    else if (allComplete && requiredCriteriaPass) state = run.spec.approvalPolicy.mode === "before-completion" ? "awaiting-approval" : "succeeded";
    else if (hasFailure) {
      state = "failed";
      error = "Objective task failed or was blocked by a failed dependency.";
    } else if (allComplete && run.replanCount < run.spec.maxReplans) state = "replanning";
    else if (allComplete) {
      state = "failed";
      error = "Objective criteria were not satisfied within the replan limit.";
    } else state = "executing";
    const outputs = input.outputs ?? Object.fromEntries(
      tasks
        .filter((record) => record.output !== null)
        .map((record) => [record.task.id, record.output as JsonValue]),
    );
    const controlHead = this.repository.getObjectiveControlHead?.(runId);
    const controlRevision = this.repository.getLatestObjectiveControlPlanRevision?.(runId)
      ?? this.repository.latestObjectiveControlPlanRevision?.(runId)
      ?? null;
    const controlSnapshot = input.treeExecution
      ?? this.repository.getLatestObjectiveControlSnapshot?.(runId)
      ?? this.repository.latestObjectiveControlSnapshot?.(runId)
      ?? null;
    // The daemon-owned supervisor authority may intentionally omit a workspace
    // on internal callbacks. The run's immutable policy snapshot remains the
    // canonical grant for those callbacks; never downgrade the evidence to a
    // null grant merely because the transient authority envelope is narrow.
    const workspaceEvidence = input.workspaceEvidence ?? {
      canonicalGrant: authority.workspace ?? run.policy?.workspace ?? null,
      git: { repo: null, ref: null, commit: null, dirty: null, patchHash: null, worktree: null },
      dirty: null,
      patchHash: null,
      worktree: null,
    };
    const nativeSessions = input.nativeSessions ?? [];
    const continuity = input.continuity ?? {
      status: "unknown" as const,
      capabilities: [],
      reason: "Native session continuity was not proven at checkpoint commit.",
    };
    const eventHighWater = input.eventHighWater ?? input.eventCursor;
    const checkpoint = ObjectiveCheckpointRecordSchema.parse({
      version: 1,
      id: this.id(),
      runId,
      objectiveId: run.objectiveId,
      policyHash: run.policyHash ?? null,
      sequence: (latest?.sequence ?? 0) + 1,
      planRevision: run.activePlanRevision,
      eventCursor: input.eventCursor,
      context: nextContext,
      taskStates: Object.fromEntries(tasks.map((record) => [record.task.id, record.state])),
      criteria,
      contextHash: fingerprint(nextContext),
      reason: input.reason,
      createdBy: authority.actor,
      requestKey: input.requestKey,
      createdAt: now,
      objectiveRevision: input.objectiveRevision ?? run.objectiveRevision ?? 1,
      workflowRevision: input.workflowRevision ?? run.workflowRevision,
      workflowHash: input.workflowHash ?? run.workflowHash,
      controlPlanRevision: input.controlPlanRevision ?? controlHead?.activeRevision ?? controlSnapshot?.planRevision ?? null,
      controlPlanHash: input.controlPlanHash ?? controlRevision?.hash ?? null,
      flatExecution: input.flatExecution ?? { state, context: nextContext, tasks, outputs },
      treeExecution: controlSnapshot,
      outputs,
      attemptHighWater: input.attemptHighWater ?? input.eventCursor,
      eventHighWater,
      artifactHashes: input.artifactHashes ?? [],
      workspaceEvidence,
      ...(boundWorkspaceManifest === null
        ? {}
        : { workspaceManifest: boundWorkspaceManifest }),
      nativeSessions,
      continuity,
      unresolvedExternalOperations: input.unresolvedExternalOperations ?? [],
      ...(input.unresolvedExternalSideEffects === undefined ? {} : { unresolvedExternalSideEffects: input.unresolvedExternalSideEffects }),
      policySnapshotHash: input.policySnapshotHash ?? run.policyHash ?? null,
      configSnapshotHash: input.configSnapshotHash ?? null,
      provenance: input.provenance ?? {
        source: "daemon",
        actor: authority.actor,
        capturedAt: now,
        evidenceEventIds: [],
        parentCheckpointId: latest?.id ?? null,
        baseCheckpointId: latest?.id ?? null,
      },
    });
    let next = ObjectiveRunRecordSchema.parse({
      ...run,
      tasks,
      context: nextContext,
      latestCheckpointId: checkpoint.id,
      state,
      output: state === "succeeded" ? nextContext : run.output,
      error,
      updatedAt: now,
      finishedAt: ["succeeded", "failed"].includes(state) ? now : null,
    });
    const appended = this.repository.appendObjectiveCheckpoint ?? this.repository.saveObjectiveCheckpoint;
    if (!appended) throw new ObjectiveRuntimeError("Objective repository cannot append checkpoints.", "invalid-state");
    appended.call(this.repository, checkpoint);
    this.repository.saveObjectiveRun(next);
    this.saveReceipt({
      requestKey: input.requestKey,
      kind: "objective.checkpoint.commit",
      fingerprint: fingerprint(payload),
      result: checkpoint.id,
      createdAt: now,
    });
    if (state === "awaiting-approval" && run.spec.approvalPolicy.mode === "before-completion" && next.pendingApprovalId === null) {
      const approval = this.requestApprovalInternal(next, {
        kind: "completion",
        taskId: null,
        question: "Approve completion of this objective after its criteria passed.",
        scope: { checkpointId: checkpoint.id },
        operationId: `objective-completion:${next.runId}:${checkpoint.id}`,
        requestHash: fingerprint({ runId: next.runId, checkpointId: checkpoint.id, criteria }),
        policyHash: next.policyHash ?? fingerprint(next.spec),
        sideEffectClass: "local",
        canonicalTarget: `${next.workflowId}:${next.objectiveId}:completion`,
        expiresAt: null,
        requestKey: `${input.requestKey}:completion-approval`,
      }, authority);
      next = this.requireRun(approval.runId);
    }
    return next;
  }

  requestApproval(
    runId: string,
    input: ObjectiveApprovalRequestInput,
    authority: ObjectiveRuntimeAuthority,
  ): ObjectiveRunRecord {
    return this.withDurableTransaction(() => {
      this.assertAuthority(authority);
      this.assertRequestKey(input.requestKey);
      return this.requireRun(this.requestApprovalInternal(this.requireRun(runId), input, authority).runId);
    });
  }

  resolveApproval(
    runId: string,
    approvalId: string,
    input: ObjectiveApprovalResolutionInput,
    authority: ObjectiveRuntimeAuthority,
  ): ObjectiveRunRecord {
    return this.withDurableTransaction(() => this.resolveApprovalAction(runId, approvalId, input, authority));
  }

  private resolveApprovalAction(
    runId: string,
    approvalId: string,
    input: ObjectiveApprovalResolutionInput,
    authority: ObjectiveRuntimeAuthority,
  ): ObjectiveRunRecord {
    this.assertAuthority(authority);
    this.assertRequestKey(input.requestKey);
    const run = this.requireRun(runId);
    const payload = { runId, approvalId, status: input.status, decision: input.decision ?? null };
    const existingReceipt = this.replayReceipt(input.requestKey, "objective.approval.resolve", payload);
    if (existingReceipt) return this.requireRun(runId);
    this.assertRunPolicy(run, authority, undefined, { allowExpired: input.status === "expired" });
    const approval = this.repository.getObjectiveApproval(runId, approvalId);
    if (!approval || approval.runId !== runId) throw new ObjectiveRuntimeError(`Objective approval not found: ${approvalId}.`, "approval-not-found");
    if (run.policy && approval.policyHash !== run.policyHash) {
      throw new ObjectiveRuntimeError(`Objective approval ${approvalId} is bound to a different policy hash.`, "policy-mismatch");
    }
    if (run.pendingApprovalId !== approvalId || approval.status !== "requested") throw new ObjectiveRuntimeError(`Approval ${approvalId} is not pending for objective ${runId}.`, "approval-required");
    const now = this.now();
    const expired = approval.expiresAt !== null && Date.parse(approval.expiresAt) <= Date.parse(now);
    if (expired && input.status !== "expired") {
      throw new ObjectiveRuntimeError(`Objective approval ${approvalId} has expired.`, "approval-required");
    }
    if (!expired && input.status === "expired") {
      throw new ObjectiveRuntimeError(`Objective approval ${approvalId} has not expired.`, "approval-required");
    }
    if (approval.kind === "completion" && !objectiveReady(run) && !this.controlReadyForCompletion(run)) {
      throw new ObjectiveRuntimeError(`Objective ${run.runId} is not ready for completion approval.`, "approval-required");
    }
    const resolved = ObjectiveApprovalRecordSchema.parse({
      ...approval,
      status: input.status,
      decision: input.decision ?? null,
      decidedBy: authority.actor,
      resolvedAt: now,
    });
    this.repository.saveObjectiveApproval(resolved);
    const accepted = input.status === "approved";
    const tasks = run.tasks.map((record) => {
      if (!accepted) return record;
      // Control-node approvals gate the tree reducer, not the legacy flat
      // task projection. Never queue unrelated flat tasks while a control
      // intent is being resumed.
      if (approval.kind === "control") return record;
      if (approval.kind === "task" && record.task.id !== approval.taskId) return record;
      if (approval.kind === "plan" && record.state !== "waiting-approval") return record;
      return { ...record, state: "queued" as const };
    });
    const next = ObjectiveRunRecordSchema.parse({
      ...run,
      tasks,
      pendingApprovalId: null,
      state: accepted ? (approval.kind === "completion" ? "succeeded" : "executing") : "failed",
      output: accepted && approval.kind === "completion" ? run.context : run.output,
      error: accepted ? null : `Approval ${approvalId} was ${input.status}.`,
      updatedAt: now,
      // Approval of a plan/task resumes execution; only completion approval
      // or a non-approved terminal decision finishes the objective.
      finishedAt: accepted ? (approval.kind === "completion" ? now : null) : now,
    });
    this.repository.saveObjectiveRun(next);
    this.saveReceipt({
      requestKey: input.requestKey,
      kind: "objective.approval.resolve",
      fingerprint: fingerprint(payload),
      result: runId,
      createdAt: now,
    });
    return next;
  }

  private requestApprovalInternal(
    run: ObjectiveRunRecord,
    input: ObjectiveApprovalRequestInput,
    authority: ObjectiveRuntimeAuthority,
  ): ObjectiveApprovalRecord {
    this.assertRunPolicy(run, authority, input.policyHash);
    const policy = run.policy;
    if (policy && sideEffectRank(input.sideEffectClass) > sideEffectRank(policy.sideEffectClassCeiling)) {
      throw new ObjectiveRuntimeError(`Approval ${input.operationId} exceeds the objective side-effect ceiling.`, "authority-exceeded");
    }
    if (input.capability && policy && !policy.allowedCapabilities.includes(input.capability)) {
      throw new ObjectiveRuntimeError(`Approval ${input.operationId} requests unavailable capability ${input.capability}.`, "authority-exceeded");
    }
    // Approval timeout is part of the immutable objective admission policy.
    // Resolve it once, at request time, and carry the resulting timestamp on
    // the durable approval identity. An explicit caller expiry can narrow the
    // policy timeout, never widen it.
    const now = this.now();
    const policyApprovalExpiry = policy?.approvalPolicy.timeoutSeconds === undefined
      ? null
      : new Date(Date.parse(now) + policy.approvalPolicy.timeoutSeconds * 1_000).toISOString();
    const effectiveExpiry = earliestExpiry(input.expiresAt ?? null, policyApprovalExpiry);
    if (policy?.expiresAt !== null && policy?.expiresAt !== undefined) {
      const requestedExpiry = effectiveExpiry;
      if (requestedExpiry === null || Date.parse(requestedExpiry) > Date.parse(policy.expiresAt)) {
        throw new ObjectiveRuntimeError(`Approval ${input.operationId} must expire no later than the objective policy.`, "authority-exceeded");
      }
    }
    if (effectiveExpiry !== null && Date.parse(effectiveExpiry) <= Date.parse(now)) {
      throw new ObjectiveRuntimeError(`Approval ${input.operationId} has already expired.`, "policy-expired");
    }
    const taskId = input.taskId ?? null;
    if (input.kind === "task" && taskId === null) throw new ObjectiveRuntimeError("Task approvals require a task id.", "invalid-plan");
    if (input.kind !== "task" && taskId !== null) throw new ObjectiveRuntimeError("Only task approvals may identify a task.", "invalid-plan");
    if (taskId !== null && !run.tasks.some((record) => record.task.id === taskId)) throw new ObjectiveRuntimeError(`Approval references unknown task ${taskId}.`, "invalid-plan");
    if (input.kind === "task") {
      const task = run.tasks.find((record) => record.task.id === taskId);
      if (!task || task.state !== "queued") {
        throw new ObjectiveRuntimeError(`Task approval ${taskId} requires a queued task.`, "invalid-state");
      }
    }
    if (input.kind === "control" && !isControlApprovalScope(input.scope ?? {})) {
      throw new ObjectiveRuntimeError(
        "Control-node approvals must bind a control intent, execution key, node, and attempt.",
        "invalid-plan",
      );
    }
    if (input.kind === "completion" && !objectiveReady(run) && !this.controlReadyForCompletion(run)) {
      throw new ObjectiveRuntimeError(`Objective ${run.runId} is not ready for completion approval.`, "approval-required");
    }
    const payload = {
      runId: run.runId,
      kind: input.kind,
      taskId,
      question: input.question,
      scope: input.scope ?? {},
      operationId: input.operationId,
      requestHash: input.requestHash,
      policyHash: input.policyHash,
      sideEffectClass: input.sideEffectClass,
      canonicalTarget: input.canonicalTarget,
      capability: input.capability ?? null,
      expiresAt: effectiveExpiry,
    };
    // A timeout-derived expiry naturally changes with the wall clock. On a
    // retry, however, the original request receipt is authoritative and must
    // be fingerprinted using the originally persisted expiry.
    const existingRequestReceipt = this.repository.getObjectiveActionReceipt(input.requestKey);
    if (existingRequestReceipt?.kind === "objective.approval.request") {
      const existingApproval = this.requireApproval(run.runId, asString(existingRequestReceipt.result, "objective.approval.request result"));
      const replayPayload = { ...payload, expiresAt: existingApproval.expiresAt };
      const replayed = this.replayReceipt(input.requestKey, "objective.approval.request", replayPayload);
      if (replayed) return existingApproval;
    }
    const existingReceipt = this.replayReceipt(input.requestKey, "objective.approval.request", payload);
    if (existingReceipt) return this.requireApproval(run.runId, asString(existingReceipt.result, "objective.approval.request result"));
    this.assertMutable(run);
    if (run.pendingApprovalId !== null) throw new ObjectiveRuntimeError(`Objective ${run.runId} already has a pending approval.`, "approval-required");
    const approval = ObjectiveApprovalRecordSchema.parse({
      version: 1,
      id: this.id(),
      runId: run.runId,
      objectiveId: run.objectiveId,
      planRevision: run.activePlanRevision,
      kind: input.kind,
      taskId,
      question: input.question,
      scope: input.scope ?? {},
      operationId: input.operationId,
      requestHash: input.requestHash,
      policyHash: input.policyHash,
      sideEffectClass: input.sideEffectClass,
      canonicalTarget: input.canonicalTarget,
      capability: input.capability ?? null,
      expiresAt: effectiveExpiry,
      requestedBy: authority.actor,
      status: "requested",
      decision: null,
      decidedBy: null,
      requestedAt: now,
      resolvedAt: null,
      requestKey: input.requestKey,
    });
    this.repository.saveObjectiveApproval(approval);
    const tasks = run.tasks.map((record) => approval.kind === "task" && record.task.id === taskId
      ? { ...record, state: "waiting-approval" as const }
      : approval.kind === "plan" && record.state === "queued"
        ? { ...record, state: "waiting-approval" as const }
        : record);
    this.repository.saveObjectiveRun(ObjectiveRunRecordSchema.parse({
      ...run,
      tasks,
      state: "awaiting-approval",
      pendingApprovalId: approval.id,
      updatedAt: now,
    }));
    this.saveReceipt({
      requestKey: input.requestKey,
      kind: "objective.approval.request",
      fingerprint: fingerprint(payload),
      result: approval.id,
      createdAt: now,
    });
    return approval;
  }

  private assertAuthority(authority: ObjectiveRuntimeAuthority): void {
    try {
      ObjectiveActorSchema.parse(authority.actor);
      PermissionSchema.parse(authority.permissionCeiling);
      if (authority.policy !== undefined && authority.policy !== null) ObjectivePolicyRequestSchema.parse(authority.policy);
      if (authority.allowedCapabilities !== undefined) {
        if (!authority.allowedCapabilities.every((capability) => typeof capability === "string" && capability.length > 0)) {
          throw new Error("invalid capability");
        }
      }
    } catch {
      throw new ObjectiveRuntimeError("Objective runtime actions require an externally supplied authority envelope.", "invalid-authority");
    }
  }

  /** Validate the immutable admission envelope before every policy-backed action. */
  private assertRunPolicy(
    run: ObjectiveRunRecord,
    authority: ObjectiveRuntimeAuthority,
    suppliedHash?: string,
    options: { allowExpired?: boolean } = {},
  ): void {
    if (!run.policy) {
      // Legacy rows intentionally retain their missing policy. They may be
      // replayed and inspected, but storage budget operations remain
      // unavailable; there is no fabricated hash to validate here.
      return;
    }
    const policy = ObjectivePolicySnapshotSchema.safeParse(run.policy);
    if (!policy.success || run.policyHash !== policy.data.policyHash || !isObjectivePolicyHashValid(policy.data)) {
      throw new ObjectiveRuntimeError(`Objective ${run.runId} has an invalid immutable policy snapshot.`, "policy-mismatch");
    }
    if (suppliedHash !== undefined && suppliedHash !== policy.data.policyHash) {
      throw new ObjectiveRuntimeError(`Objective ${run.runId} policy hash does not match its admission snapshot.`, "policy-mismatch");
    }
    const now = this.now();
    if (!options.allowExpired && policy.data.expiresAt !== null && Date.parse(policy.data.expiresAt) <= Date.parse(now)) {
      throw new ObjectiveRuntimeError(`Objective ${run.runId} admission policy has expired.`, "policy-expired");
    }
    if (permissionRank(authority.permissionCeiling) > permissionRank(policy.data.effectivePermission)) {
      throw new ObjectiveRuntimeError(`Objective ${run.runId} action exceeds its immutable permission ceiling.`, "authority-exceeded");
    }
    const authorityCapabilities = authority.allowedCapabilities ?? authority.policy?.allowedCapabilities;
    if (authorityCapabilities && authorityCapabilities.some((capability) => !policy.data.allowedCapabilities.includes(capability))) {
      throw new ObjectiveRuntimeError(`Objective ${run.runId} action requests a capability outside its immutable policy.`, "authority-exceeded");
    }
    if (authority.policy?.sideEffectClassCeiling && sideEffectRank(authority.policy.sideEffectClassCeiling) > sideEffectRank(policy.data.sideEffectClassCeiling)) {
      throw new ObjectiveRuntimeError(`Objective ${run.runId} action exceeds its immutable side-effect ceiling.`, "authority-exceeded");
    }
    if (authority.workspace) {
      if (!policy.data.workspace) {
        throw new ObjectiveRuntimeError(`Objective ${run.runId} has no workspace grant.`, "authority-exceeded");
      }
      try {
        childWorkspaceGrant(policy.data.workspace, authority.workspace, policy.data.workspace.path);
      } catch (error) {
        const detail = error instanceof WorkspaceContainmentError ? error.message : String(error);
        throw new ObjectiveRuntimeError(`Objective ${run.runId} action is outside its workspace grant: ${detail}`, "authority-exceeded");
      }
    }
  }

  private authorityWithinPolicy(
    policy: ObjectivePolicySnapshot,
    authority: ObjectiveRuntimeAuthority,
  ): ObjectiveRuntimeAuthority {
    const allowed = (authority.allowedCapabilities ?? policy.allowedCapabilities)
      .filter((capability) => policy.allowedCapabilities.includes(capability));
    return {
      ...authority,
      permissionCeiling: resolveChildPermission(authority.permissionCeiling, policy.effectivePermission),
      allowedCapabilities: allowed,
      workspace: authority.workspace ?? policy.workspace,
      policy: policyRequestFromSnapshot(policy),
    };
  }

  private controlReadyForCompletion(run: ObjectiveRunRecord): boolean {
    const state = this.controlState(run.runId);
    if (!state) return false;
    const rootId = objectiveControlExecutionId({ nodeId: state.revision.plan.root.id, iterationKey: "root" });
    return state.snapshot.nodeStates[rootId] === "completed";
  }

  /**
   * Resolve the approval created for one reducer intent. The request receipt
   * is the durable lookup after resolution clears run.pendingApprovalId; the
   * scope fence prevents a caller from reusing an approval for another
   * execution, intent, or attempt.
   */
  private controlApprovalForIntent(
    run: ObjectiveRunRecord,
    intent: ObjectiveControlAgentIntent,
  ): ObjectiveApprovalRecord | null {
    let approval = run.pendingApprovalId
      ? this.repository.getObjectiveApproval(run.runId, run.pendingApprovalId)
      : null;
    if (!approval || approval.kind !== "control" || !controlApprovalScopeMatches(approval, intent, run)) {
      const receipt = this.repository.getObjectiveActionReceipt(objectiveControlApprovalRequestKey(intent.intentId));
      const approvalId = receipt?.kind === "objective.approval.request" && typeof receipt.result === "string"
        ? receipt.result
        : null;
      approval = approvalId ? this.repository.getObjectiveApproval(run.runId, approvalId) : null;
    }
    if (!approval || approval.kind !== "control" || !controlApprovalScopeMatches(approval, intent, run)) return null;
    return approval;
  }

  private authorityWithinRun(run: ObjectiveRunRecord, authority: ObjectiveRuntimeAuthority): ObjectiveRuntimeAuthority {
    return run.policy ? this.authorityWithinPolicy(run.policy, authority) : authority;
  }

  private withDurableTransaction<T>(callback: () => T): T {
    return this.repository.withDurableTransaction
      ? this.repository.withDurableTransaction(callback)
      : callback();
  }

  private assertTaskAuthority(tasks: readonly ObjectiveTask[], authority: ObjectiveRuntimeAuthority): void {
    for (const task of tasks) {
      if (task.permissions === "full-access" && resolveChildPermission(authority.permissionCeiling, task.permissions) !== "full-access") {
        throw new ObjectiveRuntimeError(`Task ${task.id} requests authority above the supplied ceiling.`, "authority-exceeded");
      }
      if (authority.workspace && task.workspace) {
        try {
          // The daemon performs this check before entering the runtime. Keep
          // the same realpath-aware check here as a second fence for callers
          // that use ObjectiveRuntime directly or race a later replan.
          childWorkspaceGrant(authority.workspace, task.workspace, authority.workspace.path);
        } catch (error) {
          const detail = error instanceof WorkspaceContainmentError ? error.message : String(error);
          throw new ObjectiveRuntimeError(`Task ${task.id} requests a workspace outside the supplied grant: ${detail}`, "authority-exceeded");
        }
      }
      if (task.capabilities?.length) {
        const available = new Set(authority.allowedCapabilities ?? []);
        for (const capability of task.capabilities) {
          if (!available.has(capability)) {
            throw new ObjectiveRuntimeError(`Task ${task.id} requests unavailable capability ${capability}.`, "authority-exceeded");
          }
        }
      }
    }
  }

  /**
   * Control plans are an alternate task admission surface. Validate every
   * nested agent node before pinning revision zero so a tree cannot smuggle a
   * broader permission, capability, or workspace than the objective caller
   * was granted. This mirrors flat-task admission; the reducer remains
   * responsible for dependency/concurrency/approval semantics.
   */
  private assertControlPlanAuthority(plan: ObjectiveControlPlan, authority: ObjectiveRuntimeAuthority): void {
    const visit = (node: ObjectiveControlPlan["root"]): void => {
      if (node.type === "agent") {
        if (node.permissions === "full-access" && resolveChildPermission(authority.permissionCeiling, node.permissions) !== "full-access") {
          throw new ObjectiveRuntimeError(`Control node ${node.id} requests authority above the supplied ceiling.`, "authority-exceeded");
        }
        if (authority.workspace && node.workspace) {
          try {
            childWorkspaceGrant(authority.workspace, WorkspaceSpecSchema.parse(node.workspace), authority.workspace.path);
          } catch (error) {
            const detail = error instanceof WorkspaceContainmentError ? error.message : String(error);
            throw new ObjectiveRuntimeError(`Control node ${node.id} requests a workspace outside the supplied grant: ${detail}`, "authority-exceeded");
          }
        }
        if (node.capabilities?.length) {
          const available = new Set(authority.allowedCapabilities ?? []);
          for (const capability of node.capabilities) {
            if (!available.has(capability)) {
              throw new ObjectiveRuntimeError(`Control node ${node.id} requests unavailable capability ${capability}.`, "authority-exceeded");
            }
          }
        }
        return;
      }
      if (node.type === "sequence" || node.type === "parallel" || node.type === "while") {
        node.steps.forEach(visit);
      } else if (node.type === "if") {
        node.then.forEach(visit);
        node.else?.forEach(visit);
      }
    };
    visit(plan.root);
  }

  private assertTaskUpdates(
    records: readonly ObjectiveTaskRecord[],
    updates: ReadonlyMap<string, ObjectiveTaskUpdate>,
  ): void {
    const current = new Map(records.map((record) => [record.task.id, record.state]));
    for (const [taskId, update] of updates) {
      const record = records.find((candidate) => candidate.task.id === taskId);
      if (!record) throw new ObjectiveRuntimeError(`Checkpoint references unknown task ${taskId}.`, "invalid-plan");
      const previous = record.state;
      if (!isAllowedTaskTransition(previous, update.state)) {
        throw new ObjectiveRuntimeError(`Objective task ${taskId} cannot transition from ${previous} to ${update.state}.`, "invalid-state");
      }
      current.set(taskId, update.state);
    }
    for (const [taskId, update] of updates) {
      if (!["running", "completed", "failed"].includes(update.state)) continue;
      const record = records.find((candidate) => candidate.task.id === taskId);
      if (!record || record.task.dependsOn.some((dependencyId) => {
        const dependencyState = current.get(dependencyId);
        return dependencyState !== "completed" && dependencyState !== "superseded";
      })) {
        throw new ObjectiveRuntimeError(`Objective task ${taskId} is not runnable because a dependency is incomplete.`, "invalid-state");
      }
    }
  }

  private assertMutable(run: ObjectiveRunRecord): void {
    // A failed task is a recoverable execution outcome while the objective
    // still has replan allowance. The supervisor can append a bounded retry
    // plan through commitPlan; terminal failures (or exhausted replans) stay
    // immutable.
    if (["succeeded", "cancelled", "interrupted"].includes(run.state)
      || (run.state === "failed" && run.replanCount >= run.spec.maxReplans)) {
      throw new ObjectiveRuntimeError(`Objective ${run.runId} is already ${run.state}.`, "invalid-state");
    }
  }

  private assertGraph(tasks: readonly ObjectiveTask[]): void {
    if (tasks.length > MAX_TASKS) throw new ObjectiveRuntimeError(`Objective plans cannot exceed ${MAX_TASKS} tasks.`, "invalid-plan");
    const ids = new Set<string>();
    for (const task of tasks) {
      if (ids.has(task.id)) throw new ObjectiveRuntimeError(`Objective task id ${task.id} is duplicated.`, "invalid-plan");
      ids.add(task.id);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new ObjectiveRuntimeError(`Objective plan contains a dependency cycle at ${id}.`, "invalid-plan");
      if (visited.has(id)) return;
      const task = byId.get(id);
      if (!task) throw new ObjectiveRuntimeError(`Objective task dependency ${id} does not exist.`, "invalid-plan");
      visiting.add(id);
      for (const dependencyId of task.dependsOn) visit(dependencyId);
      visiting.delete(id);
      visited.add(id);
    };
    for (const task of tasks) visit(task.id);
  }

  private newTaskRecord(task: ObjectiveTask): ObjectiveTaskRecord {
    return {
      task,
      state: "queued",
      attemptId: null,
      agentId: null,
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    };
  }

  private admitControlPlan(
    run: ObjectiveRunRecord,
    plan: ObjectiveControlPlan,
    authority: ObjectiveRuntimeAuthority,
  ): void {
    if (!this.repository.saveObjectiveControlPlanRevision) {
      throw new ObjectiveRuntimeError("The objective repository cannot admit control plans.", "invalid-state");
    }
    if (plan.source.kind === "workflow-revision" && (
      plan.source.workflowId !== run.workflowId
      || plan.source.workflowRevision !== run.workflowRevision
      || plan.source.workflowHash !== run.workflowHash
    )) {
      throw new ObjectiveRuntimeError("Control plan source does not match the workflow revision pinned to the objective.", "invalid-plan");
    }
    if (plan.source.kind === "conductor-authored" && (
      run.conductorAgentId === null || plan.source.authorAgentId !== run.conductorAgentId
    )) {
      throw new ObjectiveRuntimeError("Conductor-authored control plans must be authored by the attached objective conductor.", "authority-exceeded");
    }
    // Apply the same immutable policy envelope used by flat-task admission.
    // The source/author check above is not sufficient: a caller must not use
    // a valid workflow revision as a wrapper for broader node authority.
    this.assertControlPlanAuthority(plan, run.policy ? this.authorityWithinPolicy(run.policy, authority) : authority);
    const revision = pinObjectiveControlPlan(plan, {
      objectiveId: run.objectiveId,
      runId: run.runId,
      createdBy: authority.actor,
      requestKey: `${run.requestKey}:control-plan:0`,
      createdAt: run.createdAt,
      valueCharter: run.spec.valueCharter ?? null,
    });
    const snapshot = createObjectiveControlSnapshot(plan, {
      objectiveId: run.objectiveId,
      runId: run.runId,
      planRevision: 0,
      eventCursor: 0,
      sequence: 1,
      context: run.context,
      createdAt: run.createdAt,
    });
    const saved = this.repository.saveObjectiveControlPlanRevision(revision, snapshot);
    if (saved) return;
    const current = this.controlState(run.runId);
    if (!current || current.revision.hash !== revision.hash || current.snapshot.sequence !== snapshot.sequence) {
      throw new ObjectiveRuntimeError("Control plan admission lost its idempotency race.", "idempotency-conflict");
    }
  }

  private assertControlPlanCharterBinding(
    run: ObjectiveRunRecord,
    revision: ObjectiveControlPlanRevision,
  ): void {
    const binding = objectiveValueCharterBindingForSpec(run.spec);
    const revisionNumber = revision.valueCharterRevision ?? revision.plan.valueCharterRevision;
    const revisionHash = revision.valueCharterHash ?? revision.plan.valueCharterHash;
    if (!binding) {
      if (revisionNumber !== undefined || revisionHash !== undefined) {
        throw new ObjectiveRuntimeError("Objective control plan carries a charter binding but the objective has no charter.", "invalid-state");
      }
      return;
    }
    if (revisionNumber !== binding.revision || revisionHash !== binding.hash) {
      throw new ObjectiveRuntimeError("Objective control plan charter binding does not match the admitted objective charter.", "invalid-state");
    }
  }

  private latestCheckpoint(run: ObjectiveRunRecord): ObjectiveCheckpointRecord | null {
    return run.latestCheckpointId
      ? this.repository.getObjectiveCheckpoint(run.runId, run.latestCheckpointId)
      : null;
  }

  private replayReceipt(requestKey: string, kind: ObjectiveActionKind, payload: unknown): ObjectiveActionReceipt | null {
    const receipt = this.repository.getObjectiveActionReceipt(requestKey);
    if (!receipt) return null;
    if (receipt.kind !== kind || receipt.fingerprint !== fingerprint(payload)) throw new ObjectiveRuntimeError(`Request ${requestKey} was already used for a different action.`, "idempotency-conflict");
    return receipt;
  }

  private saveReceipt(receipt: ObjectiveActionReceipt): void {
    if (this.repository.saveObjectiveActionReceipt(receipt)) return;
    const existing = this.repository.getObjectiveActionReceipt(receipt.requestKey);
    if (!existing || existing.kind !== receipt.kind || existing.fingerprint !== receipt.fingerprint) throw new ObjectiveRuntimeError(`Request ${receipt.requestKey} could not be committed deterministically.`, "idempotency-conflict");
  }

  private requireRun(runId: string): ObjectiveRunRecord {
    const run = this.repository.getObjectiveRun(runId);
    if (!run) throw new ObjectiveRuntimeError(`Objective run not found: ${runId}.`, "not-found");
    return run;
  }

  private requireApproval(runId: string, approvalId: string): ObjectiveApprovalRecord {
    const approval = this.repository.getObjectiveApproval(runId, approvalId);
    if (!approval) throw new ObjectiveRuntimeError(`Objective approval not found: ${approvalId}.`, "approval-not-found");
    return approval;
  }

  private assertRequestKey(requestKey: string): void {
    if (typeof requestKey !== "string" || requestKey.length < 8) throw new ObjectiveRuntimeError("Objective action requestKey must contain at least 8 characters.", "idempotency-conflict");
  }
}

/** Stable request identity for a control-node approval across restarts. */
export function objectiveControlApprovalRequestKey(intentId: string): string {
  return `objective-control-approval:${intentId}`;
}

function controlApprovalScopeMatches(
  approval: ObjectiveApprovalRecord,
  intent: ObjectiveControlAgentIntent,
  run: ObjectiveRunRecord,
): boolean {
  if (approval.planRevision !== run.activePlanRevision) return false;
  const scope = approval.scope;
  if (!isControlApprovalScope(scope)) return false;
  if (scope.controlIntentId !== intent.intentId || scope.controlNodeId !== intent.nodeId || scope.controlAttemptId !== intent.attemptId) return false;
  const execution = scope.controlExecutionKey;
  return execution.nodeId === intent.execution.nodeId
    && execution.iterationKey === intent.execution.iterationKey;
}

function isControlApprovalScope(scope: Readonly<Record<string, JsonValue>>): scope is Readonly<Record<string, JsonValue>> & {
  controlIntentId: string;
  controlNodeId: string;
  controlAttemptId: string;
  controlExecutionKey: { nodeId: string; iterationKey: string };
} {
  const execution = scope.controlExecutionKey;
  return typeof scope.controlIntentId === "string"
    && typeof scope.controlNodeId === "string"
    && typeof scope.controlAttemptId === "string"
    && typeof execution === "object"
    && execution !== null
    && !Array.isArray(execution)
    && typeof execution.nodeId === "string"
    && typeof execution.iterationKey === "string";
}

export function evaluateObjectiveCriteria(
  spec: ObjectiveSpec,
  context: Readonly<Record<string, JsonValue>>,
  evaluatedAt = new Date().toISOString(),
): ObjectiveCriterionResult[] {
  return evaluateCriteria(spec, context, evaluatedAt);
}

export type ObjectivePolicyAdmissionInput = Readonly<{
  runId: string;
  objectiveId: string;
  workflowId: string;
  workflowRevision: number;
  workflowHash: string;
  actor: ObjectiveActor;
  workspace: WorkspaceSpec | null;
  spec: ObjectiveSpec;
  requestedPolicy?: ObjectivePolicyRequest | null;
  authority: ObjectiveRuntimeAuthority;
  globalCeiling?: ObjectivePolicyRequest | null;
  createdAt: string;
}>;

/**
 * Derive the immutable policy captured at admission. Every dimension is an
 * intersection of the request, authenticated authority, and global ceiling;
 * null budget limits mean unlimited only when every applicable ceiling is
 * also null.
 */
export function deriveObjectivePolicySnapshot(input: ObjectivePolicyAdmissionInput): ObjectivePolicySnapshot {
  const requested = ObjectivePolicyRequestSchema.parse(input.requestedPolicy ?? {});
  const authorityPolicy = ObjectivePolicyRequestSchema.parse(input.authority.policy ?? {});
  const global = ObjectivePolicyRequestSchema.parse(input.globalCeiling ?? {});
  const permission = intersectPermission(
    input.authority.permissionCeiling,
    requested.effectivePermission,
    authorityPolicy.effectivePermission,
    global.effectivePermission,
  );
  const allowedCapabilities = intersectCapabilities(
    input.authority.allowedCapabilities ?? authorityPolicy.allowedCapabilities ?? [],
    requested.allowedCapabilities,
    global.allowedCapabilities,
  );
  const budget = intersectBudgetLimits(
    requested.budget,
    authorityPolicy.budget,
    global.budget,
  );
  const sideEffectClassCeiling = minSideEffectClass(
    permission === "read-only" ? "read" : "local",
    requested.sideEffectClassCeiling,
    authorityPolicy.sideEffectClassCeiling,
    global.sideEffectClassCeiling,
  );
  const approvalPolicy = intersectApprovalPolicy(
    input.spec.approvalPolicy,
    requested.approvalPolicy,
    authorityPolicy.approvalPolicy,
    global.approvalPolicy,
  );
  const expiresAt = earliestExpiry(requested.expiresAt, authorityPolicy.expiresAt, global.expiresAt);
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(input.createdAt)) {
    throw new ObjectiveRuntimeError("Objective admission policy is already expired.", "policy-expired");
  }
  const snapshotWithoutHash = {
    version: 1 as const,
    policyVersion: 1,
    policyHash: "pending",
    runId: input.runId,
    objectiveId: input.objectiveId,
    workflowId: input.workflowId,
    workflowRevision: input.workflowRevision,
    workflowHash: input.workflowHash,
    actor: input.actor,
    effectivePermission: permission,
    allowedCapabilities,
    workspace: input.workspace,
    budget,
    sideEffectClassCeiling,
    approvalPolicy,
    expiresAt,
    createdAt: input.createdAt,
  } satisfies ObjectivePolicySnapshot;
  const policyHash = objectivePolicyHash(snapshotWithoutHash);
  return ObjectivePolicySnapshotSchema.parse({ ...snapshotWithoutHash, policyHash });
}

/** SHA-256 over canonical policy content with the hash field excluded. */
// Keep the historical workflow import path as a compatibility re-export while
// protocol owns the canonical implementation used by every durable boundary.
export { objectivePolicyHash };

function policyRequestFromSnapshot(policy: ObjectivePolicySnapshot): ObjectivePolicyRequest {
  return {
    effectivePermission: policy.effectivePermission,
    allowedCapabilities: policy.allowedCapabilities,
    budget: policy.budget,
    sideEffectClassCeiling: policy.sideEffectClassCeiling,
    approvalPolicy: policy.approvalPolicy,
    expiresAt: policy.expiresAt,
  };
}

function permissionRank(permission: Permission): number {
  return permission === "full-access" ? 1 : 0;
}

function intersectPermission(...values: Array<Permission | undefined>): Permission {
  return values.some((value) => value === "read-only") ? "read-only" : "full-access";
}

function sideEffectRank(value: ObjectiveSideEffectClass): number {
  return { read: 0, local: 1, external: 2, irreversible: 3 }[value];
}

function minSideEffectClass(...values: Array<ObjectiveSideEffectClass | undefined>): ObjectiveSideEffectClass {
  const present = values.filter((value): value is ObjectiveSideEffectClass => value !== undefined);
  return present.sort((left, right) => sideEffectRank(left) - sideEffectRank(right))[0] ?? "local";
}

function intersectCapabilities(
  caller: readonly string[],
  requested?: readonly string[],
  global?: readonly string[],
): string[] {
  const requestedSet = requested === undefined ? null : new Set(requested);
  const globalSet = global === undefined ? null : new Set(global);
  return [...new Set(caller)].filter((capability) =>
    (requestedSet === null || requestedSet.has(capability))
    && (globalSet === null || globalSet.has(capability)),
  ).sort((left, right) => left.localeCompare(right));
}

function intersectBudgetLimits(...limits: Array<ObjectiveBudgetLimits | undefined>): ObjectiveBudgetLimits {
  const parsed = limits.map((limit) => ObjectiveBudgetLimitsSchema.parse(limit ?? {}));
  const keys: Array<keyof ObjectiveBudgetLimits> = [
    "maxCostUsd", "maxInputTokens", "maxOutputTokens", "maxTotalTokens",
    "maxModelCalls", "maxToolCalls", "maxWallTimeSeconds", "maxOutputBytes",
    "maxStorageBytes", "maxLoopIterations", "maxConcurrentAgents", "maxDepth",
  ];
  return ObjectiveBudgetLimitsSchema.parse(Object.fromEntries(keys.map((key) => [
    key,
    parsed.map((limit) => limit[key]).reduce<number | null>((current, value) =>
      current === null || value === null ? (current === null ? value : current) : Math.min(current, value), null),
  ])));
}

function approvalRank(mode: ObjectiveApprovalPolicy["mode"]): number {
  return { never: 0, "on-replan": 1, "before-completion": 2 }[mode];
}

function intersectApprovalPolicy(...policies: Array<ObjectiveApprovalPolicy | undefined>): ObjectiveApprovalPolicy {
  const present = policies.filter((policy): policy is ObjectiveApprovalPolicy => policy !== undefined);
  const mode = present.sort((left, right) => approvalRank(right.mode) - approvalRank(left.mode))[0]?.mode ?? "never";
  const timeoutValues = present.map((policy) => policy.timeoutSeconds).filter((value): value is number => value !== undefined);
  return {
    mode,
    ...(timeoutValues.length > 0 ? { timeoutSeconds: Math.min(...timeoutValues) } : {}),
  };
}

function earliestExpiry(...values: Array<string | null | undefined>): string | null {
  const present = values.filter((value): value is string => value !== undefined && value !== null);
  if (!present.length) return null;
  return present.sort((left, right) => Date.parse(left) - Date.parse(right))[0] as string;
}

function objectiveReady(run: ObjectiveRunRecord): boolean {
  if (run.tasks.length === 0 || !run.tasks.every((record) => record.state === "completed" || record.state === "superseded")) {
    return false;
  }
  return evaluateCriteria(run.spec, run.context, run.updatedAt)
    .filter((result) => isRequiredCriterion(run.spec, result.criterionId))
    .every((result) => result.passed);
}

function evaluateCriteria(spec: ObjectiveSpec, context: Readonly<Record<string, JsonValue>>, evaluatedAt: string): ObjectiveCriterionResult[] {
  return spec.criteria.map((criterion) => {
    const actual = getPath(context, criterion.path);
    const expected = criterion.op === "exists" ? true : criterion.value ?? criterion.default ?? null;
    return {
      criterionId: criterion.id,
      passed: evaluateCriterion(criterion, actual),
      actual: actual ?? null,
      expected,
      evidenceEventIds: [],
      evaluatedAt,
    };
  });
}

function isRequiredCriterion(spec: ObjectiveSpec, criterionId: string): boolean {
  return spec.criteria.find((criterion) => criterion.id === criterionId)?.required ?? true;
}

function evaluateCriterion(criterion: ObjectiveCriterion, actual: JsonValue | undefined): boolean {
  if (criterion.op === "exists") return actual !== undefined && actual !== null;
  const expected = criterion.value ?? criterion.default ?? null;
  if (criterion.op === "equals") return stableStringify(actual) === stableStringify(expected);
  if (criterion.op === "not-equals") return stableStringify(actual) !== stableStringify(expected);
  if (criterion.op === "contains") {
    if (typeof actual === "string" && typeof expected === "string") return actual.includes(expected);
    if (Array.isArray(actual)) return actual.some((item) => stableStringify(item) === stableStringify(expected));
    return false;
  }
  if (criterion.op === "matches") {
    if (typeof actual !== "string" || typeof expected !== "string") return false;
    try {
      return new RegExp(expected, "u").test(actual);
    } catch {
      return false;
    }
  }
  if (typeof actual !== "number" || typeof expected !== "number") return false;
  if (criterion.op === "gt") return actual > expected;
  if (criterion.op === "gte") return actual >= expected;
  if (criterion.op === "lt") return actual < expected;
  return actual <= expected;
}

function markBlockedTasks(tasks: ObjectiveTaskRecord[]): ObjectiveTaskRecord[] {
  // A failed task can block a chain of descendants. Re-run the bounded pass
  // until the flat DAG reaches a fixed point; the protocol caps the graph at
  // 128 nodes, so this cannot become an unbounded workflow loop.
  let current = tasks;
  for (let pass = 0; pass < tasks.length; pass += 1) {
    const stateById = new Map(current.map((record) => [record.task.id, record.state]));
    let changed = false;
    current = current.map((record) => {
      if (record.state !== "queued" || !record.task.dependsOn.some((dependencyId) => {
        const state = stateById.get(dependencyId);
        return state === "failed" || state === "blocked";
      })) return record;
      changed = true;
      return { ...record, state: "blocked" as const, error: "A dependency failed." };
    });
    if (!changed) break;
  }
  return current;
}

function isAllowedTaskTransition(
  previous: ObjectiveTaskRecord["state"],
  next: ObjectiveTaskUpdate["state"],
): boolean {
  if (previous === next) return true;
  if (previous === "queued") return ["running", "completed", "failed"].includes(next);
  if (previous === "running") return ["completed", "failed"].includes(next);
  return false;
}

function getPath(root: Readonly<Record<string, JsonValue>>, rawPath: string): JsonValue | undefined {
  const path = rawPath.replace(/^\$\.?/u, "").split(".").filter(Boolean);
  let current: JsonValue | undefined = root;
  for (const part of path) {
    if (Array.isArray(current)) current = current[Number(part)];
    else if (current && typeof current === "object") current = current[part];
    else return undefined;
  }
  return current;
}

/** Apply a checkpoint's top-level context patch without mutating the run. */
function mergeCheckpointContext(
  existing: Readonly<Record<string, JsonValue>>,
  patch: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> {
  return { ...existing, ...patch };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function asString(value: JsonValue, label: string): string {
  if (typeof value !== "string") throw new ObjectiveRuntimeError(`${label} must be a string.`, "idempotency-conflict");
  return value;
}
