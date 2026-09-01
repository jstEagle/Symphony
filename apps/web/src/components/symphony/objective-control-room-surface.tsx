"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { ObjectiveControlRoom } from "@/components/symphony/objective-control-room";
import { AgentMessageProjection } from "@/components/symphony/agent-message-projection";
import { useSymphony } from "@/components/symphony/context";
import {
  cancelObjectiveRun,
  fetchObjectiveAggregates,
  fetchObjectiveSnapshot,
  newIdempotencyKey,
  resolveObjectiveApproval,
  resumeObjectiveCheckpoint,
  retryObjectiveCheckpoint,
} from "@/lib/symphony/runtime-client";
import { projectObjectiveSnapshot, type ObjectiveWorkspaceProjection } from "@/lib/symphony/objective-snapshot";

export type ObjectiveControlRoomSurfaceProps = {
  onOpenObjective?: (runId: string) => void;
  onOpenAgent?: (agentId: string) => void;
};

/**
 * Runtime-backed aggregate surface. Objective identity is loaded first, then
 * each card is projected from its one atomic snapshot; chats are drill-down
 * views and never determine which objective is displayed.
 */
export function ObjectiveControlRoomSurface({ onOpenObjective, onOpenAgent }: ObjectiveControlRoomSurfaceProps) {
  const symphony = useSymphony();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  // An outcome-unknown delivery must be retried with the same durable key.
  // Keep these keys in memory for the lifetime of this surface; the daemon
  // remains authoritative and the next successful response clears them.
  const actionKeys = useRef(new Map<string, string>());
  const runtime = symphony.mode === "runtime" && symphony.envelope.mode === "runtime";
  const listQuery = useQuery({
    queryKey: ["symphony", "objectives", "all"],
    enabled: runtime,
    queryFn: ({ signal }) => fetchObjectiveAggregates(200, signal),
    retry: false,
    staleTime: 1_000,
    refetchOnWindowFocus: true,
  });
  const aggregates = listQuery.data?.aggregates ?? [];
  const snapshotQueries = useQueries({
    queries: aggregates.map((aggregate) => ({
      queryKey: ["symphony", "objective-snapshot", aggregate.objectiveId],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchObjectiveSnapshot(aggregate.objectiveId, signal),
      enabled: runtime,
      retry: false,
      staleTime: 1_000,
      refetchOnWindowFocus: true,
    })),
  });
  const workspaces = useMemo<ObjectiveWorkspaceProjection[]>(() => snapshotQueries.flatMap((query) => query.data ? [projectObjectiveSnapshot(query.data)] : []), [snapshotQueries]);
  const detailError = snapshotQueries.find((query) => query.error)?.error;
  const loading = runtime && (listQuery.isPending || snapshotQueries.some((query) => query.isPending));

  const invalidateObjective = useCallback(async (objectiveId?: string) => {
    await Promise.all([
      objectiveId
        ? queryClient.invalidateQueries({ queryKey: ["symphony", "objective-snapshot", objectiveId] })
        : Promise.resolve(),
      queryClient.invalidateQueries({ queryKey: ["symphony", "objectives"] }),
    ]);
  }, [queryClient]);

  const workspaceForRun = useCallback((runId: string) => {
    return workspaces.find((candidate) => candidate.runs.some((run) => run.runId === runId)) ?? null;
  }, [workspaces]);

  const runAction = useCallback(async (
    runId: string,
    action: "approve" | "resume" | "retry" | "stop",
    operation: (requestKey: string) => Promise<unknown>,
  ) => {
    const actionId = `${action}:${runId}`;
    if (activeAction !== null) return;
    const requestKey = actionKeys.current.get(actionId) ?? newIdempotencyKey();
    actionKeys.current.set(actionId, requestKey);
    setActiveAction(actionId);
    setActionError(null);
    try {
      const result = await operation(requestKey);
      if (isConflictResult(result)) {
        actionKeys.current.delete(actionId);
        throw new Error(`Request rejected: ${conflictReason(result)}`);
      }
      // Both committed and replayed daemon receipts are settled outcomes. The
      // projection is still refreshed from the daemon rather than trusting
      // the mutation response as a second source of truth.
      actionKeys.current.delete(actionId);
      await invalidateObjective(workspaceForRun(runId)?.objectiveId);
    } catch (error) {
      setActionError(errorMessage(error));
      // A transport error may follow a committed daemon transaction. Always
      // reconcile before exposing the action again; retain the key so a retry
      // can replay the exact original command instead of creating a duplicate.
      await invalidateObjective(workspaceForRun(runId)?.objectiveId);
      if (!isOutcomeUnknown(error)) actionKeys.current.delete(actionId);
    } finally {
      setActiveAction(null);
    }
  }, [activeAction, invalidateObjective, workspaceForRun]);

  const approveObjective = async (runId: string, approvalId: string) => {
    const workspace = workspaceForRun(runId);
    const approvalRecord = workspace?.snapshot.approvals.find((candidate) => candidate.id === approvalId);
    if (!approvalRecord || approvalRecord.status !== "requested") {
      setActionError("This approval is no longer pending. Refreshing the objective projection.");
      if (workspace) await queryClient.invalidateQueries({ queryKey: ["symphony", "objective-snapshot", workspace.objectiveId] });
      return;
    }
    await runAction(runId, "approve", (requestKey) => resolveObjectiveApproval(runId, approvalId, { status: "approved" }, requestKey));
  };

  const resumeObjective = useCallback(async (runId: string) => {
    const workspace = workspaceForRun(runId);
    const checkpoint = latestCheckpoint(workspace, runId);
    if (!checkpoint) {
      setActionError("Resume unavailable: this objective has no durable checkpoint boundary.");
      return;
    }
    await runAction(runId, "resume", (requestKey) => resumeObjectiveCheckpoint(runId, checkpoint.id, { expectedSequence: checkpoint.sequence }, requestKey));
  }, [runAction, workspaceForRun]);

  const retryObjective = useCallback(async (runId: string) => {
    const workspace = workspaceForRun(runId);
    const checkpoint = latestCheckpoint(workspace, runId);
    const activity = retryActivity(workspace, runId);
    if (!checkpoint || !activity) {
      setActionError("Retry unavailable: the latest durable checkpoint does not identify a retryable activity.");
      return;
    }
    await runAction(runId, "retry", (requestKey) => retryObjectiveCheckpoint(runId, checkpoint.id, {
      expectedSequence: checkpoint.sequence,
      activity,
    }, requestKey));
  }, [runAction, workspaceForRun]);

  const stopObjective = useCallback(async (runId: string) => {
    const workspace = workspaceForRun(runId);
    const run = workspace?.runs.find((candidate) => candidate.runId === runId);
    if (!run || ["succeeded", "failed", "cancelled", "interrupted"].includes(run.state)) {
      setActionError("Stop unavailable: this objective run is no longer active. Refreshing the projection.");
      if (workspace) await invalidateObjective(workspace.objectiveId);
      return;
    }
    await runAction(runId, "stop", (requestKey) => cancelObjectiveRun(runId, requestKey));
  }, [invalidateObjective, runAction, workspaceForRun]);

  if (!runtime) {
    return <SurfaceState title="Control room unavailable" detail="Connect to a live Symphony daemon to inspect durable objective runs." />;
  }
  if (listQuery.isError) {
    return <SurfaceState title="Control room unavailable" detail={listQuery.error instanceof Error ? listQuery.error.message : "The daemon objective list could not be loaded."} retryable />;
  }
  if (loading && workspaces.length === 0) {
    return <SurfaceState title="Loading control room" detail="Reading objective snapshots from the daemon." loading={symphony.connection === "live"} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {actionError ? <div className="mx-4 mt-4 rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2 text-[11px] text-destructive" role="alert">{actionError}</div> : null}
      {detailError ? <div className="mx-4 mt-4 rounded-lg border border-warning/25 bg-warning/8 px-3 py-2 text-[11px] text-warning" role="status">Some objective details are unavailable; showing only authoritative snapshots that loaded.</div> : null}
      <ObjectiveControlRoom
        workspaces={workspaces}
        onOpenObjective={onOpenObjective}
        onResumeObjective={resumeObjective}
        onRetryObjective={retryObjective}
        onStopObjective={stopObjective}
        onApproveObjective={approveObjective}
        onOpenAgent={onOpenAgent}
        onPeekAgent={onOpenAgent}
      />
      <AgentMessageProjection onOpenAgent={onOpenAgent} />
    </div>
  );
}

function latestCheckpoint(workspace: ObjectiveWorkspaceProjection | null, runId: string) {
  return workspace?.checkpoints
    .filter((checkpoint) => checkpoint.runId === runId)
    .slice()
    .sort((left, right) => right.sequence - left.sequence)[0] ?? null;
}

function retryActivity(workspace: ObjectiveWorkspaceProjection | null, runId: string) {
  const candidate = workspace?.frontier.find((item) => item.runId === runId && ["failed", "outcome-unknown"].includes(item.status));
  if (!candidate) return null;
  const id = candidate.kind === "task"
    ? candidate.taskId
    : candidate.executionId ?? candidate.nodeId ?? candidate.id;
  if (!id) return null;
  return {
    kind: candidate.kind,
    id,
    ...(candidate.attemptId ? { attemptId: candidate.attemptId } : {}),
  } as const;
}

function isOutcomeUnknown(error: unknown): boolean {
  return /outcome\s+unknown|reconciliation\s+required|unknown delivery/iu.test(error instanceof Error ? error.message : String(error));
}

function isConflictResult(value: unknown): value is { status: "conflict"; reason?: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { status?: unknown }).status === "conflict";
}

function conflictReason(value: { reason?: string }): string {
  return value.reason ?? "the daemon rejected this stale command";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SurfaceState({ title, detail, retryable = false, loading = false }: { title: string; detail: string; retryable?: boolean; loading?: boolean }) {
  return (
    <main className="grid min-h-0 flex-1 place-items-center bg-background px-6 text-center" aria-live={retryable ? "assertive" : "polite"}>
      <div className="max-w-md">
        {loading ? <AgentLoader kind="circular" size={22} label={title} animated /> : retryable ? <WarningCircle className="mx-auto size-6 text-warning" aria-hidden="true" /> : <CheckCircle className="mx-auto size-6 text-muted-foreground/65" aria-hidden="true" />}
        <h1 className="mt-3 text-sm font-medium text-foreground/90">{title}</h1>
        <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">{detail}</p>
      </div>
    </main>
  );
}
