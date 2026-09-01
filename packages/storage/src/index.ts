import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  AgentRecordSchema,
  CommandReceiptSchema,
  EventEnvelopeSchema,
  ObjectiveActorSchema,
  ObjectiveCommandLedgerRecordSchema,
  ObjectiveApprovalRecordSchema,
  ObjectiveBudgetDebitRecordSchema,
  ObjectiveBudgetUsageSchema,
  ObjectiveBudgetLedgerRecordSchema,
  ObjectiveBudgetReservationRecordSchema,
  ObjectiveCheckpointRecordSchema,
  ObjectivePortableCheckpointRecordSchema,
  ObjectiveControlMutationSchema,
  ObjectiveControlPlanRevisionSchema,
  ObjectiveControlPlanSnapshotSchema,
  ObjectiveControlSourceSchema,
  applyObjectiveControlMutation,
  applyObjectiveControlMutationToSnapshot,
  objectiveControlStableJson,
  validateObjectiveControlMutationTarget,
  previewObjectiveControlMutation,
  ObjectivePolicySnapshotSchema,
  ObjectiveRunRecordSchema,
  ObjectiveAggregateRecordSchema,
  ObjectiveAggregateSnapshotSchema,
  ObjectiveRevisionRecordSchema,
  ObjectiveRunOccurrenceRecordSchema,
  ObjectiveRunOccurrenceKindSchema,
  ObjectiveOccurrenceOutcomeStateSchema,
  type ObjectiveAggregateRecord,
  type ObjectiveAggregateSnapshot,
  type ObjectiveRevisionRecord,
  type ObjectiveRunOccurrenceRecord,
  type ObjectiveRunOccurrenceKind,
  type ObjectiveOccurrenceOutcomeState,
  ObjectiveTaskRecordSchema,
  ObjectiveArtifactRecordSchema,
  ObjectiveArtifactReviewRecordSchema,
  ObjectiveAttentionRecordSchema,
  ObjectiveControlSuspensionRecordSchema,
  ObjectiveControlSignalDeliveryRecordSchema,
  ObjectiveHandoffEnvelopeSchema,
  ObjectiveHandoffAcceptanceRecordSchema,
  isObjectiveHandoffHashValid,
  isObjectiveHandoffAcceptanceHashValid,
  objectiveHandoffReferenceHash,
  objectiveArtifactContentHash,
  objectiveArtifactContentSize,
  OBJECTIVE_ARTIFACT_MAX_INLINE_BYTES,
  ObservationSchema,
  RoutingTraceSchema,
  UsageEventSchema,
  WorkerProcessLeaseSchema,
  projectWorkerEventPayload,
  isObjectivePolicyHashValid,
  nowIso,
  type AgentRecord,
  type CommandReceipt,
  type ConversationMessage,
  type EventEnvelope,
  type JsonValue,
  type ObjectiveActor,
  type ObjectiveCommandLedgerRecord,
  type ObjectiveApprovalRecord,
  type ObjectiveBudgetDebitRecord,
  type ObjectiveBudgetLedgerRecord,
  type ObjectiveBudgetReservationRecord,
  type ObjectiveBudgetUsage,
  type ObjectiveBudgetLimits,
  type ObjectiveCheckpointRecord,
  type ObjectiveControlMutation,
  type ObjectiveControlPlanRevision,
  type ObjectiveControlPlanSnapshot,
  type ObjectivePolicySnapshot,
  type ObjectiveRunRecord,
  type ObjectiveTaskRecord,
  type ObjectiveArtifactRecord,
  type ObjectiveArtifactReviewRecord,
  type ObjectiveAttentionRecord,
  type ObjectiveAttentionStatus,
  type ObjectiveControlSuspensionRecord,
  type ObjectiveControlSignalDeliveryRecord,
  type ObjectiveHandoffEnvelope,
  type ObjectiveHandoffAcceptanceRecord,
  type Observation,
  type ProjectRecord,
  type RoutingTrace,
  type UsageEvent,
  type WorkerProcessLease,
  type WorkerProcessLeaseState,
} from "@symphony/protocol";
import { ulid } from "ulid";

type Row = Record<string, unknown>;

export type WorkflowRevisionRecord = {
  id: string;
  revision: number;
  mission: JsonValue;
  definition: JsonValue;
  ir: JsonValue;
  hash: string;
  createdAt: string;
};

/**
 * Immutable authority and graph linkage captured when a workflow run is
 * created. A base depth of -1 represents a user/cron root, so workflow agent
 * steps still materialize at depth 0 through the uniform baseDepth + 1 rule.
 */
export type WorkflowRunOrigin = Readonly<{
  kind: "user" | "agent" | "cron";
  threadId: string | null;
  parentRunId: string | null;
  parentAgentId: string | null;
  baseDepth: number;
  permissionCeiling: "read-only" | "full-access";
}>;

export type WorkflowRunRecord = {
  id: string;
  workflowId: string;
  workflowRevision: number;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  input: JsonValue;
  output: JsonValue | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  cancelRequested: boolean;
  readonly origin?: WorkflowRunOrigin;
};

export type WorkflowRunPlanRecord = {
  version: 1;
  runId: string;
  workflowId: string;
  /** Immutable source workflow identity from which this run plan started. */
  workflowRevision: number;
  workflowHash: string;
  /** Mutable per-run overlay revision; independent from workflowRevision. */
  planRevision: number;
  steps: JsonValue[];
  createdAt: string;
  updatedAt: string;
};

export type WorkflowPlanMutationRecord = {
  version: 1;
  idempotencyKey: string;
  runId: string;
  authorAgentId: string;
  expectedPlanRevision: number;
  resultingPlanRevision: number;
  operation: "append";
  steps: JsonValue[];
  reason: string | null;
  createdAt: string;
};

/**
 * Immutable snapshot of one objective plan revision.
 *
 * Objective plans are intentionally stored separately from workflow source
 * revisions. A workflow is the durable recipe; this record is the objective
 * runtime's append-only projection of the work it currently intends to do.
 */
export type ObjectivePlanRevisionRecord = Readonly<{
  version: 1;
  id: string;
  runId: string;
  objectiveId: string;
  workflowId: string;
  workflowRevision: number;
  workflowHash: string;
  policyHash?: string | null;
  planRevision: number;
  tasks: ObjectiveTaskRecord[];
  createdBy: ObjectiveActor;
  requestKey: string;
  createdAt: string;
}>;

/**
 * Durable head for the second, tree-shaped objective control plane.  It is
 * intentionally separate from objective_runs.active_plan_revision: existing
 * flat objective plans and their recovery code remain valid while the
 * control-plan reducer evolves independently.
 */
export type ObjectiveControlHeadRecord = Readonly<{
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

/** Append-only idempotency receipt for one typed control-plan mutation. */
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

export type ObjectiveControlMutationCommit = Readonly<{
  status: "committed" | "replayed" | "conflict";
  head: ObjectiveControlHeadRecord | null;
  revision: ObjectiveControlPlanRevision | null;
  snapshot: ObjectiveControlPlanSnapshot | null;
  mutation: ObjectiveControlMutationRecord | null;
  reason?: string;
}>;

export type ObjectiveCommandLedgerInput = Readonly<{
  requestKey: string;
  operation: string;
  fingerprint: string;
  actor: ObjectiveActor;
  objectiveId: string | null;
  runId: string | null;
}>;

export type ObjectiveCommandLedgerExecution =
  | Readonly<{ status: "committed"; result: JsonValue }>
  | Readonly<{ status: "rejected"; result: JsonValue; reason: string }>;

export type ObjectiveCommandLedgerResult = Readonly<{
  status: "committed" | "replayed" | "rejected" | "unknown" | "conflict";
  result: JsonValue;
  record: ObjectiveCommandLedgerRecord;
  reason?: string;
}>;

/** Durable post-commit publication record for semantic objective events. */
export type ObjectiveEventOutboxRecord = Readonly<{
  version: 1;
  eventKey: string;
  eventId: string;
  runId: string;
  state: "pending" | "published";
  event: Omit<EventEnvelope, "id" | "cursor">;
  createdAt: string;
  publishedAt: string | null;
}>;

export type ObjectiveArtifactReceiptRecord = Readonly<{
  version: 1;
  requestKey: string;
  operation: "publish" | "review";
  fingerprint: string;
  runId: string;
  objectiveId: string;
  artifactId: string;
  createdAt: string;
}>;

export type ObjectiveArtifactPublishResult = Readonly<{
  status: "committed" | "replayed";
  artifact: ObjectiveArtifactRecord;
  superseded: ObjectiveArtifactReviewRecord[];
}>;

export type ObjectiveArtifactReviewResult = Readonly<{
  status: "committed" | "replayed";
  artifact: ObjectiveArtifactRecord;
  review: ObjectiveArtifactReviewRecord | null;
}>;

export type ObjectiveHandoffResult = Readonly<{
  status: "committed" | "replayed";
  envelope: ObjectiveHandoffEnvelope;
}>;

export type ObjectiveHandoffAcceptanceResult = Readonly<{
  status: "committed" | "replayed";
  acceptance: ObjectiveHandoffAcceptanceRecord;
}>;

export type ObjectiveHandoffReceiptRecord = Readonly<{
  version: 1;
  requestKey: string;
  operation: "offer" | "accept";
  fingerprint: string;
  envelopeId: string;
  objectiveId: string;
  runId: string;
  createdAt: string;
}>;

export type StepAttemptRecord = {
  id: string;
  runId: string;
  stepId: string;
  iterationKey: string;
  attempt: number;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  input: JsonValue;
  output: JsonValue | null;
  error: string | null;
  idempotencyKey: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type TriggerOccurrenceRecord = {
  version: 1;
  triggerId: string;
  occurrenceKey: string;
  workflowId: string;
  workflowRevision: number;
  workflowHash: string;
  input: JsonValue;
  scheduledAt: string;
  runId: string;
  state: "dispatching" | "settled";
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
};

export type PluginStateRecord = {
  id: string;
  version: string;
  path: string;
  status: "discovered" | "building" | "active" | "failed" | "disabled" | "quarantined";
  activeHash: string | null;
  previousHash: string | null;
  error: string | null;
  manifest: JsonValue;
  updatedAt: string;
};

export type ChatThreadRecord = {
  id: string;
  title: string;
  groupId: string | null;
  conductorAgentId: string | null;
  mission: JsonValue;
  workspacePath: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkerProcessLeaseTransitionPatch = Partial<
  Omit<
    WorkerProcessLease,
    | "id"
    | "daemonOwnerId"
    | "agentId"
    | "attemptId"
    | "driver"
    | "role"
    | "command"
    | "args"
    | "cwd"
    | "workspacePath"
    | "permission"
    | "reservedAt"
    | "revision"
  >
> & { state: WorkerProcessLeaseState };

export type WorkerProcessLeaseTouchPatch = Partial<
  Pick<
    WorkerProcessLease,
    | "nativeSessionId"
    | "nativeRunId"
    | "activeTurnId"
    | "lastEventCursor"
    | "error"
    | "transport"
    | "adapterState"
    | "retirementRequestedAt"
    | "retirementReason"
  >
>;

export type AgentListCursor = {
  updatedAt: string;
  id: string;
};

export type AgentListOptions = {
  runId?: string;
  activeOnly?: boolean;
  parentAgentId?: string;
};

/** Stable keyset cursor used while reconciling workflow runs on restart. */
export type WorkflowRunListCursor = {
  updatedAt: string;
  id: string;
};

export type WorkflowRunListOptions = {
  status?: WorkflowRunRecord["status"][];
};

const migrations: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        workflow_id TEXT,
        run_id TEXT,
        agent_id TEXT,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        provenance_json TEXT
      );
      CREATE INDEX IF NOT EXISTS events_workflow_cursor ON events(workflow_id, cursor);
      CREATE INDEX IF NOT EXISTS events_run_cursor ON events(run_id, cursor);
      CREATE INDEX IF NOT EXISTS events_agent_cursor ON events(agent_id, cursor);

      CREATE TABLE IF NOT EXISTS workflow_revisions (
        workflow_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        hash TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workflow_id, revision)
      );

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflow_runs_status ON workflow_runs(status, updated_at);

      CREATE TABLE IF NOT EXISTS step_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        iteration_key TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, step_id, iteration_key, attempt)
      );
      CREATE INDEX IF NOT EXISTS step_attempts_run ON step_attempts(run_id, step_id, iteration_key);

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        logical_agent_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        parent_agent_id TEXT,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agents_run ON agents(run_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS agents_parent ON agents(parent_agent_id, updated_at);

      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        content TEXT NOT NULL,
        receipt_id TEXT,
        delivery_state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_messages_agent ON agent_messages(agent_id, created_at);

      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        level TEXT NOT NULL,
        event_cursor INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(agent_id, level, event_cursor)
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        agent_id TEXT,
        cost_amount REAL,
        basis TEXT NOT NULL,
        record_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_workflow ON usage_events(workflow_id, recorded_at);
      CREATE INDEX IF NOT EXISTS usage_agent ON usage_events(agent_id, recorded_at);

      CREATE TABLE IF NOT EXISTS routing_traces (
        id TEXT PRIMARY KEY,
        work_order_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS command_receipts (
        idempotency_key TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trigger_occurrences (
        trigger_id TEXT NOT NULL,
        occurrence_key TEXT NOT NULL,
        run_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(trigger_id, occurrence_key)
      );

      CREATE TABLE IF NOT EXISTS plugin_states (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_messages_thread ON conversation_messages(thread_id, created_at);

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS chat_threads (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_threads_group ON chat_threads(group_id, archived, updated_at);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_updated ON projects(updated_at DESC);
    `,
  },
  {
    version: 4,
    sql: `
      UPDATE events
      SET payload_json = json_object(
        'threadId', json_extract(payload_json, '$.threadId'),
        'messageId', json_extract(payload_json, '$.message.id')
      )
      WHERE type = 'chat.message.updated'
        AND json_type(payload_json, '$.message') = 'object';
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS native_driver_events (
        agent_id TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        native_event_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, event_kind, native_event_id)
      );
      INSERT OR IGNORE INTO native_driver_events(agent_id, event_kind, native_event_id, claimed_at)
      SELECT
        agent_id,
        substr(type, length('driver.') + 1),
        json_extract(provenance_json, '$.nativeEventId'),
        occurred_at
      FROM events
      WHERE agent_id IS NOT NULL
        AND type LIKE 'driver.%'
        AND json_type(provenance_json, '$.nativeEventId') = 'text'
        AND length(json_extract(provenance_json, '$.nativeEventId')) > 0;
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS worker_process_leases (
        id TEXT PRIMARY KEY,
        daemon_owner_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        driver TEXT NOT NULL,
        role TEXT NOT NULL,
        state TEXT NOT NULL,
        pid INTEGER,
        process_group_id INTEGER,
        process_start_token TEXT,
        revision INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, attempt_id, role)
      );
      CREATE INDEX IF NOT EXISTS worker_process_leases_state_updated
        ON worker_process_leases(state, updated_at);
      CREATE INDEX IF NOT EXISTS worker_process_leases_agent_updated
        ON worker_process_leases(agent_id, updated_at);
      CREATE INDEX IF NOT EXISTS worker_process_leases_owner_state
        ON worker_process_leases(daemon_owner_id, state, updated_at);
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE worker_process_leases ADD COLUMN transport_kind TEXT NOT NULL DEFAULT 'direct';
      ALTER TABLE worker_process_leases ADD COLUMN transport_endpoint TEXT;
      ALTER TABLE worker_process_leases ADD COLUMN owner_epoch INTEGER;
      ALTER TABLE worker_process_leases ADD COLUMN processed_output_seq INTEGER;
      ALTER TABLE worker_process_leases ADD COLUMN acked_output_seq INTEGER;
      CREATE INDEX IF NOT EXISTS worker_process_leases_transport_state
        ON worker_process_leases(transport_kind, state, updated_at);
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE trigger_occurrences ADD COLUMN state TEXT NOT NULL DEFAULT 'settled';
      ALTER TABLE trigger_occurrences ADD COLUMN record_json TEXT;
      ALTER TABLE trigger_occurrences ADD COLUMN updated_at TEXT;
      UPDATE trigger_occurrences SET updated_at = created_at WHERE updated_at IS NULL;
      CREATE INDEX IF NOT EXISTS trigger_occurrences_state_updated
        ON trigger_occurrences(state, updated_at);
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS workflow_run_plans (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_revision INTEGER NOT NULL,
        workflow_hash TEXT NOT NULL,
        plan_revision INTEGER NOT NULL,
        steps_json TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflow_run_plans_workflow
        ON workflow_run_plans(workflow_id, updated_at);

      CREATE TABLE IF NOT EXISTS workflow_plan_mutations (
        idempotency_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        author_agent_id TEXT NOT NULL,
        expected_plan_revision INTEGER NOT NULL,
        resulting_plan_revision INTEGER NOT NULL,
        operation TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        reason TEXT,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflow_plan_mutations_run
        ON workflow_plan_mutations(run_id, created_at);
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS objective_runs (
        run_id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_revision INTEGER NOT NULL,
        workflow_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        active_plan_revision INTEGER NOT NULL,
        latest_checkpoint_id TEXT,
        request_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(request_key)
      );
      CREATE INDEX IF NOT EXISTS objective_runs_state_updated
        ON objective_runs(state, updated_at);
      CREATE INDEX IF NOT EXISTS objective_runs_objective_updated
        ON objective_runs(objective_id, updated_at);

      /* Plan revisions are immutable. The active revision pointer lives on
       * objective_runs and is advanced with a compare-and-swap transaction. */
      CREATE TABLE IF NOT EXISTS objective_plan_revisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_revision INTEGER NOT NULL,
        workflow_hash TEXT NOT NULL,
        plan_revision INTEGER NOT NULL,
        tasks_json TEXT NOT NULL,
        created_by_type TEXT NOT NULL,
        created_by_id TEXT NOT NULL,
        request_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, plan_revision),
        UNIQUE(run_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS objective_plan_revisions_run
        ON objective_plan_revisions(run_id, plan_revision);

      CREATE TABLE IF NOT EXISTS objective_checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        plan_revision INTEGER NOT NULL,
        event_cursor INTEGER NOT NULL,
        context_json TEXT NOT NULL,
        task_states_json TEXT NOT NULL,
        criteria_json TEXT NOT NULL,
        context_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_by_type TEXT NOT NULL,
        created_by_id TEXT NOT NULL,
        request_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, sequence),
        UNIQUE(run_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS objective_checkpoints_run
        ON objective_checkpoints(run_id, sequence);

      CREATE TABLE IF NOT EXISTS objective_approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        task_id TEXT,
        status TEXT NOT NULL,
        requested_by_type TEXT NOT NULL,
        requested_by_id TEXT NOT NULL,
        decided_by_type TEXT,
        decided_by_id TEXT,
        request_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(run_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS objective_approvals_run_status
        ON objective_approvals(run_id, status, requested_at);
    `,
  },
  {
    // Approval identity was expanded after the first objective storage
    // migration. Keep this additive so existing local stores upgrade without
    // rewriting any approval records.
    version: 11,
    sql: `
      ALTER TABLE objective_approvals ADD COLUMN operation_id TEXT;
      ALTER TABLE objective_approvals ADD COLUMN request_hash TEXT;
      ALTER TABLE objective_approvals ADD COLUMN policy_hash TEXT;
      ALTER TABLE objective_approvals ADD COLUMN side_effect_class TEXT;
      ALTER TABLE objective_approvals ADD COLUMN canonical_target TEXT;
      ALTER TABLE objective_approvals ADD COLUMN expires_at TEXT;
      CREATE INDEX IF NOT EXISTS objective_approvals_operation
        ON objective_approvals(run_id, operation_id, requested_at);
    `,
  },
  {
    // Objective budgets are append/idempotency ledgers rather than an
    // ephemeral in-memory counter. Keep each record JSON-backed so new
    // protocol fields can be read after a daemon restart without destructive
    // migrations, while indexed identity columns make CAS and replay checks
    // atomic and cheap.
    version: 12,
    sql: `
      CREATE TABLE IF NOT EXISTS objective_budget_ledgers (
        run_id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS objective_budget_ledgers_status
        ON objective_budget_ledgers(status, updated_at);

      CREATE TABLE IF NOT EXISTS objective_budget_reservations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        reservation_key TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL,
        request_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        released_at TEXT,
        UNIQUE(run_id, reservation_key),
        UNIQUE(run_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS objective_budget_reservations_run_state
        ON objective_budget_reservations(run_id, state, updated_at);

      CREATE TABLE IF NOT EXISTS objective_budget_debits (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        usage_event_key TEXT NOT NULL,
        reservation_id TEXT,
        request_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, usage_event_key),
        UNIQUE(run_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS objective_budget_debits_run_created
        ON objective_budget_debits(run_id, created_at);
    `,
  },
  {
    // Native usage identity was added after the initial usage table. Keep the
    // fields additive so old rows remain readable, while the partial unique
    // index makes replay of a provider event a no-op at the storage boundary.
    version: 13,
    sql: `
      ALTER TABLE usage_events ADD COLUMN objective_attempt_id TEXT;
      ALTER TABLE usage_events ADD COLUMN native_turn_id TEXT;
      ALTER TABLE usage_events ADD COLUMN native_event_id TEXT;
      CREATE INDEX IF NOT EXISTS usage_objective_attempt
        ON usage_events(run_id, objective_attempt_id, recorded_at);
      CREATE UNIQUE INDEX IF NOT EXISTS usage_native_event_identity
        ON usage_events(run_id, agent_id, native_event_id)
        WHERE native_event_id IS NOT NULL;
    `,
  },
  {
    // Objective acknowledgements and their semantic projection events share a
    // durable intent. Delivery is deliberately post-commit so a process crash
    // cannot lose the event or make a retry publish it twice.
    version: 14,
    sql: `
      CREATE TABLE IF NOT EXISTS objective_event_outbox (
        event_key TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        published_at TEXT
      );
      CREATE INDEX IF NOT EXISTS objective_event_outbox_state_created
        ON objective_event_outbox(state, created_at);
    `,
  },
  {
    // Tree-shaped objective control plans are deliberately isolated from the
    // original flat objective_plan_revisions/workflow_plan_mutations tables.
    // A separate head provides a CAS fence without changing the legacy
    // ObjectiveRunRecord or its active_plan_revision meaning.
    version: 15,
    sql: `
      CREATE TABLE IF NOT EXISTS objective_control_heads (
        run_id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        source_json TEXT NOT NULL,
        active_revision INTEGER NOT NULL,
        latest_snapshot_sequence INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS objective_control_heads_objective
        ON objective_control_heads(objective_id, updated_at);

      CREATE TABLE IF NOT EXISTS objective_control_plan_revisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        source_json TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_by_type TEXT NOT NULL,
        created_by_id TEXT NOT NULL,
        request_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, revision),
        UNIQUE(run_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS objective_control_plan_revisions_run
        ON objective_control_plan_revisions(run_id, revision);

      CREATE TABLE IF NOT EXISTS objective_control_snapshots (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        plan_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL,
        event_cursor INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS objective_control_snapshots_run_revision
        ON objective_control_snapshots(run_id, plan_revision, sequence);

      CREATE TABLE IF NOT EXISTS objective_control_mutations (
        mutation_id TEXT PRIMARY KEY,
        request_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        expected_revision INTEGER NOT NULL,
        resulting_revision INTEGER NOT NULL,
        snapshot_sequence INTEGER NOT NULL,
        revision_id TEXT NOT NULL,
        mutation_json TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS objective_control_mutations_run_created
        ON objective_control_mutations(run_id, created_at, mutation_id);
    `,
  },
  {
    // Inline objective artifacts are immutable publication records. Review
    // transitions and request receipts are append-only, so a daemon restart
    // cannot turn an acknowledged publication into a duplicate output.
    version: 16,
    sql: `
      CREATE TABLE IF NOT EXISTS objective_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL,
        hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        lineage_json TEXT NOT NULL,
        supersedes TEXT,
        record_json TEXT NOT NULL,
        published_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS objective_artifacts_run_published
        ON objective_artifacts(run_id, published_at, id);
      CREATE INDEX IF NOT EXISTS objective_artifacts_run_hash
        ON objective_artifacts(run_id, hash);

      CREATE TABLE IF NOT EXISTS objective_artifact_reviews (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        from_state TEXT NOT NULL,
        state TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        request_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(artifact_id, sequence),
        UNIQUE(run_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS objective_artifact_reviews_artifact
        ON objective_artifact_reviews(artifact_id, sequence);

      CREATE TABLE IF NOT EXISTS objective_artifact_receipts (
        request_key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        run_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    // Attention is a first-class decision record rather than a UI-only
    // notification. Identity/content are stored as one validated JSON value;
    // indexed bindings make cross-objective reads and CAS resolution cheap.
    version: 17,
    sql: `
      CREATE TABLE IF NOT EXISTS objective_attentions (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        node_id TEXT,
        attempt_id TEXT,
        status TEXT NOT NULL,
        request_key TEXT NOT NULL,
        expires_at TEXT,
        assignee_type TEXT,
        assignee_id TEXT,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS objective_attentions_run_status
        ON objective_attentions(run_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS objective_attentions_objective_status
        ON objective_attentions(objective_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS objective_attentions_expiry
        ON objective_attentions(status, expires_at);
    `,
  },
  {
    // Suspension rows provide a queryable durable frontier in addition to the
    // full control snapshot.  Signal delivery receipts are scoped by the
    // objective/run/execution/attempt subscription and producer delivery id.
    version: 18,
    sql: `
      CREATE TABLE IF NOT EXISTS objective_control_suspensions (
        run_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        due_at TEXT,
        expires_at TEXT,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, execution_id)
      );
      CREATE INDEX IF NOT EXISTS objective_control_suspensions_due
        ON objective_control_suspensions(status, due_at, expires_at);
      CREATE INDEX IF NOT EXISTS objective_control_suspensions_run
        ON objective_control_suspensions(run_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS objective_control_signal_deliveries (
        subscription_key TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(subscription_key, delivery_id)
      );
      CREATE INDEX IF NOT EXISTS objective_control_signal_deliveries_run
        ON objective_control_signal_deliveries(run_id, created_at);
    `,
  },
  {
    // An objective is a durable aggregate above runs.  These records are
    // append/idempotency addressed and JSON-backed so future protocol fields
    // survive local-store upgrades without rewriting legacy ObjectiveRunRecord
    // rows.  Runs and all existing objective sub-records remain authoritative;
    // the aggregate only owns objective identity, revision history, and the
    // causal occurrence edges between runs.
    version: 19,
    sql: `
      CREATE TABLE IF NOT EXISTS objective_aggregates (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL UNIQUE,
        active_revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        latest_run_id TEXT,
        latest_outcome TEXT,
        workspace_json TEXT,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS objective_aggregates_state_updated
        ON objective_aggregates(state, updated_at);

      CREATE TABLE IF NOT EXISTS objective_revisions (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        request_key TEXT NOT NULL,
        workspace_json TEXT,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(objective_id, revision),
        UNIQUE(objective_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS objective_revisions_objective
        ON objective_revisions(objective_id, revision);

      CREATE TABLE IF NOT EXISTS objective_run_occurrences (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        objective_revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        occurrence_key TEXT,
        trigger_id TEXT,
        parent_occurrence_id TEXT,
        parent_run_id TEXT,
        forked_from_occurrence_id TEXT,
        forked_from_run_id TEXT,
        supersedes_occurrence_id TEXT,
        supersedes_run_id TEXT,
        outcome TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(objective_id, occurrence_key)
      );
      CREATE INDEX IF NOT EXISTS objective_run_occurrences_objective
        ON objective_run_occurrences(objective_id, created_at, id);
      CREATE INDEX IF NOT EXISTS objective_run_occurrences_outcome
        ON objective_run_occurrences(objective_id, outcome, updated_at);
    `,
  },
  {
    // Handoff envelopes are immutable, content-addressed transfer boundaries.
    // Acceptance is a separate append-only record: accepting a handoff must
    // never mutate the envelope or pretend a native transcript is portable.
    version: 20,
    sql: `
      CREATE TABLE IF NOT EXISTS objective_handoffs (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        request_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS objective_handoffs_run_created
        ON objective_handoffs(run_id, created_at, id);
      CREATE INDEX IF NOT EXISTS objective_handoffs_objective_created
        ON objective_handoffs(objective_id, created_at, id);

      CREATE TABLE IF NOT EXISTS objective_handoff_acceptances (
        id TEXT PRIMARY KEY,
        envelope_id TEXT NOT NULL UNIQUE,
        objective_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        request_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS objective_handoff_acceptances_run_created
        ON objective_handoff_acceptances(run_id, created_at, id);
    `,
  },
  {
    // Objective command requests are distinct from provider command
    // receipts. The ledger binds one caller/request fingerprint to an
    // immutable outcome and objective/run authority, allowing a replay to be
    // answered from durable state before any current-head validation runs.
    version: 21,
    sql: `
      CREATE TABLE IF NOT EXISTS objective_command_ledger (
        request_key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        objective_id TEXT,
        run_id TEXT,
        outcome_status TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS objective_command_ledger_run_created
        ON objective_command_ledger(run_id, created_at, request_key);
      CREATE INDEX IF NOT EXISTS objective_command_ledger_objective_created
        ON objective_command_ledger(objective_id, created_at, request_key);
    `,
  },
];

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Canonical content hash used for durable control-plan revision identity. */
export function objectiveControlPlanHash(plan: ObjectiveControlPlanRevision["plan"]): string {
  return createHash("sha256").update(objectiveControlStableJson(plan)).digest("hex");
}

/**
 * Native usage identity is authoritative for replay handling. Runtime creates
 * a fresh local row id/timestamp for each delivery, so those bookkeeping
 * fields must not make an otherwise identical replay look like conflicting
 * evidence.
 */
function stableUsageEvidence(value: UsageEvent): string {
  const { id: _id, recordedAt: _recordedAt, ...evidence } = value;
  return stableSerialize(evidence);
}

function parseJson<T>(value: unknown): T {
  if (typeof value !== "string") throw new Error("Expected SQLite JSON text");
  return JSON.parse(value) as T;
}

function parseObjectiveCommandLedger(value: unknown): ObjectiveCommandLedgerRecord {
  return ObjectiveCommandLedgerRecordSchema.parse(value);
}

function parseStoredEvent(row: Row): EventEnvelope {
  const event = EventEnvelopeSchema.parse({
    id: row.id,
    cursor: row.cursor,
    type: row.type,
    workflowId: row.workflow_id,
    runId: row.run_id,
    agentId: row.agent_id,
    occurredAt: row.occurred_at,
    payload: parseJson(row.payload_json),
    provenance: row.provenance_json ? parseJson(row.provenance_json) : undefined,
  });
  const isWorkerEvent = event.provenance?.source === "driver" || event.provenance?.rawProvenance !== undefined;
  if (!isWorkerEvent) return event;
  const provenance = event.provenance?.rawProvenance
    ? {
      ...event.provenance,
      rawProvenance: {
        ...event.provenance.rawProvenance,
        payload: projectWorkerEventPayload(event.provenance.rawProvenance.payload) as JsonValue,
      },
    }
    : event.provenance;
  return EventEnvelopeSchema.parse({
    ...event,
    payload: projectWorkerEventPayload(event.payload) as JsonValue,
    provenance,
  });
}

function withoutEventIdentity(event: EventEnvelope): Omit<EventEnvelope, "id" | "cursor"> {
  const { id: _id, cursor: _cursor, ...rest } = event;
  return rest;
}

function parseObjectiveEventOutbox(value: unknown): ObjectiveEventOutboxRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed objective event outbox record");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || typeof record.eventKey !== "string"
    || typeof record.eventId !== "string"
    || typeof record.runId !== "string"
    || !["pending", "published"].includes(String(record.state))
    || typeof record.createdAt !== "string"
    || (record.publishedAt !== null && typeof record.publishedAt !== "string")
  ) {
    throw new Error("Malformed objective event outbox identity");
  }
  const event = EventEnvelopeSchema.parse({
    ...(record.event as Record<string, unknown>),
    id: record.eventId,
    cursor: 1,
  });
  if (event.runId !== record.runId) throw new Error("Objective event outbox run identity mismatch");
  return {
    version: 1,
    eventKey: record.eventKey,
    eventId: record.eventId,
    runId: record.runId,
    state: record.state as "pending" | "published",
    event: withoutEventIdentity(event),
    createdAt: record.createdAt,
    publishedAt: record.publishedAt as string | null,
  };
}

function objectiveEventOutboxEquivalent(left: ObjectiveEventOutboxRecord, right: ObjectiveEventOutboxRecord): boolean {
  return left.eventKey === right.eventKey
    && left.eventId === right.eventId
    && left.runId === right.runId
    && stableSerialize(left.event) === stableSerialize(right.event)
    && left.createdAt === right.createdAt;
}

function objectiveEventMatches(event: EventEnvelope, outbox: ObjectiveEventOutboxRecord): boolean {
  return event.id === outbox.eventId
    && event.type === outbox.event.type
    && event.workflowId === outbox.event.workflowId
    && event.runId === outbox.event.runId
    && event.agentId === outbox.event.agentId
    && event.occurredAt === outbox.event.occurredAt
    && stableSerialize(event.payload) === stableSerialize(outbox.event.payload)
    && stableSerialize(event.provenance) === stableSerialize(outbox.event.provenance);
}

/**
 * Agent identity is established at creation and is never a lifecycle patch.
 * Keep this list deliberately broader than the indexed columns: workspace,
 * mission, requested execution mode, authority ceiling, and creation time all
 * participate in the durable root/attempt identity even though older stores
 * only indexed the graph linkage fields.
 */
const agentIdentityFields = [
  "id",
  "logicalAgentId",
  "workflowId",
  "runId",
  "parentAgentId",
  "depth",
  "objective",
  "missionHash",
  "requestedHarness",
  "requestedModel",
  "permissions",
  "workspacePath",
  "createdAt",
] as const satisfies readonly (keyof AgentRecord)[];

function assertAgentIdentity(existing: AgentRecord, next: AgentRecord): void {
  for (const field of agentIdentityFields) {
    if (existing[field] !== next[field]) {
      throw new Error(`Agent identity field ${field} is immutable: ${next.id}`);
    }
  }
}

function assertObjectiveRunIdentity(existing: ObjectiveRunRecord, next: ObjectiveRunRecord): void {
  if (
    existing.objectiveId !== next.objectiveId ||
    existing.objectiveRevision !== next.objectiveRevision ||
    existing.workflowId !== next.workflowId ||
    existing.workflowRevision !== next.workflowRevision ||
    existing.workflowHash !== next.workflowHash ||
    existing.spec.id !== next.spec.id ||
    existing.conductorAgentId !== next.conductorAgentId ||
    existing.policyHash !== next.policyHash ||
    stableSerialize(existing.policy) !== stableSerialize(next.policy) ||
    existing.requestKey !== next.requestKey
  ) {
    throw new Error(`Objective run identity is immutable: ${next.runId}`);
  }
}

function assertObjectiveRunPolicy(record: ObjectiveRunRecord): void {
  if (!record.policy) {
    // A missing policy is valid only for legacy rows. It is intentionally not
    // upgraded here: doing so would fabricate an authority envelope.
    if (record.policyHash !== undefined && record.policyHash !== null) {
      throw new Error(`Objective run policyHash has no policy snapshot: ${record.runId}`);
    }
    return;
  }
  const policy = ObjectivePolicySnapshotSchema.parse(record.policy);
  if (
    record.policyHash !== policy.policyHash ||
    !isObjectivePolicyHashValid(policy) ||
    policy.runId !== record.runId ||
    policy.objectiveId !== record.objectiveId ||
    policy.workflowId !== record.workflowId ||
    policy.workflowRevision !== record.workflowRevision ||
    policy.workflowHash !== record.workflowHash
  ) {
    throw new Error(`Objective run policy snapshot does not match run identity: ${record.runId}`);
  }
}

/** Parse a durable run and reject any tampered embedded policy identity. */
function parseObjectiveRun(value: unknown): ObjectiveRunRecord {
  const run = ObjectiveRunRecordSchema.parse(value);
  assertObjectiveRunPolicy(run);
  return run;
}

function assertObjectivePlanIdentity(run: ObjectiveRunRecord, plan: ObjectivePlanRevisionRecord): void {
  if (
    run.objectiveId !== plan.objectiveId ||
    run.workflowId !== plan.workflowId ||
    run.workflowRevision !== plan.workflowRevision ||
    run.workflowHash !== plan.workflowHash ||
    (run.policyHash ?? null) !== (plan.policyHash ?? null)
  ) {
    throw new Error(`Objective plan identity does not match its run: ${plan.runId}`);
  }
}

function assertObjectiveControlRevisionIdentity(run: ObjectiveRunRecord, revision: ObjectiveControlPlanRevision): void {
  if (
    revision.runId !== run.runId
    || revision.objectiveId !== run.objectiveId
    || revision.planId !== revision.plan.id
    || objectiveControlStableJson(revision.source) !== objectiveControlStableJson(revision.plan.source)
  ) {
    throw new Error(`Objective control-plan identity does not match its run: ${revision.runId}`);
  }
  if (revision.hash !== objectiveControlPlanHash(revision.plan)) {
    throw new Error(`Objective control-plan hash does not match its immutable plan: ${revision.planId}/${revision.revision}`);
  }
  // A workflow-backed control plan is pinned to the exact workflow revision
  // admitted for this objective. Conductor-authored plans deliberately have
  // no workflow identity and are valid for local/manual objectives.
  if (revision.source.kind === "workflow-revision" && (
    revision.source.workflowId !== run.workflowId
    || revision.source.workflowRevision !== run.workflowRevision
    || revision.source.workflowHash !== run.workflowHash
  )) {
    throw new Error(`Objective control-plan source workflow identity does not match its run: ${revision.runId}`);
  }
}

function assertObjectiveControlSnapshotIdentity(
  head: ObjectiveControlHeadRecord,
  snapshot: ObjectiveControlPlanSnapshot,
): void {
  if (
    snapshot.runId !== head.runId
    || snapshot.objectiveId !== head.objectiveId
    || snapshot.planId !== head.planId
  ) {
    throw new Error(`Objective control snapshot identity does not match its head: ${snapshot.runId}`);
  }
}

/**
 * Snapshot maps are keyed by concrete execution ids.  Validate every
 * reference against the immutable active plan before the projection can
 * become the durable UI/reducer high-water mark.
 */
function assertObjectiveControlSnapshotReferences(
  revision: ObjectiveControlPlanRevision,
  snapshot: ObjectiveControlPlanSnapshot,
): void {
  const nodeIds = new Set<string>();
  const visit = (node: ObjectiveControlPlanRevision["plan"]["root"]): void => {
    nodeIds.add(node.id);
    if (node.type === "sequence" || node.type === "parallel" || node.type === "while") {
      node.steps.forEach(visit);
    } else if (node.type === "if") {
      node.then.forEach(visit);
      node.else?.forEach(visit);
    }
  };
  visit(revision.plan.root);

  const executionIds = new Set<string>();
  for (const execution of snapshot.executions) {
    if (!nodeIds.has(execution.key.nodeId)) {
      throw new Error(`Objective control snapshot references unknown execution node ${execution.key.nodeId}`);
    }
    const executionId = `${execution.key.nodeId}@${execution.key.iterationKey}`;
    executionIds.add(executionId);
  }
  for (const key of snapshot.frontier) {
    if (!nodeIds.has(key.nodeId)) {
      throw new Error(`Objective control snapshot frontier references unknown node ${key.nodeId}`);
    }
  }

  const mapNames = ["nodeStates", "branches", "exitReasons", "attemptIds", "loopIterations"] as const;
  for (const mapName of mapNames) {
    for (const key of Object.keys(snapshot[mapName])) {
      const separator = key.indexOf("@");
      const nodeId = separator === -1 ? key : key.slice(0, separator);
      if (!nodeIds.has(nodeId)) {
        throw new Error(`Objective control snapshot ${mapName} references unknown node ${nodeId}`);
      }
      if (separator === -1) {
        throw new Error(`Objective control snapshot ${mapName} must use execution ids: ${key}`);
      }
      // A map may retain a settled execution after its detailed record has
      // been compacted, so validate the plan node here rather than requiring
      // a matching `executions` entry.
      if (executionIds.size > 0 && !executionIds.has(key)) {
        // Keep this as a node/reference check only. Iteration map entries can
        // legitimately be written before their execution detail is emitted.
        continue;
      }
    }
  }
}

function assertObjectiveControlHeadIdentity(
  head: ObjectiveControlHeadRecord,
  revision: ObjectiveControlPlanRevision,
): void {
  if (
    revision.runId !== head.runId
    || revision.objectiveId !== head.objectiveId
    || revision.planId !== head.planId
    || objectiveControlStableJson(revision.source) !== objectiveControlStableJson(head.source)
  ) {
    throw new Error(`Objective control-plan source identity is immutable: ${revision.runId}`);
  }
}

function assertObjectiveApprovalIdentity(existing: ObjectiveApprovalRecord, next: ObjectiveApprovalRecord): void {
  if (
    existing.runId !== next.runId ||
    existing.objectiveId !== next.objectiveId ||
    existing.planRevision !== next.planRevision ||
    existing.kind !== next.kind ||
    existing.taskId !== next.taskId ||
    existing.question !== next.question ||
    stableSerialize(existing.scope) !== stableSerialize(next.scope) ||
    existing.operationId !== next.operationId ||
    existing.requestHash !== next.requestHash ||
    existing.policyHash !== next.policyHash ||
    existing.sideEffectClass !== next.sideEffectClass ||
    existing.canonicalTarget !== next.canonicalTarget ||
    existing.capability !== next.capability ||
    existing.expiresAt !== next.expiresAt ||
    existing.requestedBy.type !== next.requestedBy.type ||
    existing.requestedBy.id !== next.requestedBy.id ||
    existing.requestedAt !== next.requestedAt ||
    existing.requestKey !== next.requestKey
  ) {
    throw new Error(`Objective approval identity is immutable: ${next.id}`);
  }
}

function objectiveRecordEquivalent(left: unknown, right: unknown): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

function controlPlanValueContainsNode(value: unknown, nodeId: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => controlPlanValueContainsNode(entry, nodeId));
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.id === nodeId && typeof record.type === "string") return true;
  return Object.values(record).some((entry) => controlPlanValueContainsNode(entry, nodeId));
}

function addBudgetUsage(left: ObjectiveBudgetUsage, right: ObjectiveBudgetUsage): ObjectiveBudgetUsage {
  return ObjectiveBudgetUsageSchema.parse({
    costUsd: left.costUsd + right.costUsd,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    modelCalls: left.modelCalls + right.modelCalls,
    toolCalls: left.toolCalls + right.toolCalls,
    wallTimeSeconds: left.wallTimeSeconds + right.wallTimeSeconds,
    outputBytes: left.outputBytes + right.outputBytes,
    storageBytes: left.storageBytes + right.storageBytes,
    loopIterations: left.loopIterations + right.loopIterations,
  });
}

function subtractBudgetUsage(left: ObjectiveBudgetUsage, right: ObjectiveBudgetUsage): ObjectiveBudgetUsage {
  const result = {
    costUsd: left.costUsd - right.costUsd,
    inputTokens: left.inputTokens - right.inputTokens,
    outputTokens: left.outputTokens - right.outputTokens,
    totalTokens: left.totalTokens - right.totalTokens,
    modelCalls: left.modelCalls - right.modelCalls,
    toolCalls: left.toolCalls - right.toolCalls,
    wallTimeSeconds: left.wallTimeSeconds - right.wallTimeSeconds,
    outputBytes: left.outputBytes - right.outputBytes,
    storageBytes: left.storageBytes - right.storageBytes,
    loopIterations: left.loopIterations - right.loopIterations,
  };
  for (const [key, value] of Object.entries(result)) {
    if (value < 0) throw new Error(`Objective budget accounting underflow for ${key}`);
  }
  return ObjectiveBudgetUsageSchema.parse(result);
}

function budgetWithinLimits(usage: ObjectiveBudgetUsage, limits: ObjectiveBudgetLimits): boolean {
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
  return checks.every(([usageKey, limitKey]) => {
    const limit = limits[limitKey];
    return limit === null || usage[usageKey] <= limit;
  });
}

function budgetExhausted(usage: ObjectiveBudgetUsage, limits: ObjectiveBudgetLimits): boolean {
  return [
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
  ].some(([usageKey, limitKey]) => {
    const limit = limits[limitKey as keyof typeof limits];
    return limit !== null && usage[usageKey as keyof ObjectiveBudgetUsage] >= limit;
  });
}

function parseObjectiveBudgetLedger(value: unknown): ObjectiveBudgetLedgerRecord {
  return ObjectiveBudgetLedgerRecordSchema.parse(value);
}

function parseObjectiveBudgetReservation(value: unknown): ObjectiveBudgetReservationRecord {
  return ObjectiveBudgetReservationRecordSchema.parse(value);
}

function parseObjectiveBudgetDebit(value: unknown): ObjectiveBudgetDebitRecord {
  return ObjectiveBudgetDebitRecordSchema.parse(value);
}

function parseObjectivePlanRevision(value: unknown): ObjectivePlanRevisionRecord {
  if (typeof value !== "object" || value === null) throw new Error("Invalid objective plan revision record");
  const record = value as Row;
  if (
    record.version !== 1 ||
    typeof record.id !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.objectiveId !== "string" ||
    typeof record.workflowId !== "string" ||
    typeof record.workflowRevision !== "number" ||
    !Number.isInteger(record.workflowRevision) ||
    typeof record.workflowHash !== "string" ||
    typeof record.planRevision !== "number" ||
    !Number.isInteger(record.planRevision) ||
    !Array.isArray(record.tasks) ||
    typeof record.requestKey !== "string" ||
    typeof record.createdAt !== "string"
  ) {
    throw new Error("Invalid objective plan revision record");
  }
  const workflowRevision = record.workflowRevision as number;
  const planRevision = record.planRevision as number;
  const tasks = ObjectiveTaskRecordSchema.array().max(128).parse(record.tasks);
  const createdBy = ObjectiveActorSchema.parse(record.createdBy);
  if (
    record.id.length === 0 ||
    record.runId.length === 0 ||
    record.objectiveId.length === 0 ||
    record.workflowId.length === 0 ||
    record.workflowHash.length < 8 ||
    workflowRevision < 1 ||
    planRevision < 0 ||
    record.requestKey.length < 8
  ) {
    throw new Error("Invalid objective plan revision record");
  }
  return {
    version: 1,
    id: record.id,
    runId: record.runId,
    objectiveId: record.objectiveId,
    workflowId: record.workflowId,
    workflowRevision,
    workflowHash: record.workflowHash,
    ...(typeof record.policyHash === "string" || record.policyHash === null ? { policyHash: record.policyHash } : {}),
    planRevision,
    tasks,
    createdBy,
    requestKey: record.requestKey,
    createdAt: record.createdAt,
  };
}

function parseObjectiveControlPlanRevision(value: unknown): ObjectiveControlPlanRevision {
  return ObjectiveControlPlanRevisionSchema.parse(value);
}

function parseObjectiveControlSnapshot(value: unknown): ObjectiveControlPlanSnapshot {
  return ObjectiveControlPlanSnapshotSchema.parse(value);
}

function parseObjectiveControlMutation(value: unknown): ObjectiveControlMutation {
  return ObjectiveControlMutationSchema.parse(value);
}

function parseObjectiveControlSuspension(value: unknown): ObjectiveControlSuspensionRecord {
  return ObjectiveControlSuspensionRecordSchema.parse(value);
}

function parseObjectiveControlSignalDelivery(value: unknown): ObjectiveControlSignalDeliveryRecord {
  return ObjectiveControlSignalDeliveryRecordSchema.parse(value);
}

function parseObjectiveControlHead(value: unknown): ObjectiveControlHeadRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Malformed objective control head record");
  }
  const record = value as Row;
  return {
    version: 1,
    runId: String(record.runId),
    objectiveId: String(record.objectiveId),
    planId: String(record.planId),
    source: ObjectiveControlSourceSchema.parse(record.source),
    activeRevision: Number(record.activeRevision),
    latestSnapshotSequence: Number(record.latestSnapshotSequence),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  };
}

function parseObjectiveControlMutationRecord(value: unknown): ObjectiveControlMutationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Malformed objective control mutation record");
  }
  const record = value as Row;
  if (
    record.version !== 1
    || typeof record.mutationId !== "string"
    || typeof record.requestKey !== "string"
    || typeof record.planId !== "string"
    || typeof record.objectiveId !== "string"
    || typeof record.runId !== "string"
    || typeof record.expectedRevision !== "number"
    || !Number.isInteger(record.expectedRevision)
    || typeof record.resultingRevision !== "number"
    || !Number.isInteger(record.resultingRevision)
    || typeof record.snapshotSequence !== "number"
    || !Number.isInteger(record.snapshotSequence)
    || typeof record.revisionId !== "string"
    || typeof record.createdAt !== "string"
  ) {
    throw new Error("Malformed objective control mutation identity");
  }
  return {
    version: 1,
    mutationId: record.mutationId,
    requestKey: record.requestKey,
    planId: record.planId,
    objectiveId: record.objectiveId,
    runId: record.runId,
    expectedRevision: record.expectedRevision,
    resultingRevision: record.resultingRevision,
    snapshotSequence: record.snapshotSequence,
    revisionId: record.revisionId,
    mutation: parseObjectiveControlMutation(record.mutation),
    createdAt: record.createdAt,
  };
}

/**
 * Approval identity fields were added after the first objective schema. Older
 * record_json values are still valid durable history, so normalize the
 * missing fields deterministically before applying the current protocol
 * schema. A later resolution/update rewrites the record in the new shape.
 */
function parseObjectiveApproval(value: unknown): ObjectiveApprovalRecord {
  if (typeof value !== "object" || value === null) throw new Error("Invalid objective approval record");
  const record = value as Row;
  const id = typeof record.id === "string" ? record.id : "legacy-approval";
  const objectiveId = typeof record.objectiveId === "string" ? record.objectiveId : "legacy-objective";
  const kind = typeof record.kind === "string" ? record.kind : "approval";
  const taskId = typeof record.taskId === "string" ? record.taskId : "*";
  return ObjectiveApprovalRecordSchema.parse({
    ...record,
    operationId: record.operationId ?? `legacy-approval-operation-${id}`,
    requestHash: record.requestHash ?? `legacy-approval-request-${id}`,
    policyHash: record.policyHash ?? `legacy-approval-policy-${id}`,
    sideEffectClass: record.sideEffectClass ?? "local",
    canonicalTarget: record.canonicalTarget ?? `objective:${objectiveId}:${kind}:${taskId}`,
    capability: record.capability ?? null,
    expiresAt: record.expiresAt ?? null,
  });
}

function parseObjectiveAttention(value: unknown): ObjectiveAttentionRecord {
  return ObjectiveAttentionRecordSchema.parse(value);
}

function parseObjectiveAggregate(value: unknown): ObjectiveAggregateRecord {
  return ObjectiveAggregateRecordSchema.parse(value);
}

function parseObjectiveRevision(value: unknown): ObjectiveRevisionRecord {
  return ObjectiveRevisionRecordSchema.parse(value);
}

function parseObjectiveRunOccurrence(value: unknown): ObjectiveRunOccurrenceRecord {
  return ObjectiveRunOccurrenceRecordSchema.parse(value);
}

function objectiveOccurrenceOutcomeFromRun(run: ObjectiveRunRecord): ObjectiveOccurrenceOutcomeState {
  switch (run.state) {
    case "planning":
      return "queued";
    case "awaiting-approval":
      return "waiting";
    case "executing":
    case "evaluating":
    case "replanning":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
  }
}

function objectiveAggregateStateFromRuns(
  runs: readonly ObjectiveRunRecord[],
  current: ObjectiveAggregateRecord["state"],
): ObjectiveAggregateRecord["state"] {
  if (current === "abandoned" || current === "superseded") return current;
  if (runs.some((run) => run.state === "awaiting-approval" || run.state === "interrupted")) return "waiting";
  if (runs.some((run) => !["succeeded", "failed", "cancelled"].includes(run.state))) return "active";
  if (runs.length > 0 && runs.some((run) => run.state === "succeeded")) return "achieved";
  return current === "achieved" ? "achieved" : "active";
}

function assertObjectiveAttentionIdentity(
  existing: ObjectiveAttentionRecord,
  next: ObjectiveAttentionRecord,
): void {
  const mutable = new Set(["status", "resolution", "updatedAt"]);
  const left = existing as unknown as Record<string, unknown>;
  const right = next as unknown as Record<string, unknown>;
  for (const key of Object.keys(left)) {
    if (mutable.has(key)) continue;
    if (stableSerialize(left[key]) !== stableSerialize(right[key])) {
      throw new Error(`Objective attention identity is immutable: ${next.id}`);
    }
  }
}

function parseObjectiveArtifact(value: unknown): ObjectiveArtifactRecord {
  return ObjectiveArtifactRecordSchema.parse(value);
}

function parseObjectiveArtifactReview(value: unknown): ObjectiveArtifactReviewRecord {
  return ObjectiveArtifactReviewRecordSchema.parse(value);
}

function parseObjectiveArtifactReceipt(value: unknown): ObjectiveArtifactReceiptRecord {
  if (typeof value !== "object" || value === null) throw new Error("Invalid objective artifact receipt");
  const record = value as Row;
  if (record.version !== 1 || typeof record.requestKey !== "string" || typeof record.operation !== "string"
    || typeof record.fingerprint !== "string" || typeof record.runId !== "string"
    || typeof record.objectiveId !== "string" || typeof record.artifactId !== "string"
    || typeof record.createdAt !== "string") throw new Error("Invalid objective artifact receipt");
  return record as unknown as ObjectiveArtifactReceiptRecord;
}

function parseObjectiveHandoff(value: unknown): ObjectiveHandoffEnvelope {
  return ObjectiveHandoffEnvelopeSchema.parse(value);
}

function parseObjectiveHandoffAcceptance(value: unknown): ObjectiveHandoffAcceptanceRecord {
  return ObjectiveHandoffAcceptanceRecordSchema.parse(value);
}

export class SymphonyStore {
  readonly path: string;
  readonly database: DatabaseSync;
  readonly emitter = new EventEmitter();
  private transactionEvents: EventEnvelope[] | null = null;
  private readonly committedEventQueue: EventEnvelope[] = [];
  private deliveringCommittedEvents = false;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(this.path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.applyMigrations();
  }

  private applyMigrations(): void {
    this.database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    const has = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
    const insert = this.database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)");
    for (const migration of migrations) {
      if (has.get(migration.version)) continue;
      this.transaction(() => {
        this.database.exec(migration.sql);
        insert.run(migration.version, nowIso());
      });
    }
  }

  transaction<T>(callback: () => T): T {
    // Storage helpers compose inside higher-level idempotency transactions.
    // SQLite has no nested BEGIN, so the inner operation participates in the
    // existing atomic boundary and lets an error roll the outer transaction
    // back. This is required when a native terminal event updates both its
    // dedupe claim and the worker-process lease in one projection pass.
    if (this.database.isTransaction) return callback();
    this.database.exec("BEGIN IMMEDIATE");
    this.transactionEvents = [];
    let result: T;
    let committedEvents: EventEnvelope[];
    try {
      result = callback();
      this.database.exec("COMMIT");
      committedEvents = this.transactionEvents;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionEvents = null;
    }
    this.publishCommittedEvents(committedEvents);
    return result;
  }

  durableTransaction<T>(callback: () => T): T {
    // An outer transaction already owns the commit boundary and synchronous
    // mode cannot be changed while it is active.
    if (this.database.isTransaction) return callback();
    const row = this.database.prepare("PRAGMA synchronous").get() as Row;
    const previous = Number(row.synchronous ?? 1);
    this.database.exec("PRAGMA synchronous = FULL");
    try {
      return this.transaction(callback);
    } finally {
      this.database.exec(`PRAGMA synchronous = ${Number.isInteger(previous) ? previous : 1}`);
    }
  }

  close(): void {
    this.database.close();
  }

  appendEvent(
    input: Omit<EventEnvelope, "id" | "cursor"> & { id?: string },
    options: { persistedPayload?: JsonValue } = {},
  ): EventEnvelope {
    const id = input.id ?? ulid();
    const isWorkerEvent = input.provenance?.source === "driver" || input.provenance?.rawProvenance !== undefined;
    // A caller-supplied projection is useful for chat records, but it must not
    // be able to opt a provider event back into verbatim persistence.
    const persistedPayload = isWorkerEvent
      ? projectWorkerEventPayload(input.payload) as JsonValue
      : options.persistedPayload ?? input.payload;
    const provenance = isWorkerEvent && input.provenance?.rawProvenance
      ? {
        ...input.provenance,
        rawProvenance: {
          ...input.provenance.rawProvenance,
          payload: projectWorkerEventPayload(input.provenance.rawProvenance.payload) as JsonValue,
        },
      }
      : input.provenance;
    // Validate the complete event shape before touching SQLite. The cursor is
    // assigned by SQLite, so a non-negative placeholder is used for the
    // preflight and replaced with the committed rowid below. This keeps a
    // malformed event from leaving an orphaned row when parsing fails.
    EventEnvelopeSchema.parse({ ...input, id, cursor: 1, payload: persistedPayload, provenance });
    const result = this.database
      .prepare(
        `INSERT INTO events(id, type, workflow_id, run_id, agent_id, occurred_at, payload_json, provenance_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.workflowId,
        input.runId,
        input.agentId,
        input.occurredAt,
        serialize(persistedPayload),
        provenance ? serialize(provenance) : null,
      );
    const event = EventEnvelopeSchema.parse({ ...input, id, cursor: Number(result.lastInsertRowid), payload: persistedPayload, provenance });
    if (this.transactionEvents) this.transactionEvents.push(event);
    else this.publishCommittedEvents([event]);
    return event;
  }

  /**
   * Record a semantic objective event without publishing it yet. Callers use
   * this inside the same transaction as the objective acknowledgement; the
   * concrete event is delivered by drainObjectiveEventOutbox after commit.
   */
  appendObjectiveEventIntent(input: {
    eventKey: string;
    eventId: string;
    event: Omit<EventEnvelope, "id" | "cursor">;
  }): boolean {
    if (!input.eventKey || !input.eventId) throw new Error("Objective event intents require stable identities");
    const runId = input.event.runId;
    if (!runId) throw new Error("Objective event intents require a run id");
    const isWorkerEvent = input.event.provenance?.source === "driver" || input.event.provenance?.rawProvenance !== undefined;
    const persistedEvent = isWorkerEvent
      ? {
        ...input.event,
        payload: projectWorkerEventPayload(input.event.payload) as JsonValue,
        ...(input.event.provenance?.rawProvenance ? {
          provenance: {
            ...input.event.provenance,
            rawProvenance: {
              ...input.event.provenance.rawProvenance,
              payload: projectWorkerEventPayload(input.event.provenance.rawProvenance.payload) as JsonValue,
            },
          },
        } : {}),
      }
      : input.event;
    // Validate the event shape before it enters the outbox. Cursor 1 is only a
    // schema placeholder; the real cursor is assigned when the event is
    // inserted into the authoritative event log.
    const event = EventEnvelopeSchema.parse({ ...persistedEvent, id: input.eventId, cursor: 1 });
    const record: ObjectiveEventOutboxRecord = {
      version: 1,
      eventKey: input.eventKey,
      eventId: input.eventId,
      runId,
      state: "pending",
      event: withoutEventIdentity(event),
      createdAt: event.occurredAt,
      publishedAt: null,
    };
    return this.transaction(() => {
      const collisions = [
        this.database.prepare("SELECT record_json FROM objective_event_outbox WHERE event_key = ?").get(record.eventKey) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_event_outbox WHERE event_id = ?").get(record.eventId) as Row | undefined,
      ].filter((row): row is Row => row !== undefined);
      if (collisions.length > 0) {
        if (collisions.every((row) => objectiveEventOutboxEquivalent(parseObjectiveEventOutbox(parseJson(row.record_json)), record))) return false;
        throw new Error(`Objective semantic event intent identity conflict: ${record.eventKey}`);
      }
      const result = this.database
        .prepare(
          `INSERT INTO objective_event_outbox(
             event_key, event_id, run_id, state, record_json, created_at, published_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.eventKey,
          record.eventId,
          record.runId,
          record.state,
          serialize(record),
          record.createdAt,
          record.publishedAt,
        );
      return Number(result.changes) === 1;
    });
  }

  getObjectiveEventOutbox(eventKey: string): ObjectiveEventOutboxRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_event_outbox WHERE event_key = ?")
      .get(eventKey) as Row | undefined;
    return row ? parseObjectiveEventOutbox(parseJson(row.record_json)) : null;
  }

  listObjectiveEventOutbox(options: { state?: ObjectiveEventOutboxRecord["state"]; limit?: number } = {}): ObjectiveEventOutboxRecord[] {
    const limit = Math.min(options.limit ?? 500, 5_000);
    const rows = options.state
      ? this.database
        .prepare("SELECT record_json FROM objective_event_outbox WHERE state = ? ORDER BY created_at ASC, event_key ASC LIMIT ?")
        .all(options.state, limit) as Row[]
      : this.database
        .prepare("SELECT record_json FROM objective_event_outbox ORDER BY created_at ASC, event_key ASC LIMIT ?")
        .all(limit) as Row[];
    return rows.map((row) => parseObjectiveEventOutbox(parseJson(row.record_json)));
  }

  /**
   * Deliver pending objective events in creation order. Each bounded batch's
   * event inserts and outbox state transitions share one SQLite transaction.
   * Replaying after a crash is therefore safe whether the event insert or the
   * state update had reached durable storage before the process stopped.
   */
  drainObjectiveEventOutbox(options: { batchSize?: number } = {}): number {
    const batchSize = Math.max(1, Math.min(options.batchSize ?? 500, 5_000));
    let delivered = 0;
    // Re-read the queue after each bounded batch. This avoids stranding the
    // 501st (or later) entry when a daemon restarts with a large backlog, while
    // keeping each query/commit batch finite for responsive recovery.
    while (true) {
      const pending = this.listObjectiveEventOutbox({ state: "pending", limit: batchSize });
      if (pending.length === 0) return delivered;
      const changed = this.durableTransaction(() => {
        let batchDelivered = 0;
        for (const item of pending) {
          const current = this.getObjectiveEventOutbox(item.eventKey);
          if (!current || current.state === "published") continue;
          const existing = this.eventById(current.eventId);
          if (existing) {
            if (!objectiveEventMatches(existing, current)) {
              throw new Error(`Objective semantic event id is bound to different evidence: ${current.eventId}`);
            }
          } else {
            this.appendEvent({ ...current.event, id: current.eventId });
          }
          const publishedAt = nowIso();
          const next: ObjectiveEventOutboxRecord = { ...current, state: "published", publishedAt };
          const result = this.database
            .prepare(
              `UPDATE objective_event_outbox SET state = ?, record_json = ?, published_at = ?
               WHERE event_key = ? AND state = 'pending'`,
            )
            .run(next.state, serialize(next), next.publishedAt, next.eventKey);
          if (Number(result.changes) === 1) batchDelivered += 1;
        }
        return batchDelivered;
      });
      delivered += changed;
    }
  }

  private publishCommittedEvents(events: readonly EventEnvelope[]): void {
    this.committedEventQueue.push(...events);
    if (this.deliveringCommittedEvents) return;
    this.deliveringCommittedEvents = true;
    try {
      while (this.committedEventQueue.length > 0) {
        this.emitter.emit("event", this.committedEventQueue.shift() as EventEnvelope);
      }
    } finally {
      this.deliveringCommittedEvents = false;
    }
  }

  private eventById(id: string): EventEnvelope | null {
    const row = this.database.prepare("SELECT * FROM events WHERE id = ?").get(id) as Row | undefined;
    return row ? parseStoredEvent(row) : null;
  }

  claimNativeDriverEvent(input: {
    agentId: string;
    eventKind: string;
    nativeEventId: string;
    claimedAt?: string;
  }): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO native_driver_events(agent_id, event_kind, native_event_id, claimed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.agentId, input.eventKind, input.nativeEventId, input.claimedAt ?? nowIso());
    return Number(result.changes) === 1;
  }

  onEvent(listener: (event: EventEnvelope) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  latestCursor(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM events").get() as Row;
    return Number(row.cursor ?? 0);
  }

  getEventById(id: string): EventEnvelope | null {
    const row = this.database.prepare("SELECT * FROM events WHERE id = ?").get(id) as Row | undefined;
    return row ? parseStoredEvent(row) : null;
  }

  eventsAfter(cursor: number, options: { limit?: number; agentId?: string; runId?: string; types?: readonly string[]; typePrefixes?: readonly string[] } = {}): EventEnvelope[] {
    const limit = Math.min(options.limit ?? 1_000, 10_000);
    let sql = "SELECT * FROM events WHERE cursor > ?";
    const params: Array<string | number> = [cursor];
    if (options.agentId) {
      sql += " AND agent_id = ?";
      params.push(options.agentId);
    }
    if (options.runId) {
      sql += " AND run_id = ?";
      params.push(options.runId);
    }
    const typeClauses: string[] = [];
    if (options.types?.length) {
      typeClauses.push(`type IN (${options.types.map(() => "?").join(",")})`);
      params.push(...options.types);
    }
    if (options.typePrefixes?.length) {
      typeClauses.push(...options.typePrefixes.map(() => "type LIKE ?"));
      params.push(...options.typePrefixes.map((prefix) => `${prefix}%`));
    }
    if (typeClauses.length) sql += ` AND (${typeClauses.join(" OR ")})`;
    sql += " ORDER BY cursor ASC LIMIT ?";
    params.push(limit);
    return (this.database.prepare(sql).all(...params) as Row[]).map(parseStoredEvent);
  }

  recentEvents(options: { limit?: number; agentId?: string; runId?: string; types?: readonly string[]; typePrefixes?: readonly string[] } = {}): EventEnvelope[] {
    const limit = Math.min(options.limit ?? 500, 10_000);
    let sql = "SELECT * FROM events";
    const params: Array<string | number> = [];
    const clauses: string[] = [];
    if (options.agentId) {
      clauses.push("agent_id = ?");
      params.push(options.agentId);
    }
    if (options.runId) {
      clauses.push("run_id = ?");
      params.push(options.runId);
    }
    const typeClauses: string[] = [];
    if (options.types?.length) {
      typeClauses.push(`type IN (${options.types.map(() => "?").join(",")})`);
      params.push(...options.types);
    }
    if (options.typePrefixes?.length) {
      typeClauses.push(...options.typePrefixes.map(() => "type LIKE ?"));
      params.push(...options.typePrefixes.map((prefix) => `${prefix}%`));
    }
    if (typeClauses.length) clauses.push(`(${typeClauses.join(" OR ")})`);
    if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY cursor DESC LIMIT ?";
    params.push(limit);
    return (this.database.prepare(sql).all(...params) as Row[]).reverse().map(parseStoredEvent);
  }

  saveWorkflow(record: WorkflowRevisionRecord): void {
    this.database
      .prepare(
        `INSERT INTO workflow_revisions(workflow_id, revision, hash, record_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workflow_id, revision) DO UPDATE SET hash=excluded.hash, record_json=excluded.record_json`,
      )
      .run(record.id, record.revision, record.hash, serialize(record), record.createdAt);
  }

  getWorkflow(id: string, revision?: number): WorkflowRevisionRecord | null {
    const row = revision
      ? this.database.prepare("SELECT record_json FROM workflow_revisions WHERE workflow_id = ? AND revision = ?").get(id, revision)
      : this.database
          .prepare("SELECT record_json FROM workflow_revisions WHERE workflow_id = ? ORDER BY revision DESC LIMIT 1")
          .get(id);
    return row ? parseJson<WorkflowRevisionRecord>((row as Row).record_json) : null;
  }

  listWorkflows(): WorkflowRevisionRecord[] {
    return (this.database
      .prepare(
        `SELECT w.record_json FROM workflow_revisions w
         JOIN (SELECT workflow_id, MAX(revision) revision FROM workflow_revisions GROUP BY workflow_id) latest
         ON latest.workflow_id = w.workflow_id AND latest.revision = w.revision
         ORDER BY w.created_at DESC`,
      )
      .all() as Row[]).map((row) => parseJson<WorkflowRevisionRecord>(row.record_json));
  }

  saveRun(record: WorkflowRunRecord): void {
    this.database
      .prepare(
        `INSERT INTO workflow_runs(id, workflow_id, workflow_revision, status, record_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, record_json=excluded.record_json, updated_at=excluded.updated_at`,
      )
      .run(record.id, record.workflowId, record.workflowRevision, record.status, serialize(record), record.updatedAt);
  }

  getRun(id: string): WorkflowRunRecord | null {
    const row = this.database.prepare("SELECT record_json FROM workflow_runs WHERE id = ?").get(id) as Row | undefined;
    return row ? parseJson<WorkflowRunRecord>(row.record_json) : null;
  }

  listRuns(options: WorkflowRunListOptions & { limit?: number } = {}): WorkflowRunRecord[] {
    return this.listRunPage({ ...options, limit: options.limit ?? 200 }).runs;
  }

  /**
   * Read workflow runs with a keyset cursor rather than an offset or a fixed
   * global cap. Recovery uses this to reconcile every non-terminal run, even
   * when a durable store contains more than the normal API page size.
   */
  listRunPage(
    options: WorkflowRunListOptions & { cursor?: WorkflowRunListCursor; limit?: number } = {},
  ): { runs: WorkflowRunRecord[]; nextCursor: WorkflowRunListCursor | null } {
    let sql = "SELECT record_json FROM workflow_runs WHERE 1 = 1";
    const params: Array<string | number> = [];
    if (options.status?.length) {
      sql += ` AND status IN (${options.status.map(() => "?").join(",")})`;
      params.push(...options.status);
    }
    if (options.cursor) {
      sql += " AND (updated_at < ? OR (updated_at = ? AND id < ?))";
      params.push(options.cursor.updatedAt, options.cursor.updatedAt, options.cursor.id);
    }
    const limit = Math.max(1, Math.min(options.limit ?? 1_000, 2_000));
    sql += " ORDER BY updated_at DESC, id DESC LIMIT ?";
    params.push(limit + 1);
    const rows = this.database.prepare(sql).all(...params) as Row[];
    const hasMore = rows.length > limit;
    const runs = rows.slice(0, limit).map((row) => parseJson<WorkflowRunRecord>(row.record_json));
    const last = runs.at(-1);
    return {
      runs,
      nextCursor: hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
    };
  }

  /**
   * Persist the current plan overlay. When an expected revision is supplied,
   * update only if the stored revision still matches it; the workflow layer
   * can use the boolean result as its compare-and-swap fence.
   *
   * Without an expected revision this is an initialization path and refuses to
   * overwrite an existing plan. Workflow mutations should use the CAS form
   * once a plan exists, so a stale writer cannot clobber a concurrent append.
   */
  saveWorkflowRunPlan(record: WorkflowRunPlanRecord, options: { expectedPlanRevision?: number } = {}): boolean {
    if (options.expectedPlanRevision === undefined) {
      const result = this.database
        .prepare(
          `INSERT OR IGNORE INTO workflow_run_plans(
             run_id, workflow_id, workflow_revision, workflow_hash, plan_revision,
             steps_json, record_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.runId,
          record.workflowId,
          record.workflowRevision,
          record.workflowHash,
          record.planRevision,
          serialize(record.steps),
          serialize(record),
          record.createdAt,
          record.updatedAt,
        );
      return result.changes === 1;
    }
    const result = this.database
      .prepare(
        `UPDATE workflow_run_plans SET
           workflow_id = ?, workflow_revision = ?, workflow_hash = ?, plan_revision = ?,
           steps_json = ?, record_json = ?, updated_at = ?
         WHERE run_id = ? AND plan_revision = ?`,
      )
      .run(
        record.workflowId,
        record.workflowRevision,
        record.workflowHash,
        record.planRevision,
        serialize(record.steps),
        serialize(record),
        record.updatedAt,
        record.runId,
        options.expectedPlanRevision,
      );
    return result.changes === 1;
  }

  getWorkflowRunPlan(runId: string): WorkflowRunPlanRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM workflow_run_plans WHERE run_id = ?")
      .get(runId) as Row | undefined;
    return row ? parseJson<WorkflowRunPlanRecord>(row.record_json) : null;
  }

  listWorkflowRunPlans(options: { workflowId?: string; limit?: number } = {}): WorkflowRunPlanRecord[] {
    const limit = Math.min(options.limit ?? 200, 2_000);
    const rows = options.workflowId
      ? this.database
          .prepare("SELECT record_json FROM workflow_run_plans WHERE workflow_id = ? ORDER BY updated_at DESC LIMIT ?")
          .all(options.workflowId, limit) as Row[]
      : this.database
          .prepare("SELECT record_json FROM workflow_run_plans ORDER BY updated_at DESC LIMIT ?")
          .all(limit) as Row[];
    return rows.map((row) => parseJson<WorkflowRunPlanRecord>(row.record_json));
  }

  /** Insert once by idempotency key; returns false for an already-recorded mutation. */
  saveWorkflowPlanMutation(record: WorkflowPlanMutationRecord): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO workflow_plan_mutations(
           idempotency_key, run_id, author_agent_id, expected_plan_revision,
           resulting_plan_revision, operation, steps_json, reason, record_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.idempotencyKey,
        record.runId,
        record.authorAgentId,
        record.expectedPlanRevision,
        record.resultingPlanRevision,
        record.operation,
        serialize(record.steps),
        record.reason,
        serialize(record),
        record.createdAt,
      );
    return result.changes === 1;
  }

  getWorkflowPlanMutation(idempotencyKey: string): WorkflowPlanMutationRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM workflow_plan_mutations WHERE idempotency_key = ?")
      .get(idempotencyKey) as Row | undefined;
    return row ? parseJson<WorkflowPlanMutationRecord>(row.record_json) : null;
  }

  listWorkflowPlanMutations(options: { runId?: string; limit?: number } = {}): WorkflowPlanMutationRecord[] {
    const limit = Math.min(options.limit ?? 200, 2_000);
    const rows = options.runId
      ? this.database
          .prepare("SELECT record_json FROM workflow_plan_mutations WHERE run_id = ? ORDER BY created_at ASC LIMIT ?")
          .all(options.runId, limit) as Row[]
      : this.database
          .prepare("SELECT record_json FROM workflow_plan_mutations ORDER BY created_at ASC LIMIT ?")
          .all(limit) as Row[];
    return rows.map((row) => parseJson<WorkflowPlanMutationRecord>(row.record_json));
  }

  /**
   * Insert an objective run once. Objective/workflow identity and the request
   * key are immutable for the lifetime of a run; callers update a run through
   * updateObjectiveRun, which requires the active-plan CAS revision.
   */
  saveObjectiveRun(record: ObjectiveRunRecord): boolean {
    const parsed = ObjectiveRunRecordSchema.parse(record);
    assertObjectiveRunPolicy(parsed);
    const existing = this.getObjectiveRun(parsed.runId);
    if (existing) {
      assertObjectiveRunIdentity(existing, parsed);
      return false;
    }
    // Older runtime callers persisted only ObjectiveRunRecord. Import that
    // authoritative intent once so upgrading a local store does not make the
    // objective aggregate disappear merely because its first run predates the
    // aggregate tables.
    this.bootstrapObjectiveAggregateForRun(parsed);
    const requestCollision = this.database
      .prepare("SELECT run_id FROM objective_runs WHERE request_key = ?")
      .get(parsed.requestKey);
    if (requestCollision) throw new Error(`Objective run request key already belongs to another run: ${parsed.requestKey}`);
    const result = this.database
      .prepare(
        `INSERT INTO objective_runs(
           run_id, objective_id, workflow_id, workflow_revision, workflow_hash,
           state, active_plan_revision, latest_checkpoint_id, request_key,
           record_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.runId,
        parsed.objectiveId,
        parsed.workflowId,
        parsed.workflowRevision,
        parsed.workflowHash,
        parsed.state,
        parsed.activePlanRevision,
        parsed.latestCheckpointId,
        parsed.requestKey,
        serialize(parsed),
        parsed.createdAt,
        parsed.updatedAt,
      );
    if (Number(result.changes) === 1) this.refreshObjectiveAggregate(parsed.objectiveId);
    return Number(result.changes) === 1;
  }

  private bootstrapObjectiveAggregateForRun(run: ObjectiveRunRecord): void {
    const existing = this.getObjectiveAggregate(run.objectiveId);
    const workspace = run.policy?.workspace ?? null;
    const revision = run.objectiveRevision ?? existing?.activeRevision ?? 1;
    if (!existing) {
      const aggregate = ObjectiveAggregateRecordSchema.parse({
        version: 1,
        id: `objective:${run.objectiveId}`,
        objectiveId: run.objectiveId,
        activeRevision: revision,
        spec: run.spec,
        statement: run.spec.statement,
        criteria: run.spec.criteria,
        state: "active",
        latestRunId: null,
        latestOutcome: null,
        workspace,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
      this.saveObjectiveAggregate(aggregate);
    }
    if (!this.getObjectiveRevision(run.objectiveId, revision)) {
      const history = ObjectiveRevisionRecordSchema.parse({
        version: 1,
        id: `objective-revision:${run.objectiveId}:${revision}`,
        objectiveId: run.objectiveId,
        revision,
        spec: run.spec,
        workspace,
        createdBy: { type: "system", id: "legacy-objective-import" },
        requestKey: `${run.requestKey}:objective-revision:${revision}`,
        createdAt: run.createdAt,
      });
      this.saveObjectiveRevision(history);
    }
  }

  getObjectiveRun(runId: string): ObjectiveRunRecord | null {
    const row = this.database.prepare("SELECT record_json FROM objective_runs WHERE run_id = ?").get(runId) as Row | undefined;
    return row ? parseObjectiveRun(parseJson(row.record_json)) : null;
  }

  /** Read the captured policy without manufacturing one for legacy runs. */
  getObjectivePolicySnapshot(runId: string): ObjectivePolicySnapshot | null {
    const run = this.getObjectiveRun(runId);
    if (!run?.policy) return null;
    return ObjectivePolicySnapshotSchema.parse(run.policy);
  }

  getObjectiveRunByRequestKey(requestKey: string): ObjectiveRunRecord | null {
    const row = this.database.prepare("SELECT record_json FROM objective_runs WHERE request_key = ?").get(requestKey) as Row | undefined;
    return row ? parseObjectiveRun(parseJson(row.record_json)) : null;
  }

  listObjectiveRuns(options: { state?: ObjectiveRunRecord["state"][]; objectiveId?: string; limit?: number } = {}): ObjectiveRunRecord[] {
    const limit = Math.min(options.limit ?? 200, 2_000);
    if (options.state?.length || options.objectiveId) {
      const clauses: string[] = [];
      const args: SQLInputValue[] = [];
      if (options.state?.length) {
        const placeholders = options.state.map(() => "?").join(",");
        clauses.push(`state IN (${placeholders})`);
        args.push(...options.state);
      }
      if (options.objectiveId) {
        clauses.push("objective_id = ?");
        args.push(options.objectiveId);
      }
      return (this.database
        .prepare(`SELECT record_json FROM objective_runs WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`)
        .all(...args, limit) as Row[])
        .map((row) => parseObjectiveRun(parseJson(row.record_json)));
    }
    return (this.database.prepare("SELECT record_json FROM objective_runs ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[]).map(
      (row) => parseObjectiveRun(parseJson(row.record_json)),
    );
  }

  /**
   * Insert an objective identity once. A repeated identity is a deterministic
   * no-op; a changed aggregate is rejected by the caller's immutable revision
   * fence rather than silently replacing mission history.
   */
  saveObjectiveAggregate(record: ObjectiveAggregateRecord): boolean {
    const parsed = parseObjectiveAggregate(record);
    return this.transaction(() => {
      const existing = this.getObjectiveAggregate(parsed.objectiveId);
      if (existing) {
        if (stableSerialize(existing) === stableSerialize(parsed)) return false;
        if (existing.id !== parsed.id) throw new Error(`Objective aggregate identity conflict: ${parsed.objectiveId}`);
        if (
          existing.activeRevision > parsed.activeRevision
          || stableSerialize(existing.workspace) !== stableSerialize(parsed.workspace)
        ) throw new Error(`Objective aggregate update would rewrite immutable identity: ${parsed.objectiveId}`);
        if (existing.activeRevision === parsed.activeRevision && (
          stableSerialize(existing.spec) !== stableSerialize(parsed.spec)
          || stableSerialize(existing.statement) !== stableSerialize(parsed.statement)
          || stableSerialize(existing.criteria) !== stableSerialize(parsed.criteria)
          || stableSerialize(existing.policy) !== stableSerialize(parsed.policy)
        )) throw new Error(`Objective aggregate mission is immutable within revision ${parsed.objectiveId}/${parsed.activeRevision}`);
        if (parsed.activeRevision > existing.activeRevision && !this.getObjectiveRevision(parsed.objectiveId, parsed.activeRevision)) {
          throw new Error(`Objective aggregate revision is missing immutable history: ${parsed.objectiveId}/${parsed.activeRevision}`);
        }
        const result = this.database.prepare(
          `UPDATE objective_aggregates SET active_revision = ?, state = ?, latest_run_id = ?, latest_outcome = ?, workspace_json = ?, record_json = ?, updated_at = ? WHERE objective_id = ?`,
        ).run(
          parsed.activeRevision,
          parsed.state,
          parsed.latestRunId,
          parsed.latestOutcome,
          parsed.workspace === null ? null : serialize(parsed.workspace),
          serialize(parsed),
          parsed.updatedAt,
          parsed.objectiveId,
        );
        return Number(result.changes) === 1;
      }
      const result = this.database.prepare(
        `INSERT INTO objective_aggregates(id, objective_id, active_revision, state, latest_run_id, latest_outcome, workspace_json, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        parsed.id,
        parsed.objectiveId,
        parsed.activeRevision,
        parsed.state,
        parsed.latestRunId,
        parsed.latestOutcome,
        parsed.workspace === null ? null : serialize(parsed.workspace),
        serialize(parsed),
        parsed.createdAt,
        parsed.updatedAt,
      );
      return Number(result.changes) === 1;
    });
  }

  getObjectiveAggregate(objectiveId: string): ObjectiveAggregateRecord | null {
    const row = this.database.prepare("SELECT record_json FROM objective_aggregates WHERE objective_id = ?").get(objectiveId) as Row | undefined;
    return row ? parseObjectiveAggregate(parseJson(row.record_json)) : null;
  }

  /** Compatibility aliases for callers that use the aggregate's short name. */
  getObjective(objectiveId: string): ObjectiveAggregateRecord | null {
    return this.getObjectiveAggregate(objectiveId);
  }

  saveObjective(record: ObjectiveAggregateRecord): boolean {
    return this.saveObjectiveAggregate(record);
  }

  listObjectiveAggregates(options: { state?: ObjectiveAggregateRecord["state"][]; limit?: number } = {}): ObjectiveAggregateRecord[] {
    const limit = Math.min(options.limit ?? 200, 2_000);
    if (options.state?.length) {
      const placeholders = options.state.map(() => "?").join(",");
      return (this.database.prepare(`SELECT record_json FROM objective_aggregates WHERE state IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`).all(...options.state, limit) as Row[])
        .map((row) => parseObjectiveAggregate(parseJson(row.record_json)));
    }
    return (this.database.prepare("SELECT record_json FROM objective_aggregates ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[])
      .map((row) => parseObjectiveAggregate(parseJson(row.record_json)));
  }

  /** Append one immutable objective mission revision. */
  saveObjectiveRevision(record: ObjectiveRevisionRecord): boolean {
    const parsed = parseObjectiveRevision(record);
    return this.transaction(() => {
      const aggregate = this.getObjectiveAggregate(parsed.objectiveId);
      if (!aggregate) throw new Error(`Cannot save a revision for missing objective aggregate: ${parsed.objectiveId}`);
      const collisions = [
        this.database.prepare("SELECT record_json FROM objective_revisions WHERE id = ?").get(parsed.id) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_revisions WHERE objective_id = ? AND revision = ?").get(parsed.objectiveId, parsed.revision) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_revisions WHERE objective_id = ? AND request_key = ?").get(parsed.objectiveId, parsed.requestKey) as Row | undefined,
      ].filter((row): row is Row => Boolean(row));
      if (collisions.length > 0) {
        if (collisions.every((row) => stableSerialize(parseObjectiveRevision(parseJson(row.record_json))) === stableSerialize(parsed))) return false;
        throw new Error(`Objective revision idempotency conflict: ${parsed.objectiveId}/${parsed.revision}`);
      }
      if (parsed.revision !== aggregate.activeRevision && parsed.revision !== aggregate.activeRevision + 1) {
        throw new Error(`Objective revisions must append from the aggregate active revision: ${parsed.objectiveId}/${parsed.revision}`);
      }
      const result = this.database.prepare(
        `INSERT INTO objective_revisions(id, objective_id, revision, request_key, workspace_json, record_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(parsed.id, parsed.objectiveId, parsed.revision, parsed.requestKey, parsed.workspace === null ? null : serialize(parsed.workspace), serialize(parsed), parsed.createdAt);
      return Number(result.changes) === 1;
    });
  }

  getObjectiveRevision(objectiveId: string, revision: number): ObjectiveRevisionRecord | null {
    const row = this.database.prepare("SELECT record_json FROM objective_revisions WHERE objective_id = ? AND revision = ?").get(objectiveId, revision) as Row | undefined;
    return row ? parseObjectiveRevision(parseJson(row.record_json)) : null;
  }

  listObjectiveRevisions(objectiveId: string): ObjectiveRevisionRecord[] {
    return (this.database.prepare("SELECT record_json FROM objective_revisions WHERE objective_id = ? ORDER BY revision ASC").all(objectiveId) as Row[])
      .map((row) => parseObjectiveRevision(parseJson(row.record_json)));
  }

  /** Insert or replay the causal occurrence for a run under an objective. */
  saveObjectiveRunOccurrence(record: ObjectiveRunOccurrenceRecord): boolean {
    const parsed = parseObjectiveRunOccurrence(record);
    return this.transaction(() => {
      const aggregate = this.getObjectiveAggregate(parsed.objectiveId);
      if (!aggregate) throw new Error(`Cannot save an occurrence for missing objective aggregate: ${parsed.objectiveId}`);
      if (!this.getObjectiveRevision(parsed.objectiveId, parsed.objectiveRevision)) {
        throw new Error(`Objective occurrence references missing revision: ${parsed.objectiveId}/${parsed.objectiveRevision}`);
      }
      const collisions = [
        this.database.prepare("SELECT record_json FROM objective_run_occurrences WHERE id = ?").get(parsed.id) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_run_occurrences WHERE run_id = ?").get(parsed.runId) as Row | undefined,
        parsed.occurrenceKey === null ? undefined : this.database.prepare("SELECT record_json FROM objective_run_occurrences WHERE objective_id = ? AND occurrence_key = ?").get(parsed.objectiveId, parsed.occurrenceKey) as Row | undefined,
      ].filter((row): row is Row => Boolean(row));
      if (collisions.length > 0) {
        if (collisions.every((row) => stableSerialize(parseObjectiveRunOccurrence(parseJson(row.record_json))) === stableSerialize(parsed))) return false;
        throw new Error(`Objective run occurrence idempotency conflict: ${parsed.objectiveId}/${parsed.runId}`);
      }
      const result = this.database.prepare(
        `INSERT INTO objective_run_occurrences(id, objective_id, run_id, objective_revision, kind, occurrence_key, trigger_id, parent_occurrence_id, parent_run_id, forked_from_occurrence_id, forked_from_run_id, supersedes_occurrence_id, supersedes_run_id, outcome, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        parsed.id, parsed.objectiveId, parsed.runId, parsed.objectiveRevision, parsed.kind, parsed.occurrenceKey, parsed.triggerId,
        parsed.parentOccurrenceId, parsed.parentRunId, parsed.forkedFromOccurrenceId, parsed.forkedFromRunId,
        parsed.supersedesOccurrenceId, parsed.supersedesRunId, parsed.outcome, serialize(parsed), parsed.createdAt, parsed.updatedAt,
      );
      if (Number(result.changes) === 1) this.refreshObjectiveAggregate(parsed.objectiveId);
      return Number(result.changes) === 1;
    });
  }

  getObjectiveRunOccurrence(runId: string): ObjectiveRunOccurrenceRecord | null {
    const row = this.database.prepare("SELECT record_json FROM objective_run_occurrences WHERE run_id = ?").get(runId) as Row | undefined;
    return row ? parseObjectiveRunOccurrence(parseJson(row.record_json)) : null;
  }

  saveObjectiveOccurrence(record: ObjectiveRunOccurrenceRecord): boolean {
    return this.saveObjectiveRunOccurrence(record);
  }

  getObjectiveOccurrence(runId: string): ObjectiveRunOccurrenceRecord | null {
    return this.getObjectiveRunOccurrence(runId);
  }

  getObjectiveRunOccurrenceById(id: string): ObjectiveRunOccurrenceRecord | null {
    const row = this.database.prepare("SELECT record_json FROM objective_run_occurrences WHERE id = ?").get(id) as Row | undefined;
    return row ? parseObjectiveRunOccurrence(parseJson(row.record_json)) : null;
  }

  listObjectiveRunOccurrences(objectiveId: string): ObjectiveRunOccurrenceRecord[] {
    return (this.database.prepare("SELECT record_json FROM objective_run_occurrences WHERE objective_id = ? ORDER BY created_at ASC, id ASC").all(objectiveId) as Row[])
      .map((row) => parseObjectiveRunOccurrence(parseJson(row.record_json)));
  }

  listObjectiveOccurrences(objectiveId: string): ObjectiveRunOccurrenceRecord[] {
    return this.listObjectiveRunOccurrences(objectiveId);
  }

  /** Update only the mutable outcome projection of one occurrence. */
  updateObjectiveRunOccurrenceFromRun(run: ObjectiveRunRecord): ObjectiveRunOccurrenceRecord | null {
    return this.transaction(() => {
      const current = this.getObjectiveRunOccurrence(run.runId);
      if (!current) return null;
      const outcome = objectiveOccurrenceOutcomeFromRun(run);
      const next = parseObjectiveRunOccurrence({
        ...current,
        outcome,
        output: run.output,
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        updatedAt: run.updatedAt,
      });
      if (stableSerialize(current) === stableSerialize(next)) return current;
      const result = this.database.prepare(
        `UPDATE objective_run_occurrences SET outcome = ?, record_json = ?, updated_at = ? WHERE id = ? AND updated_at = ?`,
      ).run(next.outcome, serialize(next), next.updatedAt, current.id, current.updatedAt);
      if (Number(result.changes) !== 1) throw new Error(`Objective occurrence update lost its CAS race: ${run.runId}`);
      return next;
    });
  }

  markObjectiveRunOccurrenceSuperseded(id: string, updatedAt = nowIso()): ObjectiveRunOccurrenceRecord | null {
    return this.transaction(() => {
      const current = this.getObjectiveRunOccurrenceById(id);
      if (!current) return null;
      if (current.outcome === "superseded") return current;
      const next = parseObjectiveRunOccurrence({ ...current, outcome: "superseded", updatedAt });
      const result = this.database.prepare(
        `UPDATE objective_run_occurrences SET outcome = ?, record_json = ?, updated_at = ? WHERE id = ? AND updated_at = ?`,
      ).run(next.outcome, serialize(next), next.updatedAt, current.id, current.updatedAt);
      if (Number(result.changes) !== 1) throw new Error(`Objective occurrence supersede lost its CAS race: ${id}`);
      return next;
    });
  }

  /**
   * Reconcile the aggregate's mutable outcome fields from authoritative runs.
   * Mission identity and active revision are never inferred from a chat or a
   * run, and are left untouched by this projection helper.
   */
  refreshObjectiveAggregate(objectiveId: string): ObjectiveAggregateRecord | null {
    return this.transaction(() => {
      const aggregate = this.getObjectiveAggregate(objectiveId);
      if (!aggregate) return null;
      const runs = this.listObjectiveRuns({ objectiveId, limit: 2_000 });
      const latest = [...runs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.runId.localeCompare(left.runId))[0] ?? null;
      const occurrences = this.listObjectiveRunOccurrences(objectiveId);
      const latestOccurrence = [...occurrences].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0] ?? null;
      const next = parseObjectiveAggregate({
        ...aggregate,
        state: objectiveAggregateStateFromRuns(runs, aggregate.state),
        latestRunId: latest?.runId ?? aggregate.latestRunId,
        latestOutcome: latestOccurrence?.outcome ?? (latest ? objectiveOccurrenceOutcomeFromRun(latest) : aggregate.latestOutcome),
        updatedAt: latest?.updatedAt ?? aggregate.updatedAt,
      });
      if (stableSerialize(next) === stableSerialize(aggregate)) return aggregate;
      this.database.prepare(
        `UPDATE objective_aggregates SET state = ?, latest_run_id = ?, latest_outcome = ?, record_json = ?, updated_at = ? WHERE objective_id = ?`,
      ).run(next.state, next.latestRunId, next.latestOutcome, serialize(next), next.updatedAt, objectiveId);
      return next;
    });
  }

  /**
   * Assemble the complete objective workspace read model under one SQLite
   * transaction. Every child collection is read through this connection while
   * the event high-water mark is held, so clients can resume from one cursor.
   */
  objectiveAggregateSnapshot(objectiveId: string, options: { eventLimit?: number } = {}): ObjectiveAggregateSnapshot | null {
    return this.transaction(() => {
      const aggregate = this.refreshObjectiveAggregate(objectiveId) ?? this.getObjectiveAggregate(objectiveId);
      if (!aggregate) return null;
      const eventCursor = this.latestCursor();
      const revisions = this.listObjectiveRevisions(objectiveId);
      const occurrences = this.listObjectiveRunOccurrences(objectiveId);
      const runs = this.listObjectiveRuns({ objectiveId, limit: 2_000 });
      const runIds = new Set(runs.map((run) => run.runId));
      // Step attempts are part of the frozen aggregate input. Keeping them in
      // this same transaction lets the semantic projector preserve attempt
      // lineage without joining a second, potentially newer read.
      const attempts = runs.flatMap((run) => this.listStepAttempts(run.runId));
      const currentRuns = runs.filter((run) => !["succeeded", "failed", "cancelled"].includes(run.state));
      const heads = runs.flatMap((run) => {
        const head = this.getObjectiveControlHead(run.runId);
        return head ? [head] : [];
      });
      const planRevisions = runs.flatMap((run) => this.listObjectiveControlPlanRevisions(run.runId));
      const planSnapshots = runs.flatMap((run) => this.listObjectiveControlSnapshots(run.runId));
      const legacyPlanRevisions = runs.flatMap((run) => this.listObjectivePlanRevisions(run.runId));
      const checkpoints = runs.flatMap((run) => this.listObjectiveCheckpoints(run.runId));
      const approvals = runs.flatMap((run) => this.listObjectiveApprovals({ runId: run.runId, limit: 2_000 }));
      const attentions = runs.flatMap((run) => this.listObjectiveAttentions({ runId: run.runId, limit: 2_000 }));
      const artifacts = runs.flatMap((run) => this.listObjectiveArtifacts({ runId: run.runId, limit: 2_000 }));
      const artifactReviews = artifacts.flatMap((artifact) => this.listObjectiveArtifactReviews(artifact.id));
      const ledgers = runs.flatMap((run) => {
        const ledger = this.getObjectiveBudgetLedger(run.runId);
        return ledger ? [ledger] : [];
      });
      const reservations = ledgers.flatMap((ledger) => this.listObjectiveBudgetReservations({ runId: ledger.runId, limit: 2_000 }));
      const debits = ledgers.flatMap((ledger) => this.listObjectiveBudgetDebits({ runId: ledger.runId, limit: 2_000 }));
      const controlMutations = runs.flatMap((run) => this.listObjectiveControlMutations(run.runId));
      const planMutations = runs.flatMap((run) => this.listWorkflowPlanMutations({ runId: run.runId, limit: 2_000 }));
      const frontier: JsonValue[] = [];
      for (const run of runs) {
        for (const task of run.tasks) {
          if (!["completed", "failed", "superseded"].includes(task.state)) {
            frontier.push({ kind: "task", objectiveId, runId: run.runId, taskId: task.task.id, state: task.state, attemptId: task.attemptId, agentId: task.agentId });
          }
        }
      }
      for (const snapshot of planSnapshots) {
        for (const executionId of snapshot.frontier) frontier.push({ kind: "control", objectiveId, runId: snapshot.runId, executionId, planRevision: snapshot.planRevision });
        for (const execution of snapshot.executions) {
          if (execution.suspension && execution.suspension.status === "waiting") {
            frontier.push({ kind: "suspension", objectiveId, runId: snapshot.runId, executionId: `${execution.key.nodeId}@${execution.key.iterationKey}`, suspension: execution.suspension });
          }
        }
      }
      const suspensions = planSnapshots.flatMap((snapshot) => snapshot.executions.flatMap((execution) => execution.suspension ? [execution.suspension] : []));
      const eventLimit = Math.min(options.eventLimit ?? 10_000, 50_000);
      const events = [...runIds].flatMap((runId) => this.recentEvents({ runId, limit: eventLimit })).filter((event) => event.cursor <= eventCursor)
        .sort((left, right) => left.cursor - right.cursor || left.id.localeCompare(right.id));
      const canonicalRun = currentRuns[0] ?? runs[0] ?? null;
      const canonicalHead = canonicalRun ? this.getObjectiveControlHead(canonicalRun.runId) : null;
      const canonicalSnapshot = canonicalRun ? this.getLatestObjectiveControlSnapshot(canonicalRun.runId) : null;
      const canonicalLegacyPlan = canonicalRun ? this.listObjectivePlanRevisions(canonicalRun.runId).at(-1) ?? null : null;
      const snapshot = ObjectiveAggregateSnapshotSchema.parse({
        version: 1,
        eventCursor,
        objective: aggregate,
        revisions,
        revisionHistory: revisions,
        occurrences,
        runs,
        currentRuns,
        attempts,
        plan: {
          heads,
          revisions: [...planRevisions, ...legacyPlanRevisions],
          snapshots: planSnapshots,
          head: canonicalHead ?? canonicalLegacyPlan,
          controlSnapshot: canonicalSnapshot,
        },
        frontier,
        frontierSeed: frontier,
        approvals,
        attentions,
        artifacts,
        artifactReviews,
        checkpoints,
        budgets: { ledgers, reservations, debits },
        mutations: { control: controlMutations, plans: planMutations },
        suspensions,
        events,
      });
      return snapshot;
    });
  }

  getObjectiveAggregateSnapshot(objectiveId: string, options: { eventLimit?: number } = {}): ObjectiveAggregateSnapshot | null {
    return this.objectiveAggregateSnapshot(objectiveId, options);
  }

  getObjectiveSnapshot(objectiveId: string, options: { eventLimit?: number } = {}): ObjectiveAggregateSnapshot | null {
    return this.objectiveAggregateSnapshot(objectiveId, options);
  }

  /**
   * Update the mutable objective projection only when the caller still owns
   * the active plan revision it read. This is the run-level CAS fence used by
   * state transitions, checkpoint pointers, and plan commits.
   */
  updateObjectiveRun(record: ObjectiveRunRecord, options: { expectedActivePlanRevision: number }): boolean {
    const parsed = ObjectiveRunRecordSchema.parse(record);
    assertObjectiveRunPolicy(parsed);
    const existing = this.getObjectiveRun(parsed.runId);
    if (!existing) throw new Error(`Cannot update missing objective run: ${parsed.runId}`);
    assertObjectiveRunIdentity(existing, parsed);
    if (parsed.activePlanRevision !== options.expectedActivePlanRevision) {
      throw new Error("Objective run updates cannot change the active plan revision; commit a plan revision instead");
    }
    const result = this.database
      .prepare(
        `UPDATE objective_runs SET
           state = ?, active_plan_revision = ?, latest_checkpoint_id = ?,
           record_json = ?, updated_at = ?
         WHERE run_id = ? AND active_plan_revision = ?`,
      )
      .run(
        parsed.state,
        parsed.activePlanRevision,
        parsed.latestCheckpointId,
        serialize(parsed),
        parsed.updatedAt,
        parsed.runId,
        options.expectedActivePlanRevision,
      );
    if (Number(result.changes) === 1) {
      this.updateObjectiveRunOccurrenceFromRun(parsed);
      this.refreshObjectiveAggregate(parsed.objectiveId);
    }
    return Number(result.changes) === 1;
  }

  /**
   * Store an immutable objective plan revision and, for a non-initial
   * revision, advance objective_runs.active_plan_revision in the same SQLite
   * transaction. A failed CAS rolls back the revision insert as well.
   */
  saveObjectivePlanRevision(record: ObjectivePlanRevisionRecord, options: { expectedActivePlanRevision?: number } = {}): boolean {
    const parsed = parseObjectivePlanRevision(record);
    return this.transaction(() => {
      const run = this.getObjectiveRun(parsed.runId);
      if (!run) throw new Error(`Cannot save a plan for missing objective run: ${parsed.runId}`);
      assertObjectivePlanIdentity(run, parsed);

      const existingIdRow = this.database
        .prepare("SELECT record_json FROM objective_plan_revisions WHERE id = ?")
        .get(parsed.id) as Row | undefined;
      const existingRequestRow = this.database
        .prepare("SELECT record_json FROM objective_plan_revisions WHERE run_id = ? AND request_key = ?")
        .get(parsed.runId, parsed.requestKey) as Row | undefined;
      const existingRevisionRow = this.database
        .prepare("SELECT record_json FROM objective_plan_revisions WHERE run_id = ? AND plan_revision = ?")
        .get(parsed.runId, parsed.planRevision) as Row | undefined;
      const collisions = [existingIdRow, existingRequestRow, existingRevisionRow].filter(
        (row): row is Row => row !== undefined,
      );
      if (collisions.length > 0) {
        if (collisions.every((row) => objectiveRecordEquivalent(parseObjectivePlanRevision(parseJson(row.record_json)), parsed))) {
          return false;
        }
        throw new Error(`Objective plan idempotency conflict: ${parsed.runId}/${parsed.planRevision}`);
      }

      const expected = options.expectedActivePlanRevision;
      if (expected === undefined) {
        if (parsed.planRevision !== run.activePlanRevision) {
          throw new Error("Initial objective plan revision must match the run active plan revision");
        }
        if (!objectiveRecordEquivalent(parsed.tasks, run.tasks)) {
          throw new Error("Initial objective plan tasks must match the objective run");
        }
      } else {
        if (run.activePlanRevision !== expected) return false;
        if (parsed.planRevision !== expected + 1) {
          throw new Error("Objective plan revisions must advance by exactly one");
        }
        for (const currentTask of run.tasks) {
          const nextTask = parsed.tasks.find((candidate) => candidate.task.id === currentTask.task.id);
          if (!nextTask || !objectiveRecordEquivalent(nextTask.task, currentTask.task)) {
            throw new Error(`Objective plan revision cannot remove or redefine task ${currentTask.task.id}`);
          }
        }
      }

      const inserted = this.database
        .prepare(
          `INSERT INTO objective_plan_revisions(
             id, run_id, objective_id, workflow_id, workflow_revision,
             workflow_hash, plan_revision, tasks_json, created_by_type,
             created_by_id, request_key, record_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.runId,
          parsed.objectiveId,
          parsed.workflowId,
          parsed.workflowRevision,
          parsed.workflowHash,
          parsed.planRevision,
          serialize(parsed.tasks),
          parsed.createdBy.type,
          parsed.createdBy.id,
          parsed.requestKey,
          serialize(parsed),
          parsed.createdAt,
        );
      if (Number(inserted.changes) !== 1) return false;
      if (expected === undefined) return true;

      const nextRun = ObjectiveRunRecordSchema.parse({
        ...run,
        activePlanRevision: parsed.planRevision,
        tasks: parsed.tasks,
        updatedAt: parsed.createdAt,
      });
      const advanced = this.database
        .prepare(
          `UPDATE objective_runs SET
             active_plan_revision = ?, record_json = ?, updated_at = ?
           WHERE run_id = ? AND active_plan_revision = ?`,
        )
        .run(parsed.planRevision, serialize(nextRun), nextRun.updatedAt, parsed.runId, expected);
      if (Number(advanced.changes) !== 1) {
        throw new Error("Objective plan CAS lost after revision insert");
      }
      return true;
    });
  }

  getObjectivePlanRevision(runId: string, planRevision: number): ObjectivePlanRevisionRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_plan_revisions WHERE run_id = ? AND plan_revision = ?")
      .get(runId, planRevision) as Row | undefined;
    return row ? parseObjectivePlanRevision(parseJson(row.record_json)) : null;
  }

  getObjectivePlanRevisionByRequestKey(runId: string, requestKey: string): ObjectivePlanRevisionRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_plan_revisions WHERE run_id = ? AND request_key = ?")
      .get(runId, requestKey) as Row | undefined;
    return row ? parseObjectivePlanRevision(parseJson(row.record_json)) : null;
  }

  listObjectivePlanRevisions(runId: string): ObjectivePlanRevisionRecord[] {
    return (this.database
      .prepare("SELECT record_json FROM objective_plan_revisions WHERE run_id = ? ORDER BY plan_revision ASC")
      .all(runId) as Row[]).map((row) => parseObjectivePlanRevision(parseJson(row.record_json)));
  }

  /**
   * Admit or append a tree-shaped control-plan revision. Control revisions
   * have their own head and sequence, so this never changes the legacy flat
   * objective plan pointer. Every revision owns exactly one new snapshot;
   * this keeps the active control head and UI projection at the same durable
   * high-water mark after a restart.
   */
  saveObjectiveControlPlanRevision(
    record: ObjectiveControlPlanRevision,
    snapshot?: ObjectiveControlPlanSnapshot,
    options: { expectedActiveRevision?: number; expectedRevision?: number } = {},
  ): boolean {
    const parsed = parseObjectiveControlPlanRevision(record);
    const parsedSnapshot = snapshot === undefined ? undefined : parseObjectiveControlSnapshot(snapshot);
    return this.durableTransaction(() => {
      const run = this.getObjectiveRun(parsed.runId);
      if (!run) throw new Error(`Cannot save a control plan for missing objective run: ${parsed.runId}`);
      assertObjectiveControlRevisionIdentity(run, parsed);
      if (parsedSnapshot) {
        assertObjectiveControlSnapshotIdentity({
          version: 1,
          runId: parsed.runId,
          objectiveId: parsed.objectiveId,
          planId: parsed.planId,
          source: parsed.source,
          activeRevision: parsed.revision,
          latestSnapshotSequence: parsedSnapshot.sequence,
          createdAt: parsed.createdAt,
          updatedAt: parsed.createdAt,
        }, parsedSnapshot);
        if (parsedSnapshot.planRevision !== parsed.revision) {
          throw new Error("Objective control snapshot must reference its plan revision");
        }
        assertObjectiveControlSnapshotReferences(parsed, parsedSnapshot);
      }
      if (!parsedSnapshot) {
        throw new Error("Every objective control-plan revision requires a snapshot");
      }

      const existingRows = [
        this.database.prepare("SELECT record_json FROM objective_control_plan_revisions WHERE id = ?").get(parsed.planId + ":" + parsed.revision) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_control_plan_revisions WHERE id = ?").get(parsed.planId) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_control_plan_revisions WHERE run_id = ? AND revision = ?").get(parsed.runId, parsed.revision) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_control_plan_revisions WHERE run_id = ? AND request_key = ?").get(parsed.runId, parsed.requestKey) as Row | undefined,
      ].filter((row): row is Row => row !== undefined);
      if (existingRows.length > 0) {
        if (existingRows.every((row) => objectiveRecordEquivalent(parseObjectiveControlPlanRevision(parseJson(row.record_json)), parsed))) {
          if (parsedSnapshot) {
            const storedSnapshot = this.database
              .prepare("SELECT record_json FROM objective_control_snapshots WHERE run_id = ? AND plan_revision = ? ORDER BY sequence DESC LIMIT 1")
              .get(parsed.runId, parsed.revision) as Row | undefined;
            if (storedSnapshot && !objectiveRecordEquivalent(parseObjectiveControlSnapshot(parseJson(storedSnapshot.record_json)), parsedSnapshot)) {
              throw new Error(`Objective control-plan admission snapshot idempotency conflict: ${parsed.runId}/${parsed.revision}`);
            }
          }
          return false;
        }
        throw new Error(`Objective control-plan revision idempotency conflict: ${parsed.runId}/${parsed.revision}`);
      }

      const current = this.getObjectiveControlHead(parsed.runId);
      if (!current) {
        if (parsed.revision !== 0) throw new Error("Initial objective control-plan revision must be zero");
        if (parsedSnapshot.sequence !== 1) throw new Error("Initial objective control snapshot sequence must be 1");
        this.insertObjectiveControlRevision(parsed);
        this.insertObjectiveControlSnapshot(parsedSnapshot);
        this.syncObjectiveControlSuspensions(parsedSnapshot);
        const head: ObjectiveControlHeadRecord = {
          version: 1,
          runId: parsed.runId,
          objectiveId: parsed.objectiveId,
          planId: parsed.planId,
          source: parsed.source,
          activeRevision: 0,
          latestSnapshotSequence: parsedSnapshot.sequence,
          createdAt: parsed.createdAt,
          updatedAt: parsedSnapshot.createdAt,
        };
        this.database
          .prepare(
            `INSERT INTO objective_control_heads(
               run_id, objective_id, plan_id, source_json, active_revision,
               latest_snapshot_sequence, record_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            head.runId,
            head.objectiveId,
            head.planId,
            serialize(head.source),
            head.activeRevision,
            head.latestSnapshotSequence,
            serialize(head),
            head.createdAt,
            head.updatedAt,
          );
        return true;
      }

      assertObjectiveControlHeadIdentity(current, parsed);
      const expected = options.expectedActiveRevision ?? options.expectedRevision ?? current.activeRevision;
      if (current.activeRevision !== expected) return false;
      if (parsed.revision !== expected + 1) {
        throw new Error(`Objective control-plan revisions must advance by exactly one from ${expected}`);
      }
      if (parsedSnapshot.sequence !== current.latestSnapshotSequence + 1) {
        throw new Error(`Objective control snapshot sequence must be ${current.latestSnapshotSequence + 1}`);
      }
      if (parsedSnapshot.eventCursor < (this.latestObjectiveControlSnapshot(parsed.runId)?.eventCursor ?? 0)) {
        throw new Error("Objective control snapshot event cursor cannot move backwards");
      }
      this.insertObjectiveControlRevision(parsed);
      this.insertObjectiveControlSnapshot(parsedSnapshot);
      this.syncObjectiveControlSuspensions(parsedSnapshot);
      const nextHead: ObjectiveControlHeadRecord = {
        ...current,
        activeRevision: parsed.revision,
        latestSnapshotSequence: parsedSnapshot.sequence,
        updatedAt: parsedSnapshot.createdAt,
      };
      const updated = this.database
        .prepare(
          `UPDATE objective_control_heads SET
             active_revision = ?, latest_snapshot_sequence = ?, record_json = ?, updated_at = ?
           WHERE run_id = ? AND active_revision = ? AND latest_snapshot_sequence = ?`,
        )
        .run(
          nextHead.activeRevision,
          nextHead.latestSnapshotSequence,
          serialize(nextHead),
          nextHead.updatedAt,
          nextHead.runId,
          current.activeRevision,
          current.latestSnapshotSequence,
        );
      if (Number(updated.changes) !== 1) throw new Error("Objective control-plan CAS lost after revision insert");
      return true;
    });
  }

  /** Append a durable projection snapshot without changing the active plan. */
  saveObjectiveControlSnapshot(snapshot: ObjectiveControlPlanSnapshot): boolean {
    const parsed = parseObjectiveControlSnapshot(snapshot);
    return this.durableTransaction(() => {
      const head = this.getObjectiveControlHead(parsed.runId);
      if (!head) throw new Error(`Cannot save a control snapshot for missing control plan: ${parsed.runId}`);
      assertObjectiveControlSnapshotIdentity(head, parsed);
      if (parsed.planRevision !== head.activeRevision) {
        throw new Error("Objective control snapshot must reference the active plan revision");
      }
      const activeRevision = this.getObjectiveControlPlanRevision(parsed.runId, head.activeRevision);
      if (!activeRevision) {
        throw new Error(`Objective control snapshot references a missing active plan revision: ${parsed.runId}/${head.activeRevision}`);
      }
      assertObjectiveControlSnapshotReferences(activeRevision, parsed);
      const existing = this.database
        .prepare("SELECT record_json FROM objective_control_snapshots WHERE run_id = ? AND sequence = ?")
        .get(parsed.runId, parsed.sequence) as Row | undefined;
      if (existing) {
        const stored = parseObjectiveControlSnapshot(parseJson(existing.record_json));
        if (objectiveRecordEquivalent(stored, parsed)) return false;
        throw new Error(`Objective control snapshot idempotency conflict: ${parsed.runId}/${parsed.sequence}`);
      }
      if (parsed.sequence !== head.latestSnapshotSequence + 1) {
        throw new Error(`Objective control snapshot sequence must be ${head.latestSnapshotSequence + 1}`);
      }
      const previous = this.latestObjectiveControlSnapshot(parsed.runId);
      if (previous && parsed.eventCursor < previous.eventCursor) {
        throw new Error("Objective control snapshot event cursor cannot move backwards");
      }
      this.insertObjectiveControlSnapshot(parsed);
      this.syncObjectiveControlSuspensions(parsed);
      const nextHead: ObjectiveControlHeadRecord = {
        ...head,
        latestSnapshotSequence: parsed.sequence,
        updatedAt: parsed.createdAt,
      };
      const updated = this.database
        .prepare(
          `UPDATE objective_control_heads SET latest_snapshot_sequence = ?, record_json = ?, updated_at = ?
           WHERE run_id = ? AND active_revision = ? AND latest_snapshot_sequence = ?`,
        )
        .run(parsed.sequence, serialize(nextHead), nextHead.updatedAt, parsed.runId, head.activeRevision, head.latestSnapshotSequence);
      if (Number(updated.changes) !== 1) throw new Error("Objective control snapshot CAS lost");
      return true;
    });
  }

  /**
   * Commit a typed mutation, its next immutable revision, and its projection
   * snapshot under one SQLite transaction. A replay is explicitly distinct
   * from a stale CAS conflict so callers can safely retry only the former.
   */
  commitObjectiveControlMutation(
    mutation: ObjectiveControlMutation,
    revision: ObjectiveControlPlanRevision,
    snapshot: ObjectiveControlPlanSnapshot,
  ): ObjectiveControlMutationCommit {
    const parsedMutation = parseObjectiveControlMutation(mutation);
    const parsedRevision = parseObjectiveControlPlanRevision(revision);
    const parsedSnapshot = parseObjectiveControlSnapshot(snapshot);
    return this.durableTransaction(() => {
      const collisions = [
        this.database.prepare("SELECT record_json FROM objective_control_mutations WHERE mutation_id = ?").get(parsedMutation.mutationId) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_control_mutations WHERE run_id = ? AND request_key = ?").get(parsedMutation.runId, parsedMutation.requestKey) as Row | undefined,
      ].filter((row): row is Row => row !== undefined);
      if (collisions.length > 0) {
        const records = collisions.map((row) => parseObjectiveControlMutationRecord(parseJson(row.record_json)));
        if (records.every((entry) => objectiveRecordEquivalent(entry.mutation, parsedMutation))) {
          const replay = records.at(0);
          if (!replay) throw new Error(`Objective control mutation collision had no receipt: ${parsedMutation.mutationId}`);
          const replayHead = this.getObjectiveControlHead(parsedMutation.runId);
          const replayRevision = this.getObjectiveControlPlanRevision(parsedMutation.runId, replay.resultingRevision);
          const replaySnapshot = this.getObjectiveControlSnapshot(parsedMutation.runId, replay.snapshotSequence);
          if (!replayHead || !replayRevision || !replaySnapshot) {
            throw new Error(`Objective control mutation receipt points to missing state: ${parsedMutation.mutationId}`);
          }
          return { status: "replayed", head: replayHead, revision: replayRevision, snapshot: replaySnapshot, mutation: replay };
        }
        return {
          status: "conflict",
          head: this.getObjectiveControlHead(parsedMutation.runId),
          revision: null,
          snapshot: null,
          mutation: null,
          reason: "Objective control mutation request key or mutation id is already bound to different evidence",
        };
      }

      const head = this.getObjectiveControlHead(parsedMutation.runId);
      if (!head) return { status: "conflict", head: null, revision: null, snapshot: null, mutation: null, reason: "Control plan has not been admitted" };
      const run = this.getObjectiveRun(parsedMutation.runId);
      if (!run) throw new Error(`Cannot commit a control mutation for missing objective run: ${parsedMutation.runId}`);
      assertObjectiveControlRevisionIdentity(run, parsedRevision);
      assertObjectiveControlHeadIdentity(head, parsedRevision);
      assertObjectiveControlSnapshotIdentity(head, parsedSnapshot);
      if (
        parsedMutation.actor.type !== parsedRevision.createdBy.type
        || parsedMutation.actor.id !== parsedRevision.createdBy.id
        || parsedMutation.requestKey !== parsedRevision.requestKey
      ) {
        return {
          status: "conflict",
          head,
          revision: null,
          snapshot: null,
          mutation: null,
          reason: "Mutation actor and request key must match the resulting revision",
        };
      }
      if (
        parsedMutation.planId !== head.planId
        || parsedMutation.objectiveId !== head.objectiveId
        || parsedMutation.runId !== head.runId
        || parsedRevision.revision !== parsedMutation.expectedRevision + 1
        || parsedRevision.planId !== parsedMutation.planId
        || parsedSnapshot.planRevision !== parsedRevision.revision
        || parsedSnapshot.sequence !== head.latestSnapshotSequence + 1
      ) {
        return { status: "conflict", head, revision: null, snapshot: null, mutation: null, reason: "Mutation revision or snapshot identity is inconsistent" };
      }
      if (head.activeRevision !== parsedMutation.expectedRevision) {
        return { status: "conflict", head, revision: null, snapshot: null, mutation: null, reason: "Objective control-plan CAS revision is stale" };
      }
      const currentRevision = this.getObjectiveControlPlanRevision(parsedMutation.runId, parsedMutation.expectedRevision);
      if (!currentRevision) {
        return { status: "conflict", head, revision: null, snapshot: null, mutation: null, reason: "Expected control-plan revision is missing" };
      }
      try {
        validateObjectiveControlMutationTarget(parsedMutation, currentRevision.plan);
        const deterministicPlan = applyObjectiveControlMutation(currentRevision.plan, parsedMutation);
        if (
          objectiveControlStableJson(deterministicPlan) !== objectiveControlStableJson(parsedRevision.plan)
          || parsedRevision.hash !== objectiveControlPlanHash(deterministicPlan)
        ) {
          return {
            status: "conflict",
            head,
            revision: null,
            snapshot: null,
            mutation: null,
            reason: "Resulting control-plan revision does not match the deterministic mutation result",
          };
        }
      } catch (error) {
        return {
          status: "conflict",
          head,
          revision: null,
          snapshot: null,
          mutation: null,
          reason: error instanceof Error ? error.message : "Invalid objective control mutation target",
        };
      }
      const existingRevision = this.database
        .prepare("SELECT record_json FROM objective_control_plan_revisions WHERE run_id = ? AND revision = ?")
        .get(parsedRevision.runId, parsedRevision.revision) as Row | undefined;
      if (existingRevision) {
        return { status: "conflict", head, revision: null, snapshot: null, mutation: null, reason: "Resulting control-plan revision already exists" };
      }
      if (parsedSnapshot.eventCursor < (this.latestObjectiveControlSnapshot(parsedSnapshot.runId)?.eventCursor ?? 0)) {
        return { status: "conflict", head, revision: null, snapshot: null, mutation: null, reason: "Control snapshot event cursor is stale" };
      }
      assertObjectiveControlSnapshotReferences(parsedRevision, parsedSnapshot);

      const mutationRecord: ObjectiveControlMutationRecord = {
        version: 1,
        mutationId: parsedMutation.mutationId,
        requestKey: parsedMutation.requestKey,
        planId: parsedMutation.planId,
        objectiveId: parsedMutation.objectiveId,
        runId: parsedMutation.runId,
        expectedRevision: parsedMutation.expectedRevision,
        resultingRevision: parsedRevision.revision,
        snapshotSequence: parsedSnapshot.sequence,
        revisionId: parsedRevision.planId + ":" + parsedRevision.revision,
        mutation: parsedMutation,
        createdAt: parsedRevision.createdAt,
      };
      this.insertObjectiveControlRevision(parsedRevision);
      this.insertObjectiveControlSnapshot(parsedSnapshot);
      this.syncObjectiveControlSuspensions(parsedSnapshot);
      const nextHead: ObjectiveControlHeadRecord = {
        ...head,
        activeRevision: parsedRevision.revision,
        latestSnapshotSequence: parsedSnapshot.sequence,
        updatedAt: parsedSnapshot.createdAt,
      };
      const advanced = this.database
        .prepare(
          `UPDATE objective_control_heads SET active_revision = ?, latest_snapshot_sequence = ?, record_json = ?, updated_at = ?
           WHERE run_id = ? AND active_revision = ? AND latest_snapshot_sequence = ?`,
        )
        .run(parsedRevision.revision, parsedSnapshot.sequence, serialize(nextHead), nextHead.updatedAt, head.runId, head.activeRevision, head.latestSnapshotSequence);
      if (Number(advanced.changes) !== 1) throw new Error("Objective control mutation CAS lost after revision insert");
      const insertedMutation = this.database
        .prepare(
          `INSERT INTO objective_control_mutations(
             mutation_id, request_key, run_id, objective_id, plan_id,
             expected_revision, resulting_revision, snapshot_sequence,
             revision_id, mutation_json, record_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          mutationRecord.mutationId,
          mutationRecord.requestKey,
          mutationRecord.runId,
          mutationRecord.objectiveId,
          mutationRecord.planId,
          mutationRecord.expectedRevision,
          mutationRecord.resultingRevision,
          mutationRecord.snapshotSequence,
          mutationRecord.revisionId,
          serialize(mutationRecord.mutation),
          serialize(mutationRecord),
          mutationRecord.createdAt,
        );
      if (Number(insertedMutation.changes) !== 1) throw new Error("Objective control mutation receipt insert failed");
      return { status: "committed", head: nextHead, revision: parsedRevision, snapshot: parsedSnapshot, mutation: mutationRecord };
    });
  }

  /**
   * Commit a control mutation from its typed request alone.  The daemon uses
   * this entrypoint for network callers: the active revision and snapshot are
   * read under the SQLite write transaction, the next plan is reduced here,
   * and the revision/snapshot/event are all created by storage.  There is no
   * caller-provided resulting plan or snapshot to validate or accidentally
   * trust.
   */
  commitObjectiveControlMutationDerived(mutation: ObjectiveControlMutation): ObjectiveControlMutationCommit {
    const parsedMutation = parseObjectiveControlMutation(mutation);
    return this.durableTransaction(() => {
      const collisions = [
        this.database.prepare("SELECT record_json FROM objective_control_mutations WHERE mutation_id = ?").get(parsedMutation.mutationId) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_control_mutations WHERE run_id = ? AND request_key = ?").get(parsedMutation.runId, parsedMutation.requestKey) as Row | undefined,
      ].filter((row): row is Row => row !== undefined);
      if (collisions.length > 0) {
        const records = collisions.map((row) => parseObjectiveControlMutationRecord(parseJson(row.record_json)));
        if (records.every((entry) => objectiveRecordEquivalent(entry.mutation, parsedMutation))) {
          const replay = records.at(0);
          if (!replay) throw new Error(`Objective control mutation collision had no receipt: ${parsedMutation.mutationId}`);
          const replayHead = this.getObjectiveControlHead(parsedMutation.runId);
          const replayRevision = this.getObjectiveControlPlanRevision(parsedMutation.runId, replay.resultingRevision);
          const replaySnapshot = this.getObjectiveControlSnapshot(parsedMutation.runId, replay.snapshotSequence);
          if (!replayHead || !replayRevision || !replaySnapshot) {
            throw new Error(`Objective control mutation receipt points to missing state: ${parsedMutation.mutationId}`);
          }
          return { status: "replayed", head: replayHead, revision: replayRevision, snapshot: replaySnapshot, mutation: replay };
        }
        return {
          status: "conflict",
          head: this.getObjectiveControlHead(parsedMutation.runId),
          revision: null,
          snapshot: null,
          mutation: null,
          reason: "Objective control mutation request key or mutation id is already bound to different evidence",
        };
      }

      const head = this.getObjectiveControlHead(parsedMutation.runId);
      if (!head) return { status: "conflict", head: null, revision: null, snapshot: null, mutation: null, reason: "Control plan has not been admitted" };
      const run = this.getObjectiveRun(parsedMutation.runId);
      if (!run) throw new Error(`Cannot commit a control mutation for missing objective run: ${parsedMutation.runId}`);
      if (
        parsedMutation.planId !== head.planId
        || parsedMutation.objectiveId !== head.objectiveId
        || parsedMutation.runId !== head.runId
      ) {
        return { status: "conflict", head, revision: null, snapshot: null, mutation: null, reason: "Mutation identity does not match the control-plan head" };
      }
      if (head.activeRevision !== parsedMutation.expectedRevision) {
        return { status: "conflict", head, revision: null, snapshot: null, mutation: null, reason: "Objective control-plan CAS revision is stale" };
      }
      const currentRevision = this.getObjectiveControlPlanRevision(parsedMutation.runId, head.activeRevision);
      const currentSnapshot = this.getObjectiveControlSnapshot(parsedMutation.runId, head.latestSnapshotSequence);
      if (!currentRevision || !currentSnapshot) {
        return { status: "conflict", head, revision: null, snapshot: null, mutation: null, reason: "Active control-plan state is incomplete" };
      }
      try {
        validateObjectiveControlMutationTarget(parsedMutation, currentRevision.plan);
      } catch (error) {
        return {
          status: "conflict",
          head,
          revision: null,
          snapshot: null,
          mutation: null,
          reason: error instanceof Error ? error.message : "Invalid objective control mutation target",
        };
      }

      const deterministicPlan = applyObjectiveControlMutation(currentRevision.plan, parsedMutation);
      const policyPreview = previewObjectiveControlMutation(currentRevision.plan, currentSnapshot, parsedMutation, run.policy ? {
        policy: {
          effectivePermission: run.policy.effectivePermission,
          allowedCapabilities: run.policy.allowedCapabilities,
          workspace: run.policy.workspace,
          sideEffectClassCeiling: run.policy.sideEffectClassCeiling,
          budget: run.policy.budget,
        },
      } : {});
      if (!policyPreview.valid) {
        return {
          status: "conflict",
          head,
          revision: null,
          snapshot: null,
          mutation: null,
          reason: policyPreview.errors.join(" ") || "Objective control candidate violates policy",
        };
      }
      const createdAt = nowIso();
      const nextRevision = ObjectiveControlPlanRevisionSchema.parse({
        version: 1,
        planId: head.planId,
        objectiveId: head.objectiveId,
        runId: head.runId,
        revision: head.activeRevision + 1,
        source: currentRevision.source,
        plan: deterministicPlan,
        hash: objectiveControlPlanHash(deterministicPlan),
        createdBy: parsedMutation.actor,
        requestKey: parsedMutation.requestKey,
        createdAt,
      });

      // The event is inserted before the snapshot so its SQLite cursor can be
      // the snapshot's authoritative event high-water mark. It remains queued
      // for listeners until the enclosing transaction commits.
      const eventId = `objective-control:${parsedMutation.mutationId}`;
      const event = this.appendEvent({
        id: eventId,
        type: "objective.control-plan.changed",
        workflowId: run.workflowId,
        runId: run.runId,
        agentId: parsedMutation.actor.type === "agent" ? parsedMutation.actor.id : null,
        occurredAt: createdAt,
        payload: {
          objectiveId: run.objectiveId,
          planId: head.planId,
          mutationId: parsedMutation.mutationId,
          requestKey: parsedMutation.requestKey,
          expectedRevision: parsedMutation.expectedRevision,
          resultingRevision: nextRevision.revision,
          snapshotSequence: head.latestSnapshotSequence + 1,
          mutationType: parsedMutation.type,
          reason: parsedMutation.reason,
          evidence: {
            eventCursor: parsedMutation.evidence.eventCursor,
            eventIds: parsedMutation.evidence.eventIds,
            ...(parsedMutation.evidence.summary === undefined
              ? {}
              : { summary: parsedMutation.evidence.summary }),
          },
          impact: policyPreview.impact as unknown as JsonValue,
          actor: parsedMutation.actor,
        },
        provenance: { source: "daemon" },
      });
      let nextSnapshot = ObjectiveControlPlanSnapshotSchema.parse({
        ...currentSnapshot,
        planRevision: nextRevision.revision,
        source: nextRevision.source,
        sequence: head.latestSnapshotSequence + 1,
        eventCursor: event.cursor,
        reason: parsedMutation.reason,
        createdAt,
      });
      // A removed running subtree is reduced to explicit cancellation
      // tombstones before the snapshot is persisted. This keeps the scheduler
      // projection free of deleted nodes while preserving attempt lineage.
      nextSnapshot = applyObjectiveControlMutationToSnapshot(
        currentRevision.plan,
        nextSnapshot,
        parsedMutation,
        deterministicPlan,
        createdAt,
      );
      try {
        assertObjectiveControlSnapshotReferences(nextRevision, nextSnapshot);
      } catch (error) {
        // This should only be reachable if a reducer invariant changes. The
        // surrounding transaction rolls the event back with the state.
        throw new Error(error instanceof Error ? error.message : "Derived control snapshot is invalid");
      }

      const mutationRecord: ObjectiveControlMutationRecord = {
        version: 1,
        mutationId: parsedMutation.mutationId,
        requestKey: parsedMutation.requestKey,
        planId: parsedMutation.planId,
        objectiveId: parsedMutation.objectiveId,
        runId: parsedMutation.runId,
        expectedRevision: parsedMutation.expectedRevision,
        resultingRevision: nextRevision.revision,
        snapshotSequence: nextSnapshot.sequence,
        revisionId: `${nextRevision.planId}:${nextRevision.revision}`,
        mutation: parsedMutation,
        createdAt,
      };
      this.insertObjectiveControlRevision(nextRevision);
      this.insertObjectiveControlSnapshot(nextSnapshot);
      this.syncObjectiveControlSuspensions(nextSnapshot);
      const nextHead: ObjectiveControlHeadRecord = {
        ...head,
        activeRevision: nextRevision.revision,
        latestSnapshotSequence: nextSnapshot.sequence,
        updatedAt: createdAt,
      };
      const advanced = this.database
        .prepare(
          `UPDATE objective_control_heads SET active_revision = ?, latest_snapshot_sequence = ?, record_json = ?, updated_at = ?
           WHERE run_id = ? AND active_revision = ? AND latest_snapshot_sequence = ?`,
        )
        .run(nextHead.activeRevision, nextHead.latestSnapshotSequence, serialize(nextHead), nextHead.updatedAt, head.runId, head.activeRevision, head.latestSnapshotSequence);
      if (Number(advanced.changes) !== 1) throw new Error("Objective control mutation CAS lost after derived state insert");
      const insertedMutation = this.database
        .prepare(
          `INSERT INTO objective_control_mutations(
             mutation_id, request_key, run_id, objective_id, plan_id,
             expected_revision, resulting_revision, snapshot_sequence,
             revision_id, mutation_json, record_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          mutationRecord.mutationId,
          mutationRecord.requestKey,
          mutationRecord.runId,
          mutationRecord.objectiveId,
          mutationRecord.planId,
          mutationRecord.expectedRevision,
          mutationRecord.resultingRevision,
          mutationRecord.snapshotSequence,
          mutationRecord.revisionId,
          serialize(mutationRecord.mutation),
          serialize(mutationRecord),
          mutationRecord.createdAt,
        );
      if (Number(insertedMutation.changes) !== 1) throw new Error("Objective control mutation receipt insert failed");
      return { status: "committed", head: nextHead, revision: nextRevision, snapshot: nextSnapshot, mutation: mutationRecord };
    });
  }

  getObjectiveControlHead(runId: string): ObjectiveControlHeadRecord | null {
    const row = this.database.prepare("SELECT record_json FROM objective_control_heads WHERE run_id = ?").get(runId) as Row | undefined;
    return row ? parseObjectiveControlHead(parseJson(row.record_json)) : null;
  }

  getObjectiveControlPlanRevision(runId: string, revision: number): ObjectiveControlPlanRevision | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_control_plan_revisions WHERE run_id = ? AND revision = ?")
      .get(runId, revision) as Row | undefined;
    return row ? parseObjectiveControlPlanRevision(parseJson(row.record_json)) : null;
  }

  getLatestObjectiveControlPlanRevision(runId: string): ObjectiveControlPlanRevision | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_control_plan_revisions WHERE run_id = ? ORDER BY revision DESC LIMIT 1")
      .get(runId) as Row | undefined;
    return row ? parseObjectiveControlPlanRevision(parseJson(row.record_json)) : null;
  }

  getObjectiveControlPlanRevisionByRequestKey(runId: string, requestKey: string): ObjectiveControlPlanRevision | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_control_plan_revisions WHERE run_id = ? AND request_key = ?")
      .get(runId, requestKey) as Row | undefined;
    return row ? parseObjectiveControlPlanRevision(parseJson(row.record_json)) : null;
  }

  listObjectiveControlPlanRevisions(runId: string): ObjectiveControlPlanRevision[] {
    return (this.database
      .prepare("SELECT record_json FROM objective_control_plan_revisions WHERE run_id = ? ORDER BY revision ASC")
      .all(runId) as Row[]).map((row) => parseObjectiveControlPlanRevision(parseJson(row.record_json)));
  }

  getObjectiveControlSnapshot(runId: string, sequence: number): ObjectiveControlPlanSnapshot | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_control_snapshots WHERE run_id = ? AND sequence = ?")
      .get(runId, sequence) as Row | undefined;
    return row ? parseObjectiveControlSnapshot(parseJson(row.record_json)) : null;
  }

  latestObjectiveControlSnapshot(runId: string): ObjectiveControlPlanSnapshot | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_control_snapshots WHERE run_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(runId) as Row | undefined;
    return row ? parseObjectiveControlSnapshot(parseJson(row.record_json)) : null;
  }

  getLatestObjectiveControlSnapshot(runId: string): ObjectiveControlPlanSnapshot | null {
    return this.latestObjectiveControlSnapshot(runId);
  }

  listObjectiveControlSnapshots(runId: string): ObjectiveControlPlanSnapshot[] {
    return (this.database
      .prepare("SELECT record_json FROM objective_control_snapshots WHERE run_id = ? ORDER BY sequence ASC")
      .all(runId) as Row[]).map((row) => parseObjectiveControlSnapshot(parseJson(row.record_json)));
  }

  getObjectiveControlMutation(mutationId: string): ObjectiveControlMutationRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_control_mutations WHERE mutation_id = ?")
      .get(mutationId) as Row | undefined;
    return row ? parseObjectiveControlMutationRecord(parseJson(row.record_json)) : null;
  }

  getObjectiveControlMutationByRequestKey(runId: string, requestKey: string): ObjectiveControlMutationRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_control_mutations WHERE run_id = ? AND request_key = ?")
      .get(runId, requestKey) as Row | undefined;
    return row ? parseObjectiveControlMutationRecord(parseJson(row.record_json)) : null;
  }

  listObjectiveControlMutations(runId: string): ObjectiveControlMutationRecord[] {
    return (this.database
      .prepare("SELECT record_json FROM objective_control_mutations WHERE run_id = ? ORDER BY created_at ASC, mutation_id ASC")
      .all(runId) as Row[]).map((row) => parseObjectiveControlMutationRecord(parseJson(row.record_json)));
  }

  private syncObjectiveControlSuspensions(snapshot: ObjectiveControlPlanSnapshot): void {
    for (const execution of snapshot.executions) {
      if (execution.suspension) this.saveObjectiveControlSuspension(execution.suspension);
    }
  }

  /** Queryable durable projection of timer and signal frontier entries. */
  getObjectiveControlSuspension(runId: string, executionId: string): ObjectiveControlSuspensionRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_control_suspensions WHERE run_id = ? AND execution_id = ?")
      .get(runId, executionId) as Row | undefined;
    return row ? parseObjectiveControlSuspension(parseJson(row.record_json)) : null;
  }

  getObjectiveControlSuspensionByExecution(runId: string, executionId: string): ObjectiveControlSuspensionRecord | null {
    return this.getObjectiveControlSuspension(runId, executionId);
  }

  listObjectiveControlSuspensions(runId: string, options: { status?: ObjectiveControlSuspensionRecord["status"] } = {}): ObjectiveControlSuspensionRecord[] {
    const rows = options.status
      ? this.database.prepare("SELECT record_json FROM objective_control_suspensions WHERE run_id = ? AND status = ? ORDER BY updated_at ASC, execution_id ASC").all(runId, options.status) as Row[]
      : this.database.prepare("SELECT record_json FROM objective_control_suspensions WHERE run_id = ? ORDER BY updated_at ASC, execution_id ASC").all(runId) as Row[];
    return rows.map((row) => parseObjectiveControlSuspension(parseJson(row.record_json)));
  }

  listDueObjectiveControlSuspensions(now: string): ObjectiveControlSuspensionRecord[] {
    const rows = this.database.prepare(`SELECT record_json FROM objective_control_suspensions
      WHERE status = 'waiting' AND ((due_at IS NOT NULL AND due_at <= ?) OR (expires_at IS NOT NULL AND expires_at <= ?))
      ORDER BY COALESCE(expires_at, due_at), run_id, execution_id`).all(now, now) as Row[];
    return rows.map((row) => parseObjectiveControlSuspension(parseJson(row.record_json)));
  }

  saveObjectiveControlSuspension(record: ObjectiveControlSuspensionRecord): boolean {
    const parsed = parseObjectiveControlSuspension(record);
    const executionId = `${parsed.execution.nodeId}@${parsed.execution.iterationKey}`;
    return this.durableTransaction(() => {
      const existingRow = this.database.prepare("SELECT record_json FROM objective_control_suspensions WHERE run_id = ? AND execution_id = ?").get(parsed.runId, executionId) as Row | undefined;
      if (!existingRow) {
        this.database.prepare(`INSERT INTO objective_control_suspensions(
          run_id, execution_id, objective_id, node_id, attempt_id, kind, status,
          due_at, expires_at, record_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          parsed.runId, executionId, parsed.objectiveId, parsed.nodeId, parsed.attemptId,
          parsed.kind, parsed.status, parsed.kind === "timer" ? parsed.dueAt : null,
          parsed.expiresAt, serialize(parsed), parsed.since, parsed.settledAt ?? parsed.since,
        );
        return true;
      }
      const existing = parseObjectiveControlSuspension(parseJson(existingRow.record_json));
      if (stableSerialize(existing) === stableSerialize(parsed)) return false;
      if (
        existing.objectiveId !== parsed.objectiveId
        || existing.nodeId !== parsed.nodeId
        || existing.execution.nodeId !== parsed.execution.nodeId
        || existing.execution.iterationKey !== parsed.execution.iterationKey
        || existing.attemptId !== parsed.attemptId
        || existing.kind !== parsed.kind
      ) throw new Error(`Objective control suspension identity conflict: ${parsed.runId}/${executionId}`);
      this.database.prepare(`UPDATE objective_control_suspensions SET status = ?, due_at = ?, expires_at = ?, record_json = ?, updated_at = ?
        WHERE run_id = ? AND execution_id = ?`).run(
        parsed.status, parsed.kind === "timer" ? parsed.dueAt : null, parsed.expiresAt,
        serialize(parsed), parsed.settledAt ?? parsed.since, parsed.runId, executionId,
      );
      return true;
    });
  }

  getObjectiveControlSignalDelivery(subscriptionKey: string, deliveryId: string): ObjectiveControlSignalDeliveryRecord | null {
    const row = this.database.prepare("SELECT record_json FROM objective_control_signal_deliveries WHERE subscription_key = ? AND delivery_id = ?").get(subscriptionKey, deliveryId) as Row | undefined;
    return row ? parseObjectiveControlSignalDelivery(parseJson(row.record_json)) : null;
  }

  saveObjectiveControlSignalDelivery(record: ObjectiveControlSignalDeliveryRecord): boolean {
    const parsed = parseObjectiveControlSignalDelivery(record);
    return this.durableTransaction(() => {
      const existingRow = this.database.prepare("SELECT record_json FROM objective_control_signal_deliveries WHERE subscription_key = ? AND delivery_id = ?").get(parsed.subscriptionKey, parsed.deliveryId) as Row | undefined;
      if (existingRow) {
        const existing = parseObjectiveControlSignalDelivery(parseJson(existingRow.record_json));
        if (stableSerialize(existing) === stableSerialize(parsed)) return false;
        throw new Error(`Objective control signal delivery identity conflict: ${parsed.subscriptionKey}/${parsed.deliveryId}`);
      }
      this.database.prepare(`INSERT INTO objective_control_signal_deliveries(
        subscription_key, delivery_id, run_id, objective_id, execution_id, attempt_id,
        record_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parsed.subscriptionKey, parsed.deliveryId, parsed.runId, parsed.objectiveId,
        `${parsed.execution.nodeId}@${parsed.execution.iterationKey}`, parsed.attemptId,
        serialize(parsed), parsed.deliveredAt,
      );
      return true;
    });
  }

  getObjectiveHandoff(id: string): ObjectiveHandoffEnvelope | null {
    const row = this.database.prepare("SELECT record_json FROM objective_handoffs WHERE id = ?").get(id) as Row | undefined;
    return row ? parseObjectiveHandoff(parseJson(row.record_json)) : null;
  }

  getObjectiveHandoffByRequestKey(runId: string, requestKey: string): ObjectiveHandoffEnvelope | null {
    const row = this.database.prepare("SELECT record_json FROM objective_handoffs WHERE run_id = ? AND request_key = ?").get(runId, requestKey) as Row | undefined;
    return row ? parseObjectiveHandoff(parseJson(row.record_json)) : null;
  }

  listObjectiveHandoffs(runId: string): ObjectiveHandoffEnvelope[] {
    return (this.database.prepare("SELECT record_json FROM objective_handoffs WHERE run_id = ? ORDER BY created_at ASC, id ASC").all(runId) as Row[])
      .map((row) => parseObjectiveHandoff(parseJson(row.record_json)));
  }

  getObjectiveHandoffAcceptance(envelopeId: string): ObjectiveHandoffAcceptanceRecord | null {
    const row = this.database.prepare("SELECT record_json FROM objective_handoff_acceptances WHERE envelope_id = ?").get(envelopeId) as Row | undefined;
    return row ? parseObjectiveHandoffAcceptance(parseJson(row.record_json)) : null;
  }

  listObjectiveHandoffAcceptances(runId: string): ObjectiveHandoffAcceptanceRecord[] {
    return (this.database.prepare("SELECT record_json FROM objective_handoff_acceptances WHERE run_id = ? ORDER BY created_at ASC, id ASC").all(runId) as Row[])
      .map((row) => parseObjectiveHandoffAcceptance(parseJson(row.record_json)));
  }

  /**
   * Persist an immutable envelope only after all referenced durable evidence
   * is present in this objective.  This boundary intentionally does not copy
   * native transcripts or process handles.
   */
  saveObjectiveHandoff(record: ObjectiveHandoffEnvelope, options: { fingerprint: string }): ObjectiveHandoffResult {
    const parsed = parseObjectiveHandoff(record);
    if (!isObjectiveHandoffHashValid(parsed)) throw new Error(`Objective handoff content hash is invalid: ${parsed.id}`);
    if (options.fingerprint !== parsed.inputHash) throw new Error("Objective handoff fingerprint does not match its input hash");
    return this.durableTransaction(() => {
      const run = this.getObjectiveRun(parsed.runId);
      if (!run) throw new Error(`Cannot save a handoff for missing objective run: ${parsed.runId}`);
      if (run.objectiveId !== parsed.objectiveId || run.workflowId !== parsed.workflowId || run.workflowRevision !== parsed.workflowRevision || run.workflowHash !== parsed.workflowHash) {
        throw new Error(`Objective handoff identity does not match its run: ${parsed.id}`);
      }
      if (run.objectiveRevision !== undefined && run.objectiveRevision !== parsed.objectiveRevision) throw new Error("Objective handoff objective revision does not match its run");
      if (!run.policy || !run.policyHash || !isObjectivePolicyHashValid(run.policy) || run.policy.policyHash !== run.policyHash || run.policyHash !== parsed.authority.policySnapshotHash || !parsed.authority.configSnapshotHash) {
        throw new Error("Objective handoff policy/config authority is not provable");
      }
      const priorById = this.database.prepare("SELECT record_json FROM objective_handoffs WHERE id = ?").get(parsed.id) as Row | undefined;
      const priorByRequest = this.database.prepare("SELECT record_json FROM objective_handoffs WHERE run_id = ? AND request_key = ?").get(parsed.runId, parsed.requestKey) as Row | undefined;
      const prior = priorById ?? priorByRequest;
      if (prior) {
        const existing = parseObjectiveHandoff(parseJson(prior.record_json));
        if (existing.inputHash === parsed.inputHash && existing.requestKey === parsed.requestKey) return { status: "replayed", envelope: existing };
        throw new Error(`Objective handoff idempotency conflict: ${parsed.runId}/${parsed.requestKey}`);
      }

      const checkpoint = this.getObjectiveCheckpoint(parsed.runId, parsed.evidence.checkpoint.id);
      if (!checkpoint || checkpoint.sequence !== parsed.evidence.checkpoint.sequence || objectiveHandoffReferenceHash(checkpoint) !== parsed.evidence.checkpoint.hash) throw new Error("Objective handoff checkpoint evidence is missing or has changed");
      const portable = ObjectivePortableCheckpointRecordSchema.safeParse(checkpoint);
      if (!portable.success) throw new Error("Objective handoff requires a portable checkpoint with explicit recovery evidence");
      if (parsed.evidence.eventCursor > this.latestCursor()) throw new Error("Objective handoff evidence cursor is ahead of the durable event high-water mark");
      for (const ref of parsed.evidence.eventRefs) {
        const event = this.getEventById(ref.id);
        if (!event || event.runId !== parsed.runId || event.cursor !== ref.cursor || objectiveHandoffReferenceHash(event) !== ref.hash || event.cursor > parsed.evidence.eventCursor) throw new Error(`Objective handoff event evidence is not provable: ${ref.id}`);
      }
      for (const ref of parsed.evidence.observationRefs) {
        const observation = this.getObservationById(ref.id);
        const agent = observation ? this.getAgent(observation.agentId) : null;
        if (!observation || !agent || agent.runId !== parsed.runId || observation.agentId !== ref.agentId || observation.eventCursor !== ref.eventCursor || objectiveHandoffReferenceHash(observation) !== ref.hash || observation.eventCursor > parsed.evidence.eventCursor) throw new Error(`Objective handoff observation evidence is not provable: ${ref.id}`);
      }
      const checkpointArtifacts = new Map(
        (portable.data.artifactHashes ?? []).flatMap((ref) => typeof ref === "string" ? [] : [[ref.id, ref.hash] as const]),
      );
      for (const ref of parsed.evidence.artifactRefs) {
        const artifact = this.getObjectiveArtifact(ref.id);
        if (!artifact || artifact.runId !== parsed.runId || artifact.objectiveId !== parsed.objectiveId || artifact.hash !== ref.hash || checkpointArtifacts.get(ref.id) !== ref.hash) throw new Error(`Objective handoff artifact evidence is not provable: ${ref.id}`);
      }
      if (parsed.workspace && portable.data.workspaceEvidence) {
        if (parsed.workspace.snapshotHash !== objectiveHandoffReferenceHash(portable.data.workspaceEvidence)) throw new Error("Objective handoff workspace evidence does not match its checkpoint");
      }
      const inserted = this.database.prepare(`INSERT INTO objective_handoffs(id, objective_id, run_id, request_key, content_hash, record_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(parsed.id, parsed.objectiveId, parsed.runId, parsed.requestKey, parsed.contentHash, serialize(parsed), parsed.createdAt);
      if (Number(inserted.changes) !== 1) throw new Error(`Objective handoff insert failed: ${parsed.id}`);
      return { status: "committed", envelope: parsed };
    });
  }

  /** Acceptance is append-only: accepting never mutates or rewrites the envelope. */
  saveObjectiveHandoffAcceptance(record: ObjectiveHandoffAcceptanceRecord, options: { fingerprint: string }): ObjectiveHandoffAcceptanceResult {
    const parsed = parseObjectiveHandoffAcceptance(record);
    if (!isObjectiveHandoffAcceptanceHashValid(parsed)) throw new Error(`Objective handoff acceptance hash is invalid: ${parsed.id}`);
    if (options.fingerprint !== parsed.inputHash) throw new Error("Objective handoff acceptance fingerprint does not match its input hash");
    return this.durableTransaction(() => {
      const envelope = this.getObjectiveHandoff(parsed.envelopeId);
      if (!envelope || envelope.objectiveId !== parsed.objectiveId || envelope.runId !== parsed.runId) throw new Error("Objective handoff acceptance references missing or unrelated envelope");
      const priorByEnvelope = this.getObjectiveHandoffAcceptance(parsed.envelopeId);
      const priorByRequest = this.database.prepare("SELECT record_json FROM objective_handoff_acceptances WHERE run_id = ? AND request_key = ?").get(parsed.runId, parsed.requestKey) as Row | undefined;
      const prior = priorByEnvelope ?? (priorByRequest ? parseObjectiveHandoffAcceptance(parseJson(priorByRequest.record_json)) : null);
      if (prior) {
        if (prior.inputHash === parsed.inputHash && prior.requestKey === parsed.requestKey) return { status: "replayed", acceptance: prior };
        throw new Error(`Objective handoff acceptance idempotency conflict: ${parsed.runId}/${parsed.requestKey}`);
      }
      const inserted = this.database.prepare(`INSERT INTO objective_handoff_acceptances(id, envelope_id, objective_id, run_id, request_key, content_hash, record_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(parsed.id, parsed.envelopeId, parsed.objectiveId, parsed.runId, parsed.requestKey, parsed.contentHash, serialize(parsed), parsed.acceptedAt);
      if (Number(inserted.changes) !== 1) throw new Error(`Objective handoff acceptance insert failed: ${parsed.id}`);
      return { status: "committed", acceptance: parsed };
    });
  }

  private objectiveArtifactBase(id: string): ObjectiveArtifactRecord | null {
    const row = this.database.prepare("SELECT record_json FROM objective_artifacts WHERE id = ?").get(id) as Row | undefined;
    return row ? parseObjectiveArtifact(parseJson(row.record_json)) : null;
  }

  private objectiveArtifactCurrent(base: ObjectiveArtifactRecord): ObjectiveArtifactRecord {
    const row = this.database
      .prepare("SELECT record_json FROM objective_artifact_reviews WHERE artifact_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(base.id) as Row | undefined;
    if (!row) return base;
    const review = parseObjectiveArtifactReview(parseJson(row.record_json));
    return parseObjectiveArtifact({
      ...base,
      reviewState: review.state,
      reviewReason: review.reason,
      reviewedBy: review.actor,
      reviewedAt: review.createdAt,
    });
  }

  getObjectiveArtifact(id: string): ObjectiveArtifactRecord | null {
    const base = this.objectiveArtifactBase(id);
    return base ? this.objectiveArtifactCurrent(base) : null;
  }

  listObjectiveArtifacts(options: { runId?: string; objectiveId?: string; limit?: number } = {}): ObjectiveArtifactRecord[] {
    const limit = Math.min(options.limit ?? 500, 5_000);
    let sql = "SELECT record_json FROM objective_artifacts WHERE 1 = 1";
    const params: Array<string | number> = [];
    if (options.runId) { sql += " AND run_id = ?"; params.push(options.runId); }
    if (options.objectiveId) { sql += " AND objective_id = ?"; params.push(options.objectiveId); }
    sql += " ORDER BY published_at ASC, id ASC LIMIT ?";
    params.push(limit);
    return (this.database.prepare(sql).all(...params) as Row[])
      .map((row) => this.objectiveArtifactCurrent(parseObjectiveArtifact(parseJson(row.record_json))));
  }

  listObjectiveArtifactReviews(artifactId: string): ObjectiveArtifactReviewRecord[] {
    return (this.database
      .prepare("SELECT record_json FROM objective_artifact_reviews WHERE artifact_id = ? ORDER BY sequence ASC")
      .all(artifactId) as Row[]).map((row) => parseObjectiveArtifactReview(parseJson(row.record_json)));
  }

  getObjectiveArtifactReceipt(requestKey: string): ObjectiveArtifactReceiptRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_artifact_receipts WHERE request_key = ?")
      .get(requestKey) as Row | undefined;
    return row ? parseObjectiveArtifactReceipt(parseJson(row.record_json)) : null;
  }

  /** Persist one daemon-computed artifact publication and its idempotency receipt. */
  publishObjectiveArtifact(
    record: ObjectiveArtifactRecord,
    options: { requestKey: string; fingerprint: string },
  ): ObjectiveArtifactPublishResult {
    const parsed = parseObjectiveArtifact(record);
    if (parsed.reviewState !== "pending" || parsed.reviewReason !== null || parsed.reviewedBy !== null || parsed.reviewedAt !== null) {
      throw new Error("Objective artifact publication must begin in pending review state");
    }
    if (objectiveArtifactContentHash(parsed.content) !== parsed.hash) throw new Error("Objective artifact hash does not match canonical content");
    const size = objectiveArtifactContentSize(parsed.content);
    if (size !== parsed.sizeBytes || size > OBJECTIVE_ARTIFACT_MAX_INLINE_BYTES) throw new Error("Objective artifact size does not match canonical content");
    const run = this.getObjectiveRun(parsed.runId);
    if (!run) throw new Error(`Cannot publish an artifact for missing objective run: ${parsed.runId}`);
    if (run.objectiveId !== parsed.objectiveId) throw new Error("Objective artifact objective identity mismatch");
    if (parsed.planRevision > run.activePlanRevision) throw new Error("Objective artifact cannot reference a future plan revision");
    for (const lineageId of parsed.lineage) {
      const lineage = this.objectiveArtifactBase(lineageId);
      if (!lineage || lineage.runId !== parsed.runId || lineage.objectiveId !== parsed.objectiveId) throw new Error("Objective artifact lineage must remain in the same objective run");
    }
    if (parsed.supersedes) {
      const superseded = this.objectiveArtifactBase(parsed.supersedes);
      if (!superseded || superseded.runId !== parsed.runId || superseded.objectiveId !== parsed.objectiveId) throw new Error("Objective artifact supersedes must remain in the same objective run");
    }

    return this.durableTransaction(() => {
      const existingReceipt = this.getObjectiveArtifactReceipt(options.requestKey);
      if (existingReceipt) {
        if (existingReceipt.operation !== "publish" || existingReceipt.fingerprint !== options.fingerprint
          || existingReceipt.runId !== parsed.runId || existingReceipt.objectiveId !== parsed.objectiveId) throw new Error("Objective artifact publication idempotency conflict");
        const replay = this.getObjectiveArtifact(existingReceipt.artifactId);
        if (!replay) throw new Error("Objective artifact publication receipt points to missing artifact");
        const superseded = replay.supersedes
          ? this.listObjectiveArtifactReviews(replay.supersedes).filter((entry) => entry.state === "superseded")
          : [];
        return { status: "replayed", artifact: replay, superseded };
      }
      if (this.objectiveArtifactBase(parsed.id)) throw new Error(`Objective artifact id already exists: ${parsed.id}`);
      this.database.prepare(
        `INSERT INTO objective_artifacts(
          id, run_id, objective_id, plan_revision, hash, kind, name, media_type,
          size_bytes, content_json, evidence_json, lineage_json, supersedes,
          record_json, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        parsed.id, parsed.runId, parsed.objectiveId, parsed.planRevision, parsed.hash, parsed.kind, parsed.name,
        parsed.mediaType, parsed.sizeBytes, serialize(parsed.content), serialize(parsed.evidence), serialize(parsed.lineage),
        parsed.supersedes, serialize(parsed), parsed.publishedAt,
      );
      const supersededReviews: ObjectiveArtifactReviewRecord[] = [];
      if (parsed.supersedes) {
        const old = this.objectiveArtifactCurrent(this.objectiveArtifactBase(parsed.supersedes) as ObjectiveArtifactRecord);
        if (old.reviewState !== "superseded") {
          const review = parseObjectiveArtifactReview({
            version: 1,
            id: `${parsed.id}:supersedes:${old.id}`,
            artifactId: old.id,
            objectiveId: parsed.objectiveId,
            runId: parsed.runId,
            fromState: old.reviewState,
            state: "superseded",
            actor: parsed.publishedBy,
            reason: `Superseded by artifact ${parsed.id}`,
            requestKey: `${options.requestKey}:supersedes:${old.id}`,
            createdAt: parsed.publishedAt,
          });
          this.insertObjectiveArtifactReview(review);
          supersededReviews.push(review);
        }
      }
      const receipt: ObjectiveArtifactReceiptRecord = {
        version: 1,
        requestKey: options.requestKey,
        operation: "publish",
        fingerprint: options.fingerprint,
        runId: parsed.runId,
        objectiveId: parsed.objectiveId,
        artifactId: parsed.id,
        createdAt: parsed.publishedAt,
      };
      this.database.prepare(
        `INSERT INTO objective_artifact_receipts(request_key, operation, fingerprint, run_id, objective_id, artifact_id, record_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(receipt.requestKey, receipt.operation, receipt.fingerprint, receipt.runId, receipt.objectiveId, receipt.artifactId, serialize(receipt), receipt.createdAt);
      return { status: "committed", artifact: parsed, superseded: supersededReviews };
    });
  }

  /** Append one review transition with a compare-and-swap state fence. */
  reviewObjectiveArtifact(
    review: ObjectiveArtifactReviewRecord,
    options: { fingerprint: string },
  ): ObjectiveArtifactReviewResult {
    const parsed = parseObjectiveArtifactReview(review);
    return this.durableTransaction(() => {
      const existingReceipt = this.getObjectiveArtifactReceipt(parsed.requestKey);
      if (existingReceipt) {
        if (existingReceipt.operation !== "review" || existingReceipt.fingerprint !== options.fingerprint
          || existingReceipt.artifactId !== parsed.artifactId) throw new Error("Objective artifact review idempotency conflict");
        const replay = this.getObjectiveArtifact(existingReceipt.artifactId);
        if (!replay) throw new Error("Objective artifact review receipt points to missing artifact");
        const prior = this.listObjectiveArtifactReviews(parsed.artifactId).at(-1) ?? null;
        return { status: "replayed", artifact: replay, review: prior };
      }
      const base = this.objectiveArtifactBase(parsed.artifactId);
      if (!base) throw new Error(`Objective artifact not found: ${parsed.artifactId}`);
      if (base.runId !== parsed.runId || base.objectiveId !== parsed.objectiveId) throw new Error("Objective artifact review identity mismatch");
      const current = this.objectiveArtifactCurrent(base);
      if (current.reviewState !== parsed.fromState) throw new Error("Objective artifact review state is stale");
      if (current.reviewState === parsed.state) throw new Error("Objective artifact is already in the requested review state");
      if (parsed.state !== "superseded" && current.reviewState !== "pending") throw new Error("Verified or rejected artifacts can only transition to superseded");
      const prior = this.listObjectiveArtifactReviews(parsed.artifactId).at(-1);
      const expectedSequence = (prior?.id ? this.listObjectiveArtifactReviews(parsed.artifactId).length : 0) + 1;
      const stored = parseObjectiveArtifactReview({ ...parsed, id: parsed.id, fromState: current.reviewState });
      this.insertObjectiveArtifactReview(stored, expectedSequence);
      const receipt: ObjectiveArtifactReceiptRecord = {
        version: 1,
        requestKey: parsed.requestKey,
        operation: "review",
        fingerprint: options.fingerprint,
        runId: parsed.runId,
        objectiveId: parsed.objectiveId,
        artifactId: parsed.artifactId,
        createdAt: parsed.createdAt,
      };
      this.database.prepare(
        `INSERT INTO objective_artifact_receipts(request_key, operation, fingerprint, run_id, objective_id, artifact_id, record_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(receipt.requestKey, receipt.operation, receipt.fingerprint, receipt.runId, receipt.objectiveId, receipt.artifactId, serialize(receipt), receipt.createdAt);
      return { status: "committed", artifact: this.getObjectiveArtifact(parsed.artifactId) as ObjectiveArtifactRecord, review: stored };
    });
  }

  private insertObjectiveArtifactReview(review: ObjectiveArtifactReviewRecord, sequence?: number): void {
    const nextSequence = sequence ?? (Number((this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM objective_artifact_reviews WHERE artifact_id = ?").get(review.artifactId) as Row).sequence ?? 0) + 1);
    const result = this.database.prepare(
      `INSERT INTO objective_artifact_reviews(
        id, artifact_id, run_id, objective_id, sequence, from_state, state,
        actor_type, actor_id, reason, request_key, record_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(review.id, review.artifactId, review.runId, review.objectiveId, nextSequence, review.fromState, review.state, review.actor.type, review.actor.id, review.reason, review.requestKey, serialize(review), review.createdAt);
    if (Number(result.changes) !== 1) throw new Error(`Objective artifact review append failed: ${review.artifactId}`);
  }

  private insertObjectiveControlRevision(record: ObjectiveControlPlanRevision): void {
    const result = this.database
      .prepare(
        `INSERT INTO objective_control_plan_revisions(
           id, run_id, objective_id, plan_id, revision, source_json, plan_hash,
           plan_json, created_by_type, created_by_id, request_key, record_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${record.planId}:${record.revision}`,
        record.runId,
        record.objectiveId,
        record.planId,
        record.revision,
        serialize(record.source),
        record.hash,
        serialize(record.plan),
        record.createdBy.type,
        record.createdBy.id,
        record.requestKey,
        serialize(record),
        record.createdAt,
      );
    if (Number(result.changes) !== 1) throw new Error(`Objective control-plan revision insert failed: ${record.runId}/${record.revision}`);
  }

  private insertObjectiveControlSnapshot(snapshot: ObjectiveControlPlanSnapshot): void {
    const result = this.database
      .prepare(
        `INSERT INTO objective_control_snapshots(
           run_id, sequence, plan_id, objective_id, plan_revision, event_cursor,
           record_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.runId,
        snapshot.sequence,
        snapshot.planId,
        snapshot.objectiveId,
        snapshot.planRevision,
        snapshot.eventCursor,
        serialize(snapshot),
        snapshot.createdAt,
      );
    if (Number(result.changes) !== 1) throw new Error(`Objective control snapshot insert failed: ${snapshot.runId}/${snapshot.sequence}`);
  }

  /** Append a checkpoint; existing sequence numbers and request keys never mutate. */
  appendObjectiveCheckpoint(record: ObjectiveCheckpointRecord): boolean {
    const parsed = ObjectiveCheckpointRecordSchema.parse(record);
    return this.transaction(() => {
      const run = this.getObjectiveRun(parsed.runId);
      if (!run) throw new Error(`Cannot append a checkpoint for missing objective run: ${parsed.runId}`);
      if (run.objectiveId !== parsed.objectiveId) throw new Error("Objective checkpoint identity does not match its run");
      if (run.policy && (parsed.policyHash ?? null) !== run.policyHash) {
        throw new Error("Objective checkpoint policy hash does not match its run");
      }
      if (parsed.planRevision > run.activePlanRevision) throw new Error("Checkpoint cannot reference a future plan revision");
      const portable = parsed.objectiveRevision !== undefined || parsed.workflowRevision !== undefined || parsed.workflowHash !== undefined;
      if (portable) {
        ObjectivePortableCheckpointRecordSchema.parse(parsed);
        if (parsed.objectiveRevision !== (run.objectiveRevision ?? 1)) {
          throw new Error("Portable objective checkpoint revision does not match its run");
        }
        if (parsed.workflowRevision !== run.workflowRevision || parsed.workflowHash !== run.workflowHash) {
          throw new Error("Portable objective checkpoint workflow identity does not match its run");
        }
        if (parsed.controlPlanRevision === undefined || parsed.controlPlanRevision === null) {
          if (parsed.controlPlanHash !== null) throw new Error("Portable objective checkpoint has a control-plan hash without a revision");
          if (parsed.treeExecution !== null) throw new Error("Portable objective checkpoint has tree execution without a control-plan revision");
        } else {
          const controlRevision = this.getObjectiveControlPlanRevision(parsed.runId, parsed.controlPlanRevision);
          if (!controlRevision || controlRevision.hash !== parsed.controlPlanHash) {
            throw new Error("Portable objective checkpoint control-plan revision/hash is not provable");
          }
          if (parsed.treeExecution && (
            parsed.treeExecution.planId !== controlRevision.planId
            || parsed.treeExecution.planRevision !== controlRevision.revision
            || parsed.treeExecution.objectiveId !== parsed.objectiveId
            || parsed.treeExecution.runId !== parsed.runId
          )) throw new Error("Portable objective checkpoint tree execution does not match its control plan");
          if (parsed.treeExecution) {
            const committedTree = this.getObjectiveControlSnapshot(parsed.runId, parsed.treeExecution.sequence);
            if (!committedTree || !objectiveRecordEquivalent(committedTree, parsed.treeExecution)) {
              throw new Error("Portable objective checkpoint tree execution is not the committed control snapshot");
            }
          }
        }
        if (parsed.flatExecution) {
          const flatTaskStates = Object.fromEntries(parsed.flatExecution.tasks.map((task) => [task.task.id, task.state]));
          if (stableSerialize(flatTaskStates) !== stableSerialize(parsed.taskStates)) {
            throw new Error("Portable objective checkpoint flat execution does not match committed task states");
          }
          if (stableSerialize(parsed.flatExecution.context) !== stableSerialize(parsed.context)) {
            throw new Error("Portable objective checkpoint flat execution does not match committed context");
          }
          if (stableSerialize(parsed.flatExecution.outputs) !== stableSerialize(parsed.outputs ?? {})) {
            throw new Error("Portable objective checkpoint flat execution does not match committed outputs");
          }
        }
        if (parsed.policySnapshotHash !== (run.policyHash ?? null)) {
          throw new Error("Portable objective checkpoint policy snapshot does not match its run");
        }
        const canonicalGrant = parsed.workspaceEvidence?.canonicalGrant ?? null;
        const runGrant = run.policy?.workspace ?? null;
        if (stableSerialize(canonicalGrant) !== stableSerialize(runGrant)) {
          throw new Error("Portable objective checkpoint workspace grant does not match its run");
        }
        if (parsed.provenance && (
          parsed.provenance.actor.type !== parsed.createdBy.type
          || parsed.provenance.actor.id !== parsed.createdBy.id
        )) {
          throw new Error("Portable objective checkpoint provenance actor does not match createdBy");
        }
        const artifactRefs = parsed.artifactHashes ?? [];
        const knownArtifactHashes = new Set(this.listObjectiveArtifacts({ objectiveId: parsed.objectiveId, limit: 2_000 }).map((artifact) => artifact.hash));
        for (const artifactRef of artifactRefs) {
          if (typeof artifactRef === "string") {
            if (!knownArtifactHashes.has(artifactRef)) throw new Error(`Portable objective checkpoint artifact hash is not provable in this objective: ${artifactRef}`);
            continue;
          }
          const artifact = this.getObjectiveArtifact(artifactRef.id);
          if (!artifact || artifact.objectiveId !== parsed.objectiveId || artifact.hash !== artifactRef.hash) {
            throw new Error(`Portable objective checkpoint artifact lineage is not provable: ${artifactRef.id}`);
          }
        }
        const nativeAgents = new Set(this.listAgents({ runId: parsed.runId, limit: 2_000 }).map((agent) => agent.id));
        for (const session of parsed.nativeSessions ?? []) {
          if (!nativeAgents.has(session.agentId)) throw new Error(`Portable objective checkpoint references an agent outside its run: ${session.agentId}`);
        }
      }
      const runTaskIds = new Set(run.tasks.map((task) => task.task.id));
      const checkpointTaskIds = Object.keys(parsed.taskStates);
      if (checkpointTaskIds.some((taskId) => !runTaskIds.has(taskId)) || checkpointTaskIds.length !== runTaskIds.size) {
        throw new Error("Objective checkpoint task states must cover the current objective plan");
      }
      const latestPlan = this.database
        .prepare("SELECT plan_revision FROM objective_checkpoints WHERE run_id = ? ORDER BY sequence DESC LIMIT 1")
        .get(parsed.runId) as Row | undefined;
      if (latestPlan && parsed.planRevision < Number(latestPlan.plan_revision)) {
        throw new Error(`Objective checkpoint plan revision cannot move backwards from ${Number(latestPlan.plan_revision)}`);
      }
      const collisions = [
        this.database.prepare("SELECT record_json FROM objective_checkpoints WHERE id = ?").get(parsed.id) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_checkpoints WHERE run_id = ? AND request_key = ?").get(parsed.runId, parsed.requestKey) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_checkpoints WHERE run_id = ? AND sequence = ?").get(parsed.runId, parsed.sequence) as Row | undefined,
      ].filter((row): row is Row => row !== undefined);
      if (collisions.length > 0) {
        if (collisions.every((row) => objectiveRecordEquivalent(ObjectiveCheckpointRecordSchema.parse(parseJson(row.record_json)), parsed))) {
          return false;
        }
        throw new Error(`Objective checkpoint idempotency conflict: ${parsed.runId}/${parsed.sequence}`);
      }
      const previousCheckpoint = this.database
        .prepare("SELECT event_cursor, record_json FROM objective_checkpoints WHERE run_id = ? ORDER BY sequence DESC LIMIT 1")
        .get(parsed.runId) as Row | undefined;
      if (previousCheckpoint && parsed.eventCursor < Number(previousCheckpoint.event_cursor)) {
        throw new Error(`Objective checkpoint event cursor cannot move backwards from ${Number(previousCheckpoint.event_cursor)}`);
      }
      if (previousCheckpoint && portable) {
        const previous = ObjectiveCheckpointRecordSchema.parse(parseJson(previousCheckpoint.record_json));
        if (
          parsed.attemptHighWater !== undefined
          && previous.attemptHighWater !== undefined
          && parsed.attemptHighWater < previous.attemptHighWater
        ) throw new Error("Portable objective checkpoint attempt high-water cannot move backwards");
        if (
          parsed.eventHighWater !== undefined
          && previous.eventHighWater !== undefined
          && parsed.eventHighWater < previous.eventHighWater
        ) throw new Error("Portable objective checkpoint event high-water cannot move backwards");
      }
      const previous = this.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM objective_checkpoints WHERE run_id = ?")
        .get(parsed.runId) as Row;
      if (parsed.sequence !== Number(previous.sequence ?? 0) + 1) {
        throw new Error(`Objective checkpoint sequence must be ${Number(previous.sequence ?? 0) + 1}`);
      }
      const inserted = this.database
        .prepare(
          `INSERT INTO objective_checkpoints(
             id, run_id, objective_id, sequence, plan_revision, event_cursor,
             context_json, task_states_json, criteria_json, context_hash, reason,
             created_by_type, created_by_id, request_key, record_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.runId,
          parsed.objectiveId,
          parsed.sequence,
          parsed.planRevision,
          parsed.eventCursor,
          serialize(parsed.context),
          serialize(parsed.taskStates),
          serialize(parsed.criteria),
          parsed.contextHash,
          parsed.reason,
          parsed.createdBy.type,
          parsed.createdBy.id,
          parsed.requestKey,
          serialize(parsed),
          parsed.createdAt,
        );
      if (Number(inserted.changes) !== 1) return false;
      const nextRun = ObjectiveRunRecordSchema.parse({ ...run, latestCheckpointId: parsed.id, updatedAt: parsed.createdAt });
      this.database
        .prepare("UPDATE objective_runs SET latest_checkpoint_id = ?, record_json = ?, updated_at = ? WHERE run_id = ?")
        .run(parsed.id, serialize(nextRun), nextRun.updatedAt, parsed.runId);
      return true;
    });
  }

  getObjectiveCheckpoint(runId: string, id: string): ObjectiveCheckpointRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_checkpoints WHERE run_id = ? AND id = ?")
      .get(runId, id) as Row | undefined;
    return row ? ObjectiveCheckpointRecordSchema.parse(parseJson(row.record_json)) : null;
  }

  listObjectiveCheckpoints(runId: string): ObjectiveCheckpointRecord[] {
    return (this.database
      .prepare("SELECT record_json FROM objective_checkpoints WHERE run_id = ? ORDER BY sequence ASC")
      .all(runId) as Row[]).map((row) => ObjectiveCheckpointRecordSchema.parse(parseJson(row.record_json)));
  }

  /** Insert an approval request once; resolution uses updateObjectiveApproval CAS. */
  saveObjectiveApproval(record: ObjectiveApprovalRecord): boolean {
    const parsed = ObjectiveApprovalRecordSchema.parse(record);
    const run = this.getObjectiveRun(parsed.runId);
    if (!run) throw new Error(`Cannot save an approval for missing objective run: ${parsed.runId}`);
    if (run.objectiveId !== parsed.objectiveId) throw new Error("Objective approval identity does not match its run");
    if (parsed.planRevision > run.activePlanRevision) throw new Error("Objective approval cannot reference a future plan revision");
    if (parsed.taskId !== null && !run.tasks.some((task) => task.task.id === parsed.taskId)) {
      throw new Error(`Objective approval references unknown task: ${parsed.taskId}`);
    }
    const collisions = [
      this.database.prepare("SELECT record_json FROM objective_approvals WHERE id = ?").get(parsed.id) as Row | undefined,
      this.database.prepare("SELECT record_json FROM objective_approvals WHERE run_id = ? AND request_key = ?").get(parsed.runId, parsed.requestKey) as Row | undefined,
      ].filter((row): row is Row => row !== undefined);
      if (collisions.length > 0) {
        if (collisions.every((row) => objectiveRecordEquivalent(parseObjectiveApproval(parseJson(row.record_json)), parsed))) {
        return false;
      }
      throw new Error(`Objective approval idempotency conflict: ${parsed.runId}/${parsed.id}`);
    }
    const result = this.database
      .prepare(
        `INSERT INTO objective_approvals(
           id, run_id, objective_id, plan_revision, kind, task_id, status,
           operation_id, request_hash, policy_hash, side_effect_class,
           canonical_target, expires_at,
           requested_by_type, requested_by_id, decided_by_type, decided_by_id,
           request_key, record_json, requested_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.runId,
        parsed.objectiveId,
        parsed.planRevision,
        parsed.kind,
        parsed.taskId,
        parsed.status,
        parsed.operationId,
        parsed.requestHash,
        parsed.policyHash,
        parsed.sideEffectClass,
        parsed.canonicalTarget,
        parsed.expiresAt,
        parsed.requestedBy.type,
        parsed.requestedBy.id,
        parsed.decidedBy?.type ?? null,
        parsed.decidedBy?.id ?? null,
        parsed.requestKey,
        serialize(parsed),
        parsed.requestedAt,
        parsed.resolvedAt,
      );
    return Number(result.changes) === 1;
  }

  updateObjectiveApproval(record: ObjectiveApprovalRecord, options: { expectedStatus: ObjectiveApprovalRecord["status"] }): boolean {
    const parsed = ObjectiveApprovalRecordSchema.parse(record);
    const existing = this.getObjectiveApproval(parsed.runId, parsed.id);
    if (!existing) throw new Error(`Cannot update missing objective approval: ${parsed.id}`);
    assertObjectiveApprovalIdentity(existing, parsed);
    const result = this.database
      .prepare(
        `UPDATE objective_approvals SET
           status = ?, decided_by_type = ?, decided_by_id = ?,
           record_json = ?, resolved_at = ?
         WHERE run_id = ? AND id = ? AND status = ?`,
      )
      .run(
        parsed.status,
        parsed.decidedBy?.type ?? null,
        parsed.decidedBy?.id ?? null,
        serialize(parsed),
        parsed.resolvedAt,
        parsed.runId,
        parsed.id,
        options.expectedStatus,
      );
    return Number(result.changes) === 1;
  }

  getObjectiveApproval(runId: string, id: string): ObjectiveApprovalRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_approvals WHERE run_id = ? AND id = ?")
      .get(runId, id) as Row | undefined;
    return row ? parseObjectiveApproval(parseJson(row.record_json)) : null;
  }

  listObjectiveApprovals(options: {
    runId?: string;
    status?: ObjectiveApprovalRecord["status"][];
    limit?: number;
    /** Durable due-date filter. NULL expiries are always excluded. */
    expiresAtLte?: string;
  } = {}): ObjectiveApprovalRecord[] {
    const limit = Math.min(options.limit ?? 200, 2_000);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.runId) {
      clauses.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.status?.length) {
      clauses.push(`status IN (${options.status.map(() => "?").join(",")})`);
      params.push(...options.status);
    }
    if (options.expiresAtLte !== undefined) {
      // julianday understands ISO-8601 offsets, unlike a lexical TEXT
      // comparison. Keep the NULL predicate explicit so non-expiring
      // approvals cannot enter a due-date scan.
      clauses.push("expires_at IS NOT NULL AND julianday(expires_at) <= julianday(?)");
      params.push(options.expiresAtLte);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const order = options.expiresAtLte === undefined
      ? "requested_at ASC, id ASC"
      : "julianday(expires_at) ASC, requested_at ASC, id ASC";
    return (this.database
      .prepare(`SELECT record_json FROM objective_approvals${where} ORDER BY ${order} LIMIT ?`)
      .all(...params, limit) as Row[]).map((row) => parseObjectiveApproval(parseJson(row.record_json)));
  }

  /** Insert one immutable attention item. Replaying the same request is a no-op. */
  saveObjectiveAttention(record: ObjectiveAttentionRecord): boolean {
    const parsed = parseObjectiveAttention(record);
    const run = this.getObjectiveRun(parsed.runId);
    if (!run) throw new Error(`Cannot save attention for missing objective run: ${parsed.runId}`);
    if (run.objectiveId !== parsed.objectiveId) throw new Error("Objective attention identity does not match its run");
    if (parsed.nodeId !== null && run.tasks.length > 0
      && !run.tasks.some((task) => task.task.id === parsed.nodeId)
      && !this.objectiveControlNodeExists(parsed.runId, parsed.nodeId)) {
      throw new Error(`Objective attention references unknown node: ${parsed.nodeId}`);
    }
    if (parsed.attemptId !== null) {
      const attempt = this.database.prepare("SELECT run_id, step_id FROM step_attempts WHERE id = ?").get(parsed.attemptId) as Row | undefined;
      if (attempt && (attempt.run_id !== parsed.runId || (parsed.nodeId !== null && attempt.step_id !== parsed.nodeId))) {
        throw new Error(`Objective attention attempt binding does not match its run/node: ${parsed.attemptId}`);
      }
    }
    const collisions = [
      this.database.prepare("SELECT record_json FROM objective_attentions WHERE id = ?").get(parsed.id) as Row | undefined,
      this.database.prepare("SELECT record_json FROM objective_attentions WHERE run_id = ? AND request_key = ?").get(parsed.runId, parsed.requestKey) as Row | undefined,
    ].filter((row): row is Row => row !== undefined);
    if (collisions.length > 0) {
      if (collisions.every((row) => objectiveRecordEquivalent(parseObjectiveAttention(parseJson(row.record_json)), parsed))) return false;
      throw new Error(`Objective attention idempotency conflict: ${parsed.runId}/${parsed.id}`);
    }
    const result = this.database.prepare(
      `INSERT INTO objective_attentions(
         id, objective_id, run_id, node_id, attempt_id, status, request_key,
         expires_at, assignee_type, assignee_id, record_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      parsed.id,
      parsed.objectiveId,
      parsed.runId,
      parsed.nodeId,
      parsed.attemptId,
      parsed.status,
      parsed.requestKey,
      parsed.expiresAt,
      parsed.assignee?.type ?? null,
      parsed.assignee?.id ?? null,
      serialize(parsed),
      parsed.createdAt,
      parsed.updatedAt,
    );
    return Number(result.changes) === 1;
  }

  private objectiveControlNodeExists(runId: string, nodeId: string): boolean {
    const revisions = this.database
      .prepare("SELECT plan_json FROM objective_control_plan_revisions WHERE run_id = ?")
      .all(runId) as Row[];
    return revisions.some((row) => controlPlanValueContainsNode(parseJson(row.plan_json), nodeId));
  }

  /** Compare-and-swap settlement. The immutable request body is rechecked. */
  updateObjectiveAttention(
    record: ObjectiveAttentionRecord,
    options: { expectedStatus?: ObjectiveAttentionStatus } = {},
  ): boolean {
    const parsed = parseObjectiveAttention(record);
    const existing = this.getObjectiveAttention(parsed.id);
    if (!existing || existing.runId !== parsed.runId) return false;
    assertObjectiveAttentionIdentity(existing, parsed);
    const expectedStatus = options.expectedStatus ?? "open";
    if (expectedStatus !== "open" || parsed.status === "open") {
      throw new Error(`Objective attention records can only settle once from open: ${parsed.id}`);
    }
    const result = this.database.prepare(
      `UPDATE objective_attentions
       SET status = ?, record_json = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND status = ?`,
    ).run(parsed.status, serialize(parsed), parsed.updatedAt, parsed.id, parsed.runId, expectedStatus);
    return Number(result.changes) === 1;
  }

  /** Explicitly named alias for callers that model settlement as resolution. */
  resolveObjectiveAttention(record: ObjectiveAttentionRecord): boolean {
    return this.updateObjectiveAttention(record, { expectedStatus: "open" });
  }

  getObjectiveAttention(id: string, runId?: string): ObjectiveAttentionRecord | null {
    const row = runId === undefined
      ? this.database.prepare("SELECT record_json FROM objective_attentions WHERE id = ?").get(id) as Row | undefined
      : this.database.prepare("SELECT record_json FROM objective_attentions WHERE id = ? AND run_id = ?").get(id, runId) as Row | undefined;
    return row ? parseObjectiveAttention(parseJson(row.record_json)) : null;
  }

  listObjectiveAttentions(options: {
    objectiveId?: string;
    runId?: string;
    nodeId?: string;
    attemptId?: string;
    status?: readonly ObjectiveAttentionStatus[];
    assigneeId?: string;
    expiresAtLte?: string;
    limit?: number;
  } = {}): ObjectiveAttentionRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.objectiveId) { clauses.push("objective_id = ?"); params.push(options.objectiveId); }
    if (options.runId) { clauses.push("run_id = ?"); params.push(options.runId); }
    if (options.nodeId) { clauses.push("node_id = ?"); params.push(options.nodeId); }
    if (options.attemptId) { clauses.push("attempt_id = ?"); params.push(options.attemptId); }
    if (options.status?.length) {
      clauses.push(`status IN (${options.status.map(() => "?").join(",")})`);
      params.push(...options.status);
    }
    if (options.assigneeId) { clauses.push("assignee_id = ?"); params.push(options.assigneeId); }
    if (options.expiresAtLte) {
      clauses.push("expires_at IS NOT NULL AND julianday(expires_at) <= julianday(?)");
      params.push(options.expiresAtLte);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(options.limit ?? 200, 2_000);
    const records = (this.database.prepare(
      // Apply the bounded read before sorting so a late critical item is not
      // hidden behind an older low-risk item when callers request a small page.
      `SELECT record_json FROM objective_attentions${where} ORDER BY updated_at ASC, id ASC LIMIT 2000`,
    ).all(...params) as Row[]).map((row) => parseObjectiveAttention(parseJson(row.record_json)));
    const riskRank: Record<ObjectiveAttentionRecord["risk"], number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const urgencyRank: Record<ObjectiveAttentionRecord["urgency"], number> = { critical: 0, high: 1, normal: 2, low: 3 };
    return records.sort((left, right) =>
      (left.status === "open" ? 0 : 1) - (right.status === "open" ? 0 : 1)
      || riskRank[left.risk] - riskRank[right.risk]
      || urgencyRank[left.urgency] - urgencyRank[right.urgency]
      || left.updatedAt.localeCompare(right.updatedAt)
      || left.id.localeCompare(right.id),
    ).slice(0, limit);
  }

  /** Settle all due open items in one durable transaction; repeated scans are safe. */
  expireObjectiveAttentions(
    now: string,
    resolvedBy: { type: "user" | "agent" | "system"; id: string } = { type: "system", id: "attention-expiry" },
  ): ObjectiveAttentionRecord[] {
    const due = this.listObjectiveAttentions({ status: ["open"], expiresAtLte: now, limit: 2_000 });
    const expired: ObjectiveAttentionRecord[] = [];
    this.transaction(() => {
      for (const item of due) {
        const current = this.getObjectiveAttention(item.id);
        if (!current || current.status !== "open" || current.expiresAt === null || Date.parse(current.expiresAt) > Date.parse(now)) continue;
        const next = parseObjectiveAttention({
          ...current,
          status: "expired",
          updatedAt: now,
          resolution: {
            receiptId: `attention-expiry:${current.id}`,
            requestKey: `attention-expiry:${current.id}`,
            status: "expired",
            decision: null,
            resolvedBy,
            resolvedAt: now,
            evidenceRefs: [],
          },
        });
        if (this.updateObjectiveAttention(next, { expectedStatus: "open" })) expired.push(next);
      }
    });
    return expired;
  }

  /**
   * Validate that a budget record is attached to a verified, immutable policy.
   * Legacy objective rows intentionally cannot acquire a budget implicitly:
   * callers must first create a new objective with an explicit policy.
   */
  private assertObjectiveBudgetAuthority(
    runId: string,
    objectiveId: string,
    policyHash: string,
  ): ObjectiveRunRecord {
    const run = this.getObjectiveRun(runId);
    if (!run) throw new Error(`Cannot store a budget record for missing objective run: ${runId}`);
    if (run.objectiveId !== objectiveId) throw new Error("Objective budget identity does not match its run");
    if (!run.policy || !run.policyHash) {
      throw new Error(`Objective run ${runId} has no verified policy snapshot; budget accounting is unavailable for legacy history`);
    }
    if (run.policyHash !== policyHash || run.policy.policyHash !== policyHash) {
      throw new Error(`Objective budget policy hash does not match its run: ${runId}`);
    }
    ObjectivePolicySnapshotSchema.parse(run.policy);
    return run;
  }

  private assertBudgetLedgerFits(record: ObjectiveBudgetLedgerRecord): void {
    const total = addBudgetUsage(record.consumed, record.reserved);
    if (!budgetWithinLimits(total, record.limits)) {
      throw new Error(`Objective budget ledger exceeds its immutable limits: ${record.runId}`);
    }
    if (record.status === "exhausted" && !budgetExhausted(record.consumed, record.limits)) {
      throw new Error(`Objective budget ledger cannot be exhausted before a limit is reached: ${record.runId}`);
    }
  }

  /** Insert the initial aggregate. There is deliberately no implicit zero ledger. */
  saveObjectiveBudgetLedger(record: ObjectiveBudgetLedgerRecord): boolean {
    const parsed = parseObjectiveBudgetLedger(record);
    this.assertObjectiveBudgetAuthority(parsed.runId, parsed.objectiveId, parsed.policyHash);
    this.assertBudgetLedgerFits(parsed);
    if (parsed.revision !== 0) throw new Error("Initial objective budget ledger revision must be zero");
    const existing = this.getObjectiveBudgetLedger(parsed.runId);
    if (existing) {
      if (objectiveRecordEquivalent(existing, parsed)) return false;
      throw new Error(`Objective budget ledger identity is immutable: ${parsed.runId}`);
    }
    const result = this.database
      .prepare(
        `INSERT INTO objective_budget_ledgers(
           run_id, objective_id, policy_hash, revision, status,
           record_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.runId,
        parsed.objectiveId,
        parsed.policyHash,
        parsed.revision,
        parsed.status,
        serialize(parsed),
        parsed.createdAt,
        parsed.updatedAt,
      );
    return Number(result.changes) === 1;
  }

  getObjectiveBudgetLedger(runId: string): ObjectiveBudgetLedgerRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_budget_ledgers WHERE run_id = ?")
      .get(runId) as Row | undefined;
    return row ? parseObjectiveBudgetLedger(parseJson(row.record_json)) : null;
  }

  /** Update mutable budget status/counters with a strict revision CAS. */
  updateObjectiveBudgetLedger(
    record: ObjectiveBudgetLedgerRecord,
    options: { expectedRevision: number },
  ): boolean {
    const parsed = parseObjectiveBudgetLedger(record);
    this.assertObjectiveBudgetAuthority(parsed.runId, parsed.objectiveId, parsed.policyHash);
    this.assertBudgetLedgerFits(parsed);
    const existing = this.getObjectiveBudgetLedger(parsed.runId);
    if (!existing) throw new Error(`Cannot update missing objective budget ledger: ${parsed.runId}`);
    if (
      existing.objectiveId !== parsed.objectiveId ||
      existing.policyHash !== parsed.policyHash ||
      objectiveRecordEquivalent(existing.limits, parsed.limits) === false ||
      parsed.revision !== options.expectedRevision + 1
    ) {
      if (!objectiveRecordEquivalent(existing.limits, parsed.limits)) {
        throw new Error(`Objective budget limits are immutable: ${parsed.runId}`);
      }
      if (parsed.revision !== options.expectedRevision + 1) {
        throw new Error("Objective budget ledger revision must advance by exactly one");
      }
      throw new Error(`Objective budget ledger identity is immutable: ${parsed.runId}`);
    }
    const result = this.database
      .prepare(
        `UPDATE objective_budget_ledgers SET
           revision = ?, status = ?, record_json = ?, updated_at = ?
         WHERE run_id = ? AND revision = ?`,
      )
      .run(parsed.revision, parsed.status, serialize(parsed), parsed.updatedAt, parsed.runId, options.expectedRevision);
    return Number(result.changes) === 1;
  }

  private getObjectiveBudgetReservationForKey(runId: string, reservationKey: string): ObjectiveBudgetReservationRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_budget_reservations WHERE run_id = ? AND reservation_key = ?")
      .get(runId, reservationKey) as Row | undefined;
    return row ? parseObjectiveBudgetReservation(parseJson(row.record_json)) : null;
  }

  /** Resolve a deterministic reservation identity during objective recovery. */
  getObjectiveBudgetReservationByKey(runId: string, reservationKey: string): ObjectiveBudgetReservationRecord | null {
    return this.getObjectiveBudgetReservationForKey(runId, reservationKey);
  }

  getObjectiveBudgetReservation(runId: string, reservationId: string): ObjectiveBudgetReservationRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_budget_reservations WHERE run_id = ? AND id = ?")
      .get(runId, reservationId) as Row | undefined;
    return row ? parseObjectiveBudgetReservation(parseJson(row.record_json)) : null;
  }

  listObjectiveBudgetReservations(options: { runId?: string; limit?: number } = {}): ObjectiveBudgetReservationRecord[] {
    const limit = Math.min(options.limit ?? 200, 2_000);
    const rows = options.runId
      ? (this.database
          .prepare("SELECT record_json FROM objective_budget_reservations WHERE run_id = ? ORDER BY created_at ASC LIMIT ?")
          .all(options.runId, limit) as Row[])
      : (this.database
          .prepare("SELECT record_json FROM objective_budget_reservations ORDER BY created_at ASC LIMIT ?")
          .all(limit) as Row[]);
    return rows.map((row) => parseObjectiveBudgetReservation(parseJson(row.record_json)));
  }

  /**
   * Reserve before external work starts. The reservation key is the durable
   * logical attempt identity, so retrying the same dispatch cannot double
   * reserve capacity. The aggregate revision and reservation insert commit
   * atomically.
   */
  saveObjectiveBudgetReservation(
    record: ObjectiveBudgetReservationRecord,
    options: { expectedLedgerRevision?: number } = {},
  ): boolean {
    const parsed = parseObjectiveBudgetReservation(record);
    if (parsed.state !== "reserved") throw new Error("New objective budget reservations must be reserved");
    return this.transaction(() => {
      const run = this.assertObjectiveBudgetAuthority(parsed.runId, parsed.objectiveId, parsed.policyHash);
      const ledger = this.getObjectiveBudgetLedger(parsed.runId);
      if (!ledger) throw new Error(`Cannot reserve against missing objective budget ledger: ${parsed.runId}`);
      if (ledger.policyHash !== parsed.policyHash) throw new Error(`Objective budget policy hash does not match its ledger: ${parsed.runId}`);
      const collisions = [
        this.database.prepare("SELECT record_json FROM objective_budget_reservations WHERE id = ?").get(parsed.id) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_budget_reservations WHERE run_id = ? AND reservation_key = ?").get(parsed.runId, parsed.reservationKey) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_budget_reservations WHERE run_id = ? AND request_key = ?").get(parsed.runId, parsed.requestKey) as Row | undefined,
      ].filter((row): row is Row => row !== undefined);
      if (collisions.length > 0) {
        if (collisions.every((row) => objectiveRecordEquivalent(parseObjectiveBudgetReservation(parseJson(row.record_json)), parsed))) return false;
        throw new Error(`Objective budget reservation idempotency conflict: ${parsed.runId}/${parsed.reservationKey}`);
      }
      if (ledger.status !== "active") throw new Error(`Objective budget ledger is ${ledger.status}; new reservations are not allowed: ${parsed.runId}`);
      if (options.expectedLedgerRevision !== undefined && ledger.revision !== options.expectedLedgerRevision) return false;
      if (parsed.revision !== 0) throw new Error("Initial objective budget reservation revision must be zero");
      if (ledger.limits.maxConcurrentAgents !== null) {
        const active = this.database
          .prepare("SELECT COUNT(*) AS count FROM objective_budget_reservations WHERE run_id = ? AND state = 'reserved'")
          .get(parsed.runId) as Row;
        if (Number(active.count ?? 0) >= ledger.limits.maxConcurrentAgents) {
          throw new Error(`Objective budget concurrent-agent limit ${ledger.limits.maxConcurrentAgents} reached: ${parsed.runId}`);
        }
      }
      const nextReserved = addBudgetUsage(ledger.reserved, parsed.amount);
      const nextTotal = addBudgetUsage(ledger.consumed, nextReserved);
      if (!budgetWithinLimits(nextTotal, ledger.limits)) {
        throw new Error(`Objective budget reservation exceeds its immutable limits: ${parsed.runId}`);
      }
      const nextLedger = ObjectiveBudgetLedgerRecordSchema.parse({
        ...ledger,
        reserved: nextReserved,
        revision: ledger.revision + 1,
        updatedAt: parsed.updatedAt,
      });
      const inserted = this.database
        .prepare(
          `INSERT INTO objective_budget_reservations(
             id, run_id, objective_id, policy_hash, reservation_key,
             state, revision, request_key, record_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.runId,
          parsed.objectiveId,
          parsed.policyHash,
          parsed.reservationKey,
          parsed.state,
          parsed.revision,
          parsed.requestKey,
          serialize(parsed),
          parsed.createdAt,
          parsed.updatedAt,
        );
      if (Number(inserted.changes) !== 1) return false;
      const advanced = this.database
        .prepare(
          `UPDATE objective_budget_ledgers SET
             revision = ?, record_json = ?, updated_at = ?
           WHERE run_id = ? AND revision = ?`,
        )
        .run(nextLedger.revision, serialize(nextLedger), nextLedger.updatedAt, parsed.runId, ledger.revision);
      if (Number(advanced.changes) !== 1) throw new Error("Objective budget ledger CAS lost after reservation insert");
      void run;
      return true;
    });
  }

  /** Alias with an action-oriented name for callers at the runtime boundary. */
  reserveObjectiveBudget(record: ObjectiveBudgetReservationRecord, options: { expectedLedgerRevision?: number } = {}): boolean {
    return this.saveObjectiveBudgetReservation(record, options);
  }

  /** Release a held amount using both the reservation and aggregate CAS fences. */
  updateObjectiveBudgetReservation(
    record: ObjectiveBudgetReservationRecord,
    options: { expectedRevision: number; expectedLedgerRevision?: number },
  ): boolean {
    const parsed = parseObjectiveBudgetReservation(record);
    return this.transaction(() => {
      this.assertObjectiveBudgetAuthority(parsed.runId, parsed.objectiveId, parsed.policyHash);
      const existing = this.getObjectiveBudgetReservation(parsed.runId, parsed.id);
      if (!existing) throw new Error(`Cannot update missing objective budget reservation: ${parsed.id}`);
      if (
        existing.objectiveId !== parsed.objectiveId ||
        existing.policyHash !== parsed.policyHash ||
        existing.reservationKey !== parsed.reservationKey ||
        !objectiveRecordEquivalent(existing.amount, parsed.amount) ||
        parsed.revision !== options.expectedRevision + 1
      ) {
        throw new Error(`Objective budget reservation identity/revision conflict: ${parsed.id}`);
      }
      if (existing.state !== "reserved" || !["released", "cancelled"].includes(parsed.state)) {
        throw new Error(`Objective budget reservation cannot transition ${existing.state} to ${parsed.state}`);
      }
      const ledger = this.getObjectiveBudgetLedger(parsed.runId);
      if (!ledger) throw new Error(`Cannot update reservation for missing objective budget ledger: ${parsed.runId}`);
      if (options.expectedLedgerRevision !== undefined && ledger.revision !== options.expectedLedgerRevision) return false;
      const nextReserved = subtractBudgetUsage(ledger.reserved, existing.amount);
      const nextLedger = ObjectiveBudgetLedgerRecordSchema.parse({
        ...ledger,
        reserved: nextReserved,
        revision: ledger.revision + 1,
        updatedAt: parsed.updatedAt,
      });
      const updatedReservation = this.database
        .prepare(
          `UPDATE objective_budget_reservations SET
             state = ?, revision = ?, record_json = ?, updated_at = ?, released_at = ?
           WHERE run_id = ? AND id = ? AND revision = ? AND state = 'reserved'`,
        )
        .run(
          parsed.state,
          parsed.revision,
          serialize(parsed),
          parsed.updatedAt,
          parsed.releasedAt,
          parsed.runId,
          parsed.id,
          options.expectedRevision,
        );
      if (Number(updatedReservation.changes) !== 1) return false;
      const updatedLedger = this.database
        .prepare(
          `UPDATE objective_budget_ledgers SET revision = ?, record_json = ?, updated_at = ?
           WHERE run_id = ? AND revision = ?`,
        )
        .run(nextLedger.revision, serialize(nextLedger), nextLedger.updatedAt, parsed.runId, ledger.revision);
      if (Number(updatedLedger.changes) !== 1) throw new Error("Objective budget ledger CAS lost after reservation release");
      return true;
    });
  }

  releaseObjectiveBudgetReservation(
    record: ObjectiveBudgetReservationRecord,
    options: { expectedRevision: number; expectedLedgerRevision?: number },
  ): boolean {
    if (record.state !== "released" && record.state !== "cancelled") {
      throw new Error("Budget reservation release must use released or cancelled state");
    }
    return this.updateObjectiveBudgetReservation(record, options);
  }

  getObjectiveBudgetDebit(runId: string, debitId: string): ObjectiveBudgetDebitRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_budget_debits WHERE run_id = ? AND id = ?")
      .get(runId, debitId) as Row | undefined;
    return row ? parseObjectiveBudgetDebit(parseJson(row.record_json)) : null;
  }

  getObjectiveBudgetDebitByUsageEventKey(runId: string, usageEventKey: string): ObjectiveBudgetDebitRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_budget_debits WHERE run_id = ? AND usage_event_key = ?")
      .get(runId, usageEventKey) as Row | undefined;
    return row ? parseObjectiveBudgetDebit(parseJson(row.record_json)) : null;
  }

  listObjectiveBudgetDebits(options: { runId?: string; limit?: number } = {}): ObjectiveBudgetDebitRecord[] {
    const limit = Math.min(options.limit ?? 500, 5_000);
    const rows = options.runId
      ? (this.database
          .prepare("SELECT record_json FROM objective_budget_debits WHERE run_id = ? ORDER BY created_at ASC LIMIT ?")
          .all(options.runId, limit) as Row[])
      : (this.database
          .prepare("SELECT record_json FROM objective_budget_debits ORDER BY created_at ASC LIMIT ?")
          .all(limit) as Row[]);
    return rows.map((row) => parseObjectiveBudgetDebit(parseJson(row.record_json)));
  }

  /**
   * Debit actual known usage exactly once. A usage-event key is the replay
   * fence; reservation settlement and ledger consumption share its SQLite
   * transaction, so a crash cannot leave only half of the accounting update.
   */
  recordObjectiveBudgetDebit(
    record: ObjectiveBudgetDebitRecord,
    options: { expectedLedgerRevision?: number } = {},
  ): boolean {
    const parsed = parseObjectiveBudgetDebit(record);
    return this.transaction(() => {
      this.assertObjectiveBudgetAuthority(parsed.runId, parsed.objectiveId, parsed.policyHash);
      const ledger = this.getObjectiveBudgetLedger(parsed.runId);
      if (!ledger) throw new Error(`Cannot debit missing objective budget ledger: ${parsed.runId}`);
      if (ledger.policyHash !== parsed.policyHash) throw new Error(`Objective budget policy hash does not match its ledger: ${parsed.runId}`);
      const collisions = [
        this.database.prepare("SELECT record_json FROM objective_budget_debits WHERE id = ?").get(parsed.id) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_budget_debits WHERE run_id = ? AND usage_event_key = ?").get(parsed.runId, parsed.usageEventKey) as Row | undefined,
        this.database.prepare("SELECT record_json FROM objective_budget_debits WHERE run_id = ? AND request_key = ?").get(parsed.runId, parsed.requestKey) as Row | undefined,
      ].filter((row): row is Row => row !== undefined);
      if (collisions.length > 0) {
        if (collisions.every((row) => objectiveRecordEquivalent(parseObjectiveBudgetDebit(parseJson(row.record_json)), parsed))) return false;
        throw new Error(`Objective budget debit idempotency conflict: ${parsed.runId}/${parsed.usageEventKey}`);
      }
      if (options.expectedLedgerRevision !== undefined && ledger.revision !== options.expectedLedgerRevision) return false;
      if (ledger.status === "settled") throw new Error(`Objective budget ledger is already settled: ${parsed.runId}`);

      let nextReserved = ledger.reserved;
      let reservation: ObjectiveBudgetReservationRecord | null = null;
      if (parsed.reservationId !== null) {
        reservation = this.getObjectiveBudgetReservation(parsed.runId, parsed.reservationId);
        if (!reservation) throw new Error(`Objective budget reservation not found: ${parsed.reservationId}`);
        if (reservation.policyHash !== parsed.policyHash) throw new Error(`Objective budget reservation policy hash mismatch: ${parsed.reservationId}`);
        if (reservation.state !== "reserved") throw new Error(`Objective budget reservation is not reserved: ${parsed.reservationId}`);
        nextReserved = subtractBudgetUsage(ledger.reserved, reservation.amount);
      }
      const nextConsumed = addBudgetUsage(ledger.consumed, parsed.usage);
      if (!budgetWithinLimits(addBudgetUsage(nextConsumed, nextReserved), ledger.limits)) {
        throw new Error(`Objective budget debit exceeds its immutable limits: ${parsed.runId}`);
      }
      const exhausted = budgetExhausted(nextConsumed, ledger.limits);
      const nextLedger = ObjectiveBudgetLedgerRecordSchema.parse({
        ...ledger,
        consumed: nextConsumed,
        reserved: nextReserved,
        status: exhausted ? "exhausted" : "active",
        pauseReason: exhausted ? "budget-exhausted" : null,
        revision: ledger.revision + 1,
        updatedAt: parsed.createdAt,
      });
      const inserted = this.database
        .prepare(
          `INSERT INTO objective_budget_debits(
             id, run_id, objective_id, policy_hash, usage_event_key,
             reservation_id, request_key, record_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.runId,
          parsed.objectiveId,
          parsed.policyHash,
          parsed.usageEventKey,
          parsed.reservationId,
          parsed.requestKey,
          serialize(parsed),
          parsed.createdAt,
        );
      if (Number(inserted.changes) !== 1) return false;
      if (reservation) {
        const settled = ObjectiveBudgetReservationRecordSchema.parse({
          ...reservation,
          state: "consumed",
          revision: reservation.revision + 1,
          updatedAt: parsed.createdAt,
          releasedAt: parsed.createdAt,
        });
        const updatedReservation = this.database
          .prepare(
            `UPDATE objective_budget_reservations SET
               state = ?, revision = ?, record_json = ?, updated_at = ?, released_at = ?
             WHERE run_id = ? AND id = ? AND revision = ? AND state = 'reserved'`,
          )
          .run(
            settled.state,
            settled.revision,
            serialize(settled),
            settled.updatedAt,
            settled.releasedAt,
            settled.runId,
            settled.id,
            reservation.revision,
          );
        if (Number(updatedReservation.changes) !== 1) throw new Error("Objective budget reservation CAS lost during debit");
      }
      const advanced = this.database
        .prepare(
          `UPDATE objective_budget_ledgers SET
             revision = ?, status = ?, record_json = ?, updated_at = ?
           WHERE run_id = ? AND revision = ?`,
        )
        .run(nextLedger.revision, nextLedger.status, serialize(nextLedger), nextLedger.updatedAt, parsed.runId, ledger.revision);
      if (Number(advanced.changes) !== 1) throw new Error("Objective budget ledger CAS lost during debit");
      return true;
    });
  }

  /** Short alias used by drivers when translating a usage event into a debit. */
  debitObjectiveBudget(record: ObjectiveBudgetDebitRecord, options: { expectedLedgerRevision?: number } = {}): boolean {
    return this.recordObjectiveBudgetDebit(record, options);
  }

  saveStepAttempt(record: StepAttemptRecord): void {
    this.database
      .prepare(
        `INSERT INTO step_attempts(id, run_id, step_id, iteration_key, attempt, status, idempotency_key, record_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, record_json=excluded.record_json, updated_at=excluded.updated_at`,
      )
      .run(
        record.id,
        record.runId,
        record.stepId,
        record.iterationKey,
        record.attempt,
        record.status,
        record.idempotencyKey,
        serialize(record),
        record.updatedAt,
      );
  }

  getLatestStepAttempt(runId: string, stepId: string, iterationKey: string): StepAttemptRecord | null {
    const row = this.database
      .prepare(
        `SELECT record_json FROM step_attempts
         WHERE run_id = ? AND step_id = ? AND iteration_key = ? ORDER BY attempt DESC LIMIT 1`,
      )
      .get(runId, stepId, iterationKey) as Row | undefined;
    return row ? parseJson<StepAttemptRecord>(row.record_json) : null;
  }

  listStepAttempts(runId: string): StepAttemptRecord[] {
    return (this.database
      .prepare("SELECT record_json FROM step_attempts WHERE run_id = ? ORDER BY updated_at ASC")
      .all(runId) as Row[]).map((row) => parseJson<StepAttemptRecord>(row.record_json));
  }

  saveAgent(record: AgentRecord): void {
    const parsed = AgentRecordSchema.parse(record);
    const existingRow = this.database
      .prepare("SELECT logical_agent_id, workflow_id, run_id, parent_agent_id, record_json FROM agents WHERE id = ?")
      .get(parsed.id) as Row | undefined;
    if (!existingRow) {
      this.database
        .prepare(
          `INSERT INTO agents(id, logical_agent_id, workflow_id, run_id, parent_agent_id, status, record_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.logicalAgentId,
          parsed.workflowId,
          parsed.runId,
          parsed.parentAgentId,
          parsed.status,
          serialize(parsed),
          parsed.updatedAt,
        );
      return;
    }

    const existing = AgentRecordSchema.parse(parseJson(existingRow.record_json));
    assertAgentIdentity(existing, parsed);

    // Compare every immutable identity component in the UPDATE predicate. A
    // read-then-write check alone would allow a concurrent stale writer to
    // race between the two operations and replace the durable root/attempt
    // identity. Lifecycle/session fields remain intentionally updateable.
    const result = this.database
      .prepare(
        `UPDATE agents SET
           status = ?, record_json = ?, updated_at = ?
         WHERE id = ?
           AND logical_agent_id = ?
           AND workflow_id = ?
           AND run_id = ?
           AND parent_agent_id IS ?
           AND json_extract(record_json, '$.depth') = ?
           AND json_extract(record_json, '$.objective') = ?
           AND json_extract(record_json, '$.missionHash') = ?
           AND json_extract(record_json, '$.requestedHarness') = ?
           AND json_extract(record_json, '$.requestedModel') = ?
           AND json_extract(record_json, '$.permissions') = ?
           AND json_extract(record_json, '$.workspacePath') = ?
           AND json_extract(record_json, '$.createdAt') = ?`,
      )
      .run(
        parsed.status,
        serialize(parsed),
        parsed.updatedAt,
        parsed.id,
        parsed.logicalAgentId,
        parsed.workflowId,
        parsed.runId,
        parsed.parentAgentId,
        parsed.depth,
        parsed.objective,
        parsed.missionHash,
        parsed.requestedHarness,
        parsed.requestedModel,
        parsed.permissions,
        parsed.workspacePath,
        parsed.createdAt,
      );
    if (Number(result.changes) === 1) return;

    // If the CAS was lost, distinguish a hostile identity mutation from a
    // concurrent lifecycle write so callers receive a precise immutable
    // identity failure rather than silently accepting a stale record.
    const latestRow = this.database
      .prepare("SELECT record_json FROM agents WHERE id = ?")
      .get(parsed.id) as Row | undefined;
    if (!latestRow) throw new Error(`Agent ${parsed.id} disappeared during an identity-protected update.`);
    const latest = AgentRecordSchema.parse(parseJson(latestRow.record_json));
    assertAgentIdentity(latest, parsed);
    throw new Error(`Agent ${parsed.id} lifecycle update lost its compare-and-swap fence.`);
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.database.prepare("SELECT record_json FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? AgentRecordSchema.parse(parseJson(row.record_json)) : null;
  }

  getAgentByLogicalAgentId(logicalAgentId: string): AgentRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM agents WHERE logical_agent_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(logicalAgentId) as Row | undefined;
    return row ? AgentRecordSchema.parse(parseJson(row.record_json)) : null;
  }

  listAgents(options: AgentListOptions & { limit?: number } = {}): AgentRecord[] {
    return this.listAgentPage(options).agents;
  }

  listAgentPage(
    options: AgentListOptions & { cursor?: AgentListCursor; limit?: number } = {},
  ): { agents: AgentRecord[]; nextCursor: AgentListCursor | null } {
    let sql = "SELECT record_json FROM agents WHERE 1 = 1";
    const params: Array<string | number> = [];
    if (options.runId) {
      sql += " AND run_id = ?";
      params.push(options.runId);
    }
    if (options.parentAgentId) {
      sql += " AND parent_agent_id = ?";
      params.push(options.parentAgentId);
    }
    if (options.activeOnly) {
      sql += " AND status IN ('queued','routing','starting','running','idle','waiting','cancel-requested')";
    }
    if (options.cursor) {
      sql += " AND (updated_at < ? OR (updated_at = ? AND id < ?))";
      params.push(options.cursor.updatedAt, options.cursor.updatedAt, options.cursor.id);
    }
    const limit = Math.max(1, Math.min(options.limit ?? 1_000, 10_000));
    sql += " ORDER BY updated_at DESC, id DESC LIMIT ?";
    params.push(limit + 1);
    const rows = this.database.prepare(sql).all(...params) as Row[];
    const hasMore = rows.length > limit;
    const agents = rows.slice(0, limit).map((row) =>
      AgentRecordSchema.parse(parseJson(row.record_json)),
    );
    const last = agents.at(-1);
    return {
      agents,
      nextCursor: hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
    };
  }

  saveWorkerProcessLease(record: WorkerProcessLease): WorkerProcessLease {
    const parsed = WorkerProcessLeaseSchema.parse(record);
    this.database
      .prepare(
        `INSERT INTO worker_process_leases(
           id, daemon_owner_id, agent_id, attempt_id, driver, role, state, pid,
           process_group_id, process_start_token, transport_kind, transport_endpoint,
           owner_epoch, processed_output_seq, acked_output_seq, revision, record_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           daemon_owner_id=excluded.daemon_owner_id,
           agent_id=excluded.agent_id,
           attempt_id=excluded.attempt_id,
           driver=excluded.driver,
           role=excluded.role,
           state=excluded.state,
           pid=excluded.pid,
           process_group_id=excluded.process_group_id,
           process_start_token=excluded.process_start_token,
           transport_kind=excluded.transport_kind,
           transport_endpoint=excluded.transport_endpoint,
           owner_epoch=excluded.owner_epoch,
           processed_output_seq=excluded.processed_output_seq,
           acked_output_seq=excluded.acked_output_seq,
           revision=excluded.revision,
           record_json=excluded.record_json,
           updated_at=excluded.updated_at
         WHERE excluded.revision > worker_process_leases.revision`,
      )
      .run(
        parsed.id,
        parsed.daemonOwnerId,
        parsed.agentId,
        parsed.attemptId,
        parsed.driver,
        parsed.role,
        parsed.state,
        parsed.identity?.pid ?? null,
        parsed.identity?.processGroupId ?? null,
        parsed.identity?.startToken ?? null,
        parsed.transport.kind,
        parsed.transport.kind === "worker-host" ? parsed.transport.endpoint : null,
        parsed.transport.kind === "worker-host" ? parsed.transport.ownerEpoch : null,
        parsed.transport.kind === "worker-host" ? parsed.transport.processedOutputSeq : null,
        parsed.transport.kind === "worker-host" ? parsed.transport.ackedOutputSeq : null,
        parsed.revision,
        serialize(parsed),
        parsed.updatedAt,
      );
    return this.getWorkerProcessLease(parsed.id) ?? parsed;
  }

  getWorkerProcessLease(id: string): WorkerProcessLease | null {
    const row = this.database
      .prepare("SELECT record_json FROM worker_process_leases WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? WorkerProcessLeaseSchema.parse(parseJson(row.record_json)) : null;
  }

  listWorkerProcessLeases(
    options: {
      agentId?: string;
      states?: readonly WorkerProcessLeaseState[];
      daemonOwnerId?: string;
    } = {},
  ): WorkerProcessLease[] {
    let sql = "SELECT record_json FROM worker_process_leases WHERE 1 = 1";
    const params: string[] = [];
    if (options.agentId) {
      sql += " AND agent_id = ?";
      params.push(options.agentId);
    }
    if (options.states?.length) {
      sql += ` AND state IN (${options.states.map(() => "?").join(",")})`;
      params.push(...options.states);
    }
    if (options.daemonOwnerId) {
      sql += " AND daemon_owner_id = ?";
      params.push(options.daemonOwnerId);
    }
    sql += " ORDER BY updated_at ASC, id ASC";
    return (this.database.prepare(sql).all(...params) as Row[]).map((row) =>
      WorkerProcessLeaseSchema.parse(parseJson(row.record_json)),
    );
  }

  transitionWorkerProcessLease(
    id: string,
    expectedStates: readonly WorkerProcessLeaseState[],
    patch: WorkerProcessLeaseTransitionPatch,
  ): WorkerProcessLease | null {
    if (expectedStates.length === 0) return null;
    return this.transaction(() => {
      const current = this.getWorkerProcessLease(id);
      if (!current || !expectedStates.includes(current.state)) return null;
      const next = WorkerProcessLeaseSchema.parse({
        ...current,
        ...patch,
        id: current.id,
        daemonOwnerId: current.daemonOwnerId,
        agentId: current.agentId,
        attemptId: current.attemptId,
        driver: current.driver,
        role: current.role,
        command: current.command,
        args: current.args,
        cwd: current.cwd,
        workspacePath: current.workspacePath,
        permission: current.permission,
        reservedAt: current.reservedAt,
        revision: current.revision + 1,
        updatedAt: patch.updatedAt ?? nowIso(),
      });
      const result = this.database
        .prepare(
          `UPDATE worker_process_leases SET
             state = ?, pid = ?, process_group_id = ?, process_start_token = ?,
             transport_kind = ?, transport_endpoint = ?, owner_epoch = ?, processed_output_seq = ?, acked_output_seq = ?,
             revision = ?, record_json = ?, updated_at = ?
           WHERE id = ? AND state = ? AND revision = ?`,
        )
        .run(
          next.state,
          next.identity?.pid ?? null,
          next.identity?.processGroupId ?? null,
          next.identity?.startToken ?? null,
          next.transport.kind,
          next.transport.kind === "worker-host" ? next.transport.endpoint : null,
          next.transport.kind === "worker-host" ? next.transport.ownerEpoch : null,
          next.transport.kind === "worker-host" ? next.transport.processedOutputSeq : null,
          next.transport.kind === "worker-host" ? next.transport.ackedOutputSeq : null,
          next.revision,
          serialize(next),
          next.updatedAt,
          current.id,
          current.state,
          current.revision,
        );
      return Number(result.changes) === 1 ? next : null;
    });
  }

  touchWorkerProcessLease(id: string, patch: WorkerProcessLeaseTouchPatch = {}): WorkerProcessLease | null {
    return this.transaction(() => {
      const current = this.getWorkerProcessLease(id);
      if (!current) return null;
      const next = WorkerProcessLeaseSchema.parse({
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: nowIso(),
      });
      const result = this.database
        .prepare(
          `UPDATE worker_process_leases SET
             transport_kind = ?, transport_endpoint = ?, owner_epoch = ?, processed_output_seq = ?, acked_output_seq = ?,
             revision = ?, record_json = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          next.transport.kind,
          next.transport.kind === "worker-host" ? next.transport.endpoint : null,
          next.transport.kind === "worker-host" ? next.transport.ownerEpoch : null,
          next.transport.kind === "worker-host" ? next.transport.processedOutputSeq : null,
          next.transport.kind === "worker-host" ? next.transport.ackedOutputSeq : null,
          next.revision,
          serialize(next),
          next.updatedAt,
          current.id,
          current.revision,
        );
      return Number(result.changes) === 1 ? next : null;
    });
  }

  durablyTouchWorkerProcessLease(id: string, patch: WorkerProcessLeaseTouchPatch = {}): WorkerProcessLease | null {
    return this.durableTransaction(() => this.touchWorkerProcessLease(id, patch));
  }

  adoptWorkerProcessLease(
    id: string,
    expectedRevision: number,
    nextDaemonOwnerId: string,
    transport: WorkerProcessLease["transport"],
  ): WorkerProcessLease | null {
    return this.durableTransaction(() => {
      const current = this.getWorkerProcessLease(id);
      if (!current || current.revision !== expectedRevision || current.state !== "running") return null;
      const next = WorkerProcessLeaseSchema.parse({
        ...current,
        daemonOwnerId: nextDaemonOwnerId,
        transport,
        // A successful successor adoption proves that the old controller-loss
        // intent no longer applies. Keep healthy adopted work eligible for
        // normal supervision on a later restart.
        retirementRequestedAt: null,
        retirementReason: null,
        revision: current.revision + 1,
        updatedAt: nowIso(),
      });
      const result = this.database
        .prepare(
          `UPDATE worker_process_leases SET
             daemon_owner_id = ?, transport_kind = ?, transport_endpoint = ?,
             owner_epoch = ?, processed_output_seq = ?, acked_output_seq = ?, revision = ?, record_json = ?, updated_at = ?
           WHERE id = ? AND state = 'running' AND daemon_owner_id = ? AND revision = ?`,
        )
        .run(
          next.daemonOwnerId,
          next.transport.kind,
          next.transport.kind === "worker-host" ? next.transport.endpoint : null,
          next.transport.kind === "worker-host" ? next.transport.ownerEpoch : null,
          next.transport.kind === "worker-host" ? next.transport.processedOutputSeq : null,
          next.transport.kind === "worker-host" ? next.transport.ackedOutputSeq : null,
          next.revision,
          serialize(next),
          next.updatedAt,
          current.id,
          current.daemonOwnerId,
          current.revision,
        );
      return Number(result.changes) === 1 ? next : null;
    });
  }

  addAgentMessage(input: {
    agentId: string;
    direction: "to-agent" | "from-agent";
    content: string;
    receiptId?: string;
    deliveryState: "queued" | "delivered" | "unknown" | "failed";
  }): string {
    const id = ulid();
    this.database
      .prepare(
        `INSERT INTO agent_messages(id, agent_id, direction, content, receipt_id, delivery_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.agentId, input.direction, input.content, input.receiptId ?? null, input.deliveryState, nowIso());
    return id;
  }

  listAgentMessages(agentId: string, limit = 500): Row[] {
    return this.database
      .prepare("SELECT * FROM agent_messages WHERE agent_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(agentId, Math.min(limit, 5_000)) as Row[];
  }

  saveObservation(observation: Observation): void {
    const parsed = ObservationSchema.parse(observation);
    this.database
      .prepare(
        `INSERT INTO observations(id, agent_id, level, event_cursor, record_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, level, event_cursor) DO UPDATE SET record_json=excluded.record_json`,
      )
      .run(parsed.id, parsed.agentId, parsed.level, parsed.eventCursor, serialize(parsed), parsed.createdAt);
  }

  getObservation(agentId: string, level: Observation["level"], eventCursor: number): Observation | null {
    const row = this.database
      .prepare("SELECT record_json FROM observations WHERE agent_id = ? AND level = ? AND event_cursor = ?")
      .get(agentId, level, eventCursor) as Row | undefined;
    return row ? ObservationSchema.parse(parseJson(row.record_json)) : null;
  }

  getObservationById(id: string): Observation | null {
    const row = this.database.prepare("SELECT record_json FROM observations WHERE id = ?").get(id) as Row | undefined;
    return row ? ObservationSchema.parse(parseJson(row.record_json)) : null;
  }

  recordUsage(usage: UsageEvent): void {
    const parsed = UsageEventSchema.parse(usage);
    const existingById = this.database
      .prepare("SELECT record_json FROM usage_events WHERE id = ?")
      .get(parsed.id) as Row | undefined;
    if (existingById) {
      const existing = UsageEventSchema.parse(parseJson(existingById.record_json));
      if (stableUsageEvidence(existing) === stableUsageEvidence(parsed)) return;
      throw new Error(`Usage event id ${parsed.id} is already bound to different evidence.`);
    }
    if (parsed.nativeEventId !== null && parsed.nativeEventId !== undefined) {
      const existingByNativeId = this.database
        .prepare("SELECT record_json FROM usage_events WHERE run_id = ? AND agent_id IS ? AND native_event_id = ?")
        .get(parsed.runId, parsed.agentId, parsed.nativeEventId) as Row | undefined;
      if (existingByNativeId) {
        const existing = UsageEventSchema.parse(parseJson(existingByNativeId.record_json));
        if (stableUsageEvidence(existing) === stableUsageEvidence(parsed)) return;
        throw new Error(`Native usage event ${parsed.nativeEventId} is already bound to different evidence.`);
      }
    }
    this.database
      .prepare(
        `INSERT INTO usage_events(
           id, workflow_id, run_id, agent_id, cost_amount, basis,
           objective_attempt_id, native_turn_id, native_event_id,
           record_json, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.workflowId,
        parsed.runId,
        parsed.agentId,
        parsed.costAmount,
        parsed.basis,
        parsed.objectiveAttemptId ?? null,
        parsed.nativeTurnId ?? null,
        parsed.nativeEventId ?? null,
        serialize(parsed),
        parsed.recordedAt,
      );
  }

  listUsage(options: { workflowId?: string; runId?: string; agentId?: string; objectiveAttemptId?: string } = {}): UsageEvent[] {
    let sql = "SELECT record_json FROM usage_events WHERE 1 = 1";
    const params: string[] = [];
    if (options.workflowId) {
      sql += " AND workflow_id = ?";
      params.push(options.workflowId);
    }
    if (options.runId) {
      sql += " AND run_id = ?";
      params.push(options.runId);
    }
    if (options.agentId) {
      sql += " AND agent_id = ?";
      params.push(options.agentId);
    }
    if (options.objectiveAttemptId) {
      sql += " AND objective_attempt_id = ?";
      params.push(options.objectiveAttemptId);
    }
    sql += " ORDER BY recorded_at ASC";
    return (this.database.prepare(sql).all(...params) as Row[]).map((row) =>
      UsageEventSchema.parse(parseJson(row.record_json)),
    );
  }

  aggregateCost(options: { workflowId?: string; runId?: string; agentId?: string } = {}): JsonValue {
    const events = this.listUsage(options);
    const byBasis: Record<string, number> = {};
    let knownTotal = 0;
    let unknownEvents = 0;
    for (const event of events) {
      // The aggregate contract is explicitly USD. A provider-reported amount
      // in another currency is not convertible without a durable FX snapshot,
      // so count it as unknown rather than silently adding EUR/JPY to a USD
      // total or labelling the mixed number as dollars.
      if (event.costAmount === null || event.currency.toUpperCase() !== "USD") {
        unknownEvents += 1;
        continue;
      }
      knownTotal += event.costAmount;
      byBasis[event.basis] = (byBasis[event.basis] ?? 0) + event.costAmount;
    }
    return { currency: "USD", knownTotal, unknownEvents, eventCount: events.length, byBasis };
  }

  /**
   * Read the immutable objective command receipt.  A command receipt is
   * intentionally separate from provider command receipts: it carries the
   * objective/run authority and can be inspected without reconstructing a
   * current workflow head.
   */
  getObjectiveCommandLedger(requestKey: string): ObjectiveCommandLedgerRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM objective_command_ledger WHERE request_key = ?")
      .get(requestKey) as Row | undefined;
    return row ? parseObjectiveCommandLedger(parseJson(row.record_json)) : null;
  }

  listObjectiveCommandLedger(options: {
    runId?: string;
    objectiveId?: string;
    outcomeStatus?: ObjectiveCommandLedgerRecord["outcome"]["status"];
    limit?: number;
  } = {}): ObjectiveCommandLedgerRecord[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (options.runId) {
      clauses.push("run_id = ?");
      values.push(options.runId);
    }
    if (options.objectiveId) {
      clauses.push("objective_id = ?");
      values.push(options.objectiveId);
    }
    if (options.outcomeStatus) {
      clauses.push("outcome_status = ?");
      values.push(options.outcomeStatus);
    }
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 5_000);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`SELECT record_json FROM objective_command_ledger${where} ORDER BY created_at ASC, request_key ASC LIMIT ?`)
      .all(...values, limit) as Row[];
    return rows.map((row) => parseObjectiveCommandLedger(parseJson(row.record_json)));
  }

  /**
   * Execute one objective mutation through an append -> project -> receipt
   * transaction. The callback must only perform daemon-owned durable work;
   * native/external effects belong after this method returns `committed`.
   *
   * If the callback throws, the transaction is rolled back and an immutable
   * `unknown` receipt is written in a fresh durable transaction. This is the
   * fail-closed boundary: callers must reconcile an unknown command rather
   * than retrying an operation whose external outcome cannot be proven.
   * A post-commit event/SSE listener failure is handled differently: the
   * committed receipt is reread and returned as a replay, because state is
   * already authoritative and the event outbox can be drained later.
   */
  executeObjectiveCommand(
    input: ObjectiveCommandLedgerInput,
    execute: () => ObjectiveCommandLedgerExecution,
  ): ObjectiveCommandLedgerResult {
    if (input.requestKey.length < 8 || input.requestKey.length > 512) {
      throw new Error("Objective command requestKey must contain 8 to 512 characters");
    }
    if (input.operation.length < 1 || input.operation.length > 200) {
      throw new Error("Objective command operation must contain 1 to 200 characters");
    }
    if (!/^[0-9a-f]{64}$/u.test(input.fingerprint)) {
      throw new Error("Objective command fingerprint must be a lowercase SHA-256 digest");
    }
    const actor = ObjectiveActorSchema.parse(input.actor);
    const readExisting = (): ObjectiveCommandLedgerResult | null => {
      const existing = this.getObjectiveCommandLedger(input.requestKey);
      if (!existing) return null;
      if (
        existing.operation !== input.operation
        || existing.fingerprint !== input.fingerprint
        || existing.objectiveId !== input.objectiveId
        || existing.runId !== input.runId
        || existing.actor.type !== actor.type
        || existing.actor.id !== actor.id
      ) {
        return {
          status: "conflict",
          result: null,
          record: existing,
          reason: "Objective command request key is already bound to different immutable evidence",
        };
      }
      const status = existing.outcome.status === "committed"
        ? "replayed"
        : existing.outcome.status;
      return {
        status,
        result: existing.outcome.result,
        record: existing,
        ...(existing.outcome.status === "rejected" || existing.outcome.status === "unknown"
          ? { reason: existing.outcome.reason }
          : {}),
      };
    };

    const existing = readExisting();
    if (existing) return existing;

    try {
      return this.durableTransaction(() => {
        const raced = readExisting();
        if (raced) return raced;
        const outcome = execute();
        const now = nowIso();
        const record = ObjectiveCommandLedgerRecordSchema.parse({
          version: 1,
          requestKey: input.requestKey,
          operation: input.operation,
          fingerprint: input.fingerprint,
          actor,
          objectiveId: input.objectiveId,
          runId: input.runId,
          outcome,
          createdAt: now,
          updatedAt: now,
        });
        const inserted = this.database
          .prepare(
            `INSERT INTO objective_command_ledger(
               request_key, operation, fingerprint, actor_type, actor_id,
               objective_id, run_id, outcome_status, record_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.requestKey,
            record.operation,
            record.fingerprint,
            record.actor.type,
            record.actor.id,
            record.objectiveId,
            record.runId,
            record.outcome.status,
            serialize(record),
            record.createdAt,
            record.updatedAt,
          );
        if (Number(inserted.changes) !== 1) {
          throw new Error(`Objective command receipt insert failed: ${record.requestKey}`);
        }
        return {
          status: outcome.status,
          result: outcome.result,
          record,
          ...(outcome.status === "rejected" ? { reason: outcome.reason } : {}),
        };
      });
    } catch (error) {
      // `transaction()` publishes committed event listeners after COMMIT. If
      // a listener/SSE consumer throws, the durable receipt is already there;
      // return it instead of incorrectly writing an unknown outcome.
      const committed = readExisting();
      if (committed) return committed;

      const reason = error instanceof Error ? error.message : "Objective command execution failed before its outcome was known";
      try {
        return this.durableTransaction(() => {
          const raced = readExisting();
          if (raced) return raced;
          const now = nowIso();
          const record = ObjectiveCommandLedgerRecordSchema.parse({
            version: 1,
            requestKey: input.requestKey,
            operation: input.operation,
            fingerprint: input.fingerprint,
            actor,
            objectiveId: input.objectiveId,
            runId: input.runId,
            outcome: { status: "unknown", result: null, reason },
            createdAt: now,
            updatedAt: now,
          });
          const inserted = this.database
            .prepare(
              `INSERT INTO objective_command_ledger(
                 request_key, operation, fingerprint, actor_type, actor_id,
                 objective_id, run_id, outcome_status, record_json, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              record.requestKey,
              record.operation,
              record.fingerprint,
              record.actor.type,
              record.actor.id,
              record.objectiveId,
              record.runId,
              record.outcome.status,
              serialize(record),
              record.createdAt,
              record.updatedAt,
            );
          if (Number(inserted.changes) !== 1) throw new Error(`Objective unknown-outcome receipt insert failed: ${record.requestKey}`);
          return { status: "unknown", result: null, record, reason };
        });
      } catch (persistError) {
        throw new Error(
          `Objective command ${input.requestKey} has an unknown outcome and its receipt could not be persisted: ${persistError instanceof Error ? persistError.message : "storage failure"}`,
          { cause: error },
        );
      }
    }
  }

  saveRoutingTrace(trace: RoutingTrace): void {
    const parsed = RoutingTraceSchema.parse(trace);
    this.database
      .prepare("INSERT OR REPLACE INTO routing_traces(id, work_order_id, record_json, created_at) VALUES (?, ?, ?, ?)")
      .run(parsed.id, parsed.workOrderId, serialize(parsed), parsed.createdAt);
  }

  getCommandReceipt(idempotencyKey: string): CommandReceipt | null {
    const row = this.database
      .prepare("SELECT record_json FROM command_receipts WHERE idempotency_key = ?")
      .get(idempotencyKey) as Row | undefined;
    return row ? CommandReceiptSchema.parse(parseJson(row.record_json)) : null;
  }

  saveCommandReceipt(receipt: CommandReceipt): void {
    const parsed = CommandReceiptSchema.parse(receipt);
    this.database
      .prepare("INSERT OR IGNORE INTO command_receipts(idempotency_key, record_json, created_at) VALUES (?, ?, ?)")
      .run(parsed.idempotencyKey, serialize(parsed), parsed.createdAt);
  }

  claimCommandReceipt(receipt: CommandReceipt): boolean {
    const parsed = CommandReceiptSchema.parse(receipt);
    const result = this.database
      .prepare("INSERT OR IGNORE INTO command_receipts(idempotency_key, record_json, created_at) VALUES (?, ?, ?)")
      .run(parsed.idempotencyKey, serialize(parsed), parsed.createdAt);
    return result.changes === 1;
  }

  replaceCommandReceipt(receipt: CommandReceipt): void {
    const parsed = CommandReceiptSchema.parse(receipt);
    this.database
      .prepare("UPDATE command_receipts SET record_json = ? WHERE idempotency_key = ?")
      .run(serialize(parsed), parsed.idempotencyKey);
  }

  claimTriggerOccurrence(record: TriggerOccurrenceRecord): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO trigger_occurrences(
          trigger_id, occurrence_key, run_id, created_at, state, record_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.triggerId,
        record.occurrenceKey,
        record.runId,
        record.createdAt,
        record.state,
        serialize(record),
        record.updatedAt,
      );
    return result.changes === 1;
  }

  getTriggerOccurrence(triggerId: string, occurrenceKey: string): TriggerOccurrenceRecord | null {
    const row = this.database
      .prepare("SELECT record_json FROM trigger_occurrences WHERE trigger_id = ? AND occurrence_key = ?")
      .get(triggerId, occurrenceKey) as Row | undefined;
    return row?.record_json ? parseJson<TriggerOccurrenceRecord>(row.record_json) : null;
  }

  listTriggerOccurrences(options: { state?: TriggerOccurrenceRecord["state"] } = {}): TriggerOccurrenceRecord[] {
    const rows = options.state
      ? this.database
          .prepare("SELECT record_json FROM trigger_occurrences WHERE state = ? AND record_json IS NOT NULL ORDER BY updated_at ASC")
          .all(options.state) as Row[]
      : this.database
          .prepare("SELECT record_json FROM trigger_occurrences WHERE record_json IS NOT NULL ORDER BY updated_at ASC")
          .all() as Row[];
    return rows.map((row) => parseJson<TriggerOccurrenceRecord>(row.record_json));
  }

  replaceTriggerOccurrence(record: TriggerOccurrenceRecord): void {
    const result = this.database
      .prepare(
        `UPDATE trigger_occurrences
         SET run_id = ?, state = ?, record_json = ?, updated_at = ?
         WHERE trigger_id = ? AND occurrence_key = ?`,
      )
      .run(
        record.runId,
        record.state,
        serialize(record),
        record.updatedAt,
        record.triggerId,
        record.occurrenceKey,
      );
    if (result.changes !== 1) {
      throw new Error(`Trigger occurrence not found: ${record.triggerId}/${record.occurrenceKey}`);
    }
  }

  savePluginState(record: PluginStateRecord): void {
    this.database
      .prepare(
        `INSERT INTO plugin_states(id, status, record_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, record_json=excluded.record_json, updated_at=excluded.updated_at`,
      )
      .run(record.id, record.status, serialize(record), record.updatedAt);
  }

  listPluginStates(): PluginStateRecord[] {
    return (this.database.prepare("SELECT record_json FROM plugin_states ORDER BY id ASC").all() as Row[]).map((row) =>
      parseJson<PluginStateRecord>(row.record_json),
    );
  }

  appendConversationMessage(message: ConversationMessage): void {
    this.database
      .prepare("INSERT OR REPLACE INTO conversation_messages(id, thread_id, record_json, created_at) VALUES (?, ?, ?, ?)")
      .run(message.id, message.threadId, serialize(message), message.createdAt);
  }

  getConversationMessage(id: string): ConversationMessage | null {
    const row = this.database
      .prepare("SELECT record_json FROM conversation_messages WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? parseJson<ConversationMessage>(row.record_json) : null;
  }

  listConversationMessages(threadId?: string, limit = 1_000): ConversationMessage[] {
    if (threadId) {
      return (this.database
        .prepare("SELECT record_json FROM conversation_messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?")
        .all(threadId, limit) as Row[]).map((row) => parseJson<ConversationMessage>(row.record_json));
    }
    return (this.database
      .prepare("SELECT record_json FROM conversation_messages ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Row[]).map((row) => parseJson<ConversationMessage>(row.record_json));
  }

  listRecentConversationMessages(threadId: string, limit = 40): ConversationMessage[] {
    const rows = this.database
      .prepare("SELECT record_json FROM conversation_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(threadId, limit) as Row[];
    return rows.reverse().map((row) => parseJson<ConversationMessage>(row.record_json));
  }

  saveThread(record: ChatThreadRecord): void {
    this.database
      .prepare(
        `INSERT INTO chat_threads(id, group_id, archived, record_json, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id, archived=excluded.archived, record_json=excluded.record_json, updated_at=excluded.updated_at`,
      )
      .run(record.id, record.groupId, record.archived ? 1 : 0, serialize(record), record.updatedAt);
  }

  getThread(id: string): ChatThreadRecord | null {
    const row = this.database.prepare("SELECT record_json FROM chat_threads WHERE id = ?").get(id) as Row | undefined;
    return row ? parseJson<ChatThreadRecord>(row.record_json) : null;
  }

  listThreads(options: { groupId?: string; includeArchived?: boolean; limit?: number } = {}): ChatThreadRecord[] {
    let sql = "SELECT record_json FROM chat_threads WHERE 1 = 1";
    const params: Array<string | number> = [];
    if (options.groupId) {
      sql += " AND group_id = ?";
      params.push(options.groupId);
    }
    if (!options.includeArchived) sql += " AND archived = 0";
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(Math.min(options.limit ?? 500, 5_000));
    return (this.database.prepare(sql).all(...params) as Row[]).map((row) => parseJson<ChatThreadRecord>(row.record_json));
  }

  saveProject(record: ProjectRecord): void {
    this.database
      .prepare(
        `INSERT INTO projects(id, workspace_path, record_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_path) DO UPDATE SET id=excluded.id, record_json=excluded.record_json, updated_at=excluded.updated_at`,
      )
      .run(record.id, record.workspacePath, serialize(record), record.updatedAt);
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.database.prepare("SELECT record_json FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row ? parseJson<ProjectRecord>(row.record_json) : null;
  }

  getProjectByPath(workspacePath: string): ProjectRecord | null {
    const row = this.database.prepare("SELECT record_json FROM projects WHERE workspace_path = ?").get(workspacePath) as Row | undefined;
    return row ? parseJson<ProjectRecord>(row.record_json) : null;
  }

  listProjects(): ProjectRecord[] {
    return (this.database.prepare("SELECT record_json FROM projects ORDER BY updated_at DESC").all() as Row[]).map((row) =>
      parseJson<ProjectRecord>(row.record_json),
    );
  }

  setMetadata(key: string, value: JsonValue): void {
    this.database
      .prepare(
        `INSERT INTO metadata(key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
      )
      .run(key, serialize(value), nowIso());
  }

  hasMetadata(key: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM metadata WHERE key = ?").get(key));
  }

  getMetadata<T extends JsonValue>(key: string): T | null {
    const row = this.database.prepare("SELECT value_json FROM metadata WHERE key = ?").get(key) as Row | undefined;
    return row ? parseJson<T>(row.value_json) : null;
  }

  listMetadata<T extends JsonValue>(prefix: string): Array<{ key: string; value: T }> {
    return (this.database
      .prepare("SELECT key, value_json FROM metadata WHERE key LIKE ? ORDER BY key ASC")
      .all(`${prefix}%`) as Row[]).map((row) => ({
      key: String(row.key),
      value: parseJson<T>(row.value_json),
    }));
  }
}

export function createStore(dataDirectory: string): SymphonyStore {
  return new SymphonyStore(resolve(dataDirectory, "symphony.sqlite"));
}

export * from "./objective-attention.js";
export * from "./capability-library.js";
export * from "./agent-message.js";
export * from "./capability-result-feedback.js";
