import type {
  ObjectiveApprovalRecord,
  ObjectiveRunRecord,
  ObjectivePolicyRequest,
  Permission,
  WorkspaceSpec,
} from "@symphony/protocol";
import {
  ObjectiveRuntime,
  type ObjectiveRepository,
  type ObjectiveRuntimeAuthority,
} from "./objective-runtime.js";

/** The small durable surface needed by the daemon's approval expiry worker. */
export type ObjectiveApprovalExpiryStore = Readonly<{
  listObjectiveApprovals(options: {
    status?: ObjectiveApprovalRecord["status"][];
    limit?: number;
    expiresAtLte?: string;
  }): ObjectiveApprovalRecord[];
}>;

export type ObjectiveApprovalExpiryResult = Readonly<{
  approval: ObjectiveApprovalRecord;
  run: ObjectiveRunRecord;
  next: ObjectiveRunRecord;
  requestKey: string;
}>;

export type ObjectiveApprovalExpiryProcessorOptions = Readonly<{
  now?: () => string;
  /** Primarily useful for bounded tests; production defaults to 2,000. */
  scanLimit?: number;
  /** Called only after the runtime's durable resolution commits. */
  onExpired?: (result: ObjectiveApprovalExpiryResult) => void;
}>;

/**
 * Daemon-owned approval timeout reconciliation.
 *
 * Expiry is intentionally not implemented in the browser or a native driver.
 * Each scan reads only still-requested approvals, then asks ObjectiveRuntime
 * to resolve one with a stable idempotency key. The runtime's durable
 * transaction and requested-status CAS make concurrent/restarted scans safe:
 * at most one resolution can settle a given approval.
 */
export class ObjectiveApprovalExpiryProcessor {
  private readonly now: () => string;
  private readonly scanLimit: number;
  private readonly onExpired: (result: ObjectiveApprovalExpiryResult) => void;

  constructor(
    private readonly runtime: ObjectiveRuntime,
    private readonly repository: ObjectiveRepository,
    private readonly store: ObjectiveApprovalExpiryStore,
    options: ObjectiveApprovalExpiryProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.scanLimit = Math.max(1, Math.min(options.scanLimit ?? 2_000, 2_000));
    this.onExpired = options.onExpired ?? (() => undefined);
  }

  /**
   * Reconcile all currently expired requests. One malformed or concurrently
   * resolved approval does not prevent the remaining requests from settling.
   */
  expireRequested(): ObjectiveApprovalExpiryResult[] {
    const now = this.now();
    const results: ObjectiveApprovalExpiryResult[] = [];
    for (const approval of this.store.listObjectiveApprovals({
      status: ["requested"],
      expiresAtLte: now,
      limit: this.scanLimit,
    })) {
      // Keep a defensive check for adapters that implement the narrow store
      // contract outside SQLite; the durable store has already filtered this
      // set before applying the limit.
      if (approval.expiresAt === null || Date.parse(approval.expiresAt) > Date.parse(now)) continue;
      const run = this.repository.getObjectiveRun(approval.runId);
      if (!run || run.pendingApprovalId !== approval.id) continue;
      const requestKey = approvalExpiryRequestKey(approval);
      try {
        const next = this.runtime.resolveApproval(
          run.runId,
          approval.id,
          {
            status: "expired",
            decision: { reason: "approval-timeout", expiredAt: approval.expiresAt },
            requestKey,
          },
          expiryAuthority(run),
        );
        const result = { approval, run, next, requestKey } satisfies ObjectiveApprovalExpiryResult;
        results.push(result);
        this.onExpired(result);
      } catch {
        // A competing daemon tick/user resolution may have settled the
        // approval after the scan. Re-read below and leave non-requested rows
        // alone. Unexpected malformed policy/state remains visible in the
        // durable run and can be retried after repair/recovery.
        const current = this.repository.getObjectiveApproval(run.runId, approval.id);
        if (current?.status === "requested") throw new Error(`Could not expire objective approval ${approval.id}.`);
      }
    }
    return results;
  }
}

export function approvalExpiryRequestKey(approval: Pick<ObjectiveApprovalRecord, "runId" | "id" | "expiresAt">): string {
  return `objective-approval-expiry:${approval.runId}:${approval.id}:${approval.expiresAt ?? "none"}`;
}

function expiryAuthority(run: ObjectiveRunRecord): ObjectiveRuntimeAuthority {
  const policy = run.policy;
  if (!policy) {
    return {
      actor: { type: "system", id: "objective-approval-expiry" },
      permissionCeiling: "full-access",
    };
  }
  const authorityPolicy: ObjectivePolicyRequest = {
    effectivePermission: policy.effectivePermission,
    allowedCapabilities: policy.allowedCapabilities,
    budget: policy.budget,
    sideEffectClassCeiling: policy.sideEffectClassCeiling,
    approvalPolicy: policy.approvalPolicy,
    expiresAt: policy.expiresAt,
  };
  return {
    actor: { type: "system", id: "objective-approval-expiry" },
    permissionCeiling: policy.effectivePermission as Permission,
    allowedCapabilities: policy.allowedCapabilities,
    workspace: policy.workspace as WorkspaceSpec | null,
    policy: authorityPolicy,
  };
}
