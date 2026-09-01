import { createHash } from "node:crypto";
import {
  ObjectiveAttentionRecordSchema,
  ObjectiveAttentionRequestSchema,
  ObjectiveAttentionResolveRequestSchema,
  type ObjectiveActor,
  type ObjectiveAttentionRecord,
  type ObjectiveAttentionRequest,
  type ObjectiveAttentionResolveRequest,
} from "@symphony/protocol";
import type { SymphonyStore } from "./index.js";

export type ObjectiveAttentionBinding = Readonly<{
  objectiveId: string;
  runId: string;
  /** Stable supervision operation identity; immutable for the record lifetime. */
  operationId?: string;
  nodeId?: string | null;
  attemptId?: string | null;
  requestKey: string;
  requestedBy: ObjectiveActor;
  now: string;
  id?: string;
}>;

export type ObjectiveAttentionResolution = Readonly<{
  request: ObjectiveAttentionResolveRequest;
  resolvedBy: ObjectiveActor;
  now: string;
  requestKey: string;
}>;

/**
 * Small storage-facing registry used by daemon and tests. It owns identity
 * derivation and immutable/CAS behavior; semantic event publication remains a
 * daemon concern so event visibility is scoped to the authenticated request.
 */
export class ObjectiveAttentionRegistry {
  constructor(private readonly store: SymphonyStore) {}

  create(binding: ObjectiveAttentionBinding, request: ObjectiveAttentionRequest): ObjectiveAttentionRecord {
    const parsed = ObjectiveAttentionRequestSchema.parse(request);
    const id = binding.id ?? `attention:${createHash("sha256").update(`${binding.runId}\u0000${binding.requestKey}`).digest("hex")}`;
    const record = ObjectiveAttentionRecordSchema.parse({
      ...parsed,
      version: 1,
      id,
      operationId: parsed.operationId ?? binding.operationId ?? `objective-attention:${binding.runId}:${binding.requestKey}`,
      objectiveId: binding.objectiveId,
      runId: binding.runId,
      nodeId: binding.nodeId ?? parsed.nodeId ?? null,
      attemptId: binding.attemptId ?? parsed.attemptId ?? null,
      status: "open",
      resolution: null,
      requestKey: binding.requestKey,
      createdAt: binding.now,
      updatedAt: binding.now,
    });
    this.store.durableTransaction(() => {
      this.store.saveObjectiveAttention(record);
    });
    return this.store.getObjectiveAttention(record.id, record.runId) ?? record;
  }

  list(options: Parameters<SymphonyStore["listObjectiveAttentions"]>[0] = {}): ObjectiveAttentionRecord[] {
    return this.store.listObjectiveAttentions(options);
  }

  get(runId: string, id: string): ObjectiveAttentionRecord | null {
    return this.store.getObjectiveAttention(id, runId);
  }

  resolve(runId: string, id: string, input: ObjectiveAttentionResolution): ObjectiveAttentionRecord {
    const request = ObjectiveAttentionResolveRequestSchema.parse(input.request);
    const current = this.store.getObjectiveAttention(id, runId);
    if (!current) throw new Error(`Objective attention not found: ${id}`);
    if (current.status !== "open") {
      // Reconciliation callers can retrieve the settled immutable record, but
      // may not manufacture a second receipt or alter its decision.
      if (
        current.resolution?.requestKey === input.requestKey
        && current.resolution.status === request.status
        && JSON.stringify(current.resolution.decision) === JSON.stringify(request.decision ?? null)
        && JSON.stringify(current.resolution.evidenceRefs) === JSON.stringify(request.evidenceRefs)
      ) return current;
      throw new Error(`Objective attention ${id} is already ${current.status}`);
    }
    const next = ObjectiveAttentionRecordSchema.parse({
      ...current,
      status: request.status,
      updatedAt: input.now,
      resolution: {
        receiptId: `attention-resolution:${createHash("sha256").update(`${runId}\u0000${id}\u0000${input.requestKey}`).digest("hex")}`,
        requestKey: input.requestKey,
        status: request.status,
        decision: request.decision ?? null,
        resolvedBy: input.resolvedBy,
        resolvedAt: input.now,
        evidenceRefs: request.evidenceRefs,
      },
    });
    const changed = this.store.durableTransaction(() => this.store.resolveObjectiveAttention(next));
    if (!changed) {
      const raced = this.store.getObjectiveAttention(id, runId);
      if (raced?.resolution?.requestKey === input.requestKey) return raced;
      throw new Error(`Objective attention resolution lost its compare-and-swap race: ${id}`);
    }
    return this.store.getObjectiveAttention(id, runId) ?? next;
  }

  expire(now: string, resolvedBy: ObjectiveActor = { type: "system", id: "attention-expiry" }): ObjectiveAttentionRecord[] {
    return this.store.durableTransaction(() => this.store.expireObjectiveAttentions(now, resolvedBy));
  }
}
