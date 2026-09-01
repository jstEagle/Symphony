"use client";

import { ClockCounterClockwise, FlowArrow, Pulse } from "@phosphor-icons/react";
import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RunSnapshot, WorkNode } from "@/lib/symphony/contracts";
import { isActivelyWorkingAgent, loaderForHarness } from "@/lib/symphony/format";
import { progressCopy } from "@/lib/symphony/project";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { objectiveProjectionState, selectLatestObjective, type ObjectiveProjectionState } from "@/lib/symphony/objective-project";
import { projectObjectiveSnapshot, type ObjectiveWorkspaceProjection } from "@/lib/symphony/objective-snapshot";
import {
  fetchObjectiveSnapshot,
  fetchObjectiveList,
  newIdempotencyKey,
  reviewObjectiveArtifact,
  resolveObjectiveApproval,
} from "@/lib/symphony/runtime-client";
import type { WorkspaceTab } from "@/lib/symphony/workspace-tabs";
import { PluginSlot } from "@/components/symphony/plugin-slots";
import { cn } from "@/lib/utils";

// Graph and trace carry separate interaction/runtime primitives. Keep them
// out of the run-details chunk until the user actually opens that surface.
const RunTrace = lazy(() => import("@/components/symphony/run-trace").then((module) => ({ default: module.RunTrace })));
const WorkflowGraph = lazy(() => import("@/components/symphony/workflow-graph").then((module) => ({ default: module.WorkflowGraph })));
const ObjectiveRunline = lazy(() => import("@/components/symphony/objective-runline").then((module) => ({ default: module.ObjectiveRunline })));
const ObjectiveWorkbench = lazy(() => import("@/components/symphony/objective-workbench").then((module) => ({ default: module.ObjectiveWorkbench })));

export type RunWorkspaceTab = Exclude<WorkspaceTab, "Chat" | "ControlRoom" | "Studio">;

const TAB_COPY: Record<RunWorkspaceTab, string> = {
  Runline: "Mission, frontier, and causal work packets.",
  Trace: "Execution timing and delegation structure.",
  Graph: "Workflow structure and agent relationships.",
  Activity: "A chronological record of the run.",
};

export function RunDetails({
  snapshot,
  selectedAgentId,
  onSelectAgent,
  tab,
}: {
  snapshot: RunSnapshot;
  selectedAgentId?: string | null;
  onSelectAgent: (id: string) => void;
  tab: RunWorkspaceTab;
}) {
  const objective = useObjectiveProjection(snapshot, tab === "Runline");
  const live = snapshot.agents.filter((agent) => isActivelyWorkingAgent(agent.state)).length;
  const liveAgent = snapshot.agents.find((agent) => isActivelyWorkingAgent(agent.state));
  const selectGraphNode = useCallback((node: WorkNode) => {
    if (node.agentId) onSelectAgent(node.agentId);
  }, [onSelectAgent]);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full w-full max-w-[90rem] flex-col px-5 py-7 md:px-8 md:py-9 lg:px-12">
          <WorkspaceHeader
            tab={tab}
            snapshot={snapshot}
            live={live}
            liveAgentHarness={liveAgent?.harness}
          />

          {tab === "Runline" ? (
            <>
              <Suspense fallback={<RunSurfaceLoading label="Loading runline" />}>
                {objective.workspace ? (
                  <ObjectiveWorkbench
                    workspace={objective.workspace}
                    onOpenAgent={onSelectAgent}
                    onResolveApproval={objective.resolveApproval}
                    onReviewArtifact={objective.reviewArtifact}
                    resolvingApprovalId={objective.resolvingApprovalId}
                    approvalError={objective.approvalError}
                  />
                ) : objective.state === "loading" ? (
                  <ObjectiveLoading />
                ) : objective.state === "unavailable" ? (
                  <ObjectiveUnavailable source={objective.errorSource} error={objective.error} />
                ) : (
                  <ObjectiveRunline snapshot={snapshot} onSelectAgent={onSelectAgent} />
                )}
              </Suspense>
              <PluginSlot name="run-details.section" />
            </>
          ) : null}

          {tab === "Trace" ? (
            snapshot.agents.length === 0 ? (
              <EmptyWorkspace
                icon={<Pulse weight="light" />}
                title="No trace yet"
                detail="Execution spans appear when the conductor starts working."
              />
            ) : (
              <div className="flex flex-1">
                <Surface className="min-h-[28rem] w-full overflow-hidden p-5 md:p-6">
                  <SectionHeading title="Trace waterfall" meta={`${snapshot.agents.length} agents`} />
                  <Suspense fallback={<RunSurfaceLoading label="Loading trace" />}>
                    <RunTrace snapshot={snapshot} onSelectAgent={onSelectAgent} />
                  </Suspense>
                </Surface>
              </div>
            )
          ) : null}

          {tab === "Graph" ? (
            snapshot.nodes.length === 0 ? (
              <EmptyWorkspace
                icon={<FlowArrow weight="light" />}
                title="No workflow yet"
                detail="Agents and dependencies appear when a workflow begins."
                grid
              />
            ) : (
              <Surface className="symphony-graph-surface min-h-[34rem] flex-1 overflow-hidden p-0">
                <Suspense fallback={<RunSurfaceLoading label="Loading graph" />}>
                  <WorkflowGraph
                    nodes={snapshot.nodes}
                    edges={snapshot.edges}
                    selectedId={selectedAgentId}
                    onSelect={selectGraphNode}
                  />
                </Suspense>
              </Surface>
            )
          ) : null}

          {tab === "Activity" ? (
            snapshot.events.length === 0 ? (
              <EmptyWorkspace
                icon={<ClockCounterClockwise weight="light" />}
                title="No activity yet"
                detail="Run events will collect here in chronological order."
              />
            ) : (
              <Surface className="mx-auto w-full max-w-5xl px-5 md:px-7">
                <ol>
                  {snapshot.events.map((event, index) => (
                    <li
                      key={event.id}
                      className="grid grid-cols-[5.5rem_1rem_minmax(0,1fr)] gap-3 py-5 [contain-intrinsic-size:auto_76px] [content-visibility:auto] md:grid-cols-[7rem_1rem_minmax(0,1fr)]"
                    >
                      <time className="pt-0.5 text-right text-[11px] tabular-nums text-muted-foreground">
                        {event.at}
                      </time>
                      <span className="relative flex justify-center pt-1.5">
                        <span className="z-10 size-1.5 rounded-full bg-foreground/70" />
                        {index < snapshot.events.length - 1 ? (
                          <span className="absolute bottom-[-1.25rem] top-2.5 w-px bg-border" />
                        ) : null}
                      </span>
                      <div className="min-w-0 pb-1">
                        <p className="text-[13px] font-medium text-foreground/95">{event.title}</p>
                        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{event.detail}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Surface>
            )
          ) : null}
        </div>
      </div>
    </section>
  );
}

function useObjectiveProjection(snapshot: RunSnapshot, enabled: boolean): {
  workspace: ObjectiveWorkspaceProjection | null;
  state: ObjectiveProjectionState;
  errorSource: "list" | "snapshot" | null;
  error: string | null;
  resolveApproval: (approvalId: string, decision: "approved" | "rejected") => Promise<void>;
  resolvingApprovalId: string | null;
  approvalError: string | null;
  reviewArtifact: (artifactId: string, state: "verified" | "rejected", reason: string) => Promise<void>;
} {
  const workflowId = snapshot.workflowId?.trim() ?? "";
  const conductorAgentId = snapshot.agents.find((agent) => agent.depth === 0)?.id ?? null;
  const agentIds = useMemo(() => snapshot.agents.map((agent) => agent.id), [snapshot.agents]);
  const live = snapshot.mode === "live";
  const listQuery = useQuery({
    // Fetch the authoritative bounded list once, then select by conversation
    // ownership below. Filtering only by workflow hid standalone/manual
    // objectives whose workflow identity is intentionally independent.
    queryKey: ["symphony", "objectives", "all"],
    enabled: enabled && live,
    queryFn: ({ signal }) => fetchObjectiveList({ limit: 200 }, signal),
    retry: false,
    staleTime: 1_000,
    refetchOnWindowFocus: true,
  });

  const objectiveRun = useMemo(
    () => selectLatestObjective(listQuery.data?.objectives ?? [], {
      workflowId,
      runId: snapshot.runId,
      conductorAgentId,
      agentIds,
    }),
    [agentIds, conductorAgentId, listQuery.data?.objectives, snapshot.runId, workflowId],
  );
  const snapshotQuery = useQuery({
    queryKey: ["symphony", "objective-snapshot", objectiveRun?.objectiveId ?? null],
    enabled: enabled && live && objectiveRun !== null,
    queryFn: ({ signal }) => fetchObjectiveSnapshot(objectiveRun!.objectiveId, signal),
    retry: false,
    staleTime: 1_000,
    refetchOnWindowFocus: true,
  });
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);

  const resolveApproval = useCallback(async (approvalId: string, decision: "approved" | "rejected") => {
    if (!objectiveRun || resolvingApprovalId !== null) return;
    setResolvingApprovalId(approvalId);
    setApprovalError(null);
    try {
      const pending = snapshotQuery.data?.approvals.find((approval) => approval.id === approvalId);
      if (!pending || pending.status !== "requested") {
        const refreshed = await snapshotQuery.refetch();
        if (refreshed.error) throw refreshed.error;
        throw new Error("This approval is no longer pending. The objective was refreshed.");
      }

      // The mutation response is intentionally not projected into the UI: the
      // next render must come from a fresh daemon detail/list response.
      await resolveObjectiveApproval(
        objectiveRun.runId,
        approvalId,
        { status: decision },
        newIdempotencyKey(),
      );
      const [refreshedSnapshot, refreshedList] = await Promise.all([
        snapshotQuery.refetch(),
        listQuery.refetch(),
      ]);
      if (refreshedSnapshot.error) throw refreshedSnapshot.error;
      if (refreshedList.error) throw refreshedList.error;
      if (!refreshedSnapshot.data || refreshedSnapshot.data.objective.objectiveId !== objectiveRun.objectiveId) {
        throw new Error("The approval was resolved, but the authoritative objective snapshot could not be refreshed.");
      }
    } catch (error) {
      setApprovalError(errorMessage(error));
      // A failed mutation may still have been committed before transport loss;
      // reconcile from the daemon so a retry cannot act on stale local state.
      void snapshotQuery.refetch();
    } finally {
      setResolvingApprovalId(null);
    }
  }, [listQuery, objectiveRun, resolvingApprovalId, snapshotQuery]);

  const reviewArtifact = useCallback(async (artifactId: string, state: "verified" | "rejected", reason: string) => {
    if (!objectiveRun) return;
    const artifact = snapshotQuery.data?.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact || artifact.reviewState !== "pending") {
      setArtifactError("This artifact review is stale. Refreshing the objective snapshot.");
      await snapshotQuery.refetch();
      return;
    }
    setArtifactError(null);
    try {
      await reviewObjectiveArtifact(artifact.runId, artifactId, { state, reason }, newIdempotencyKey());
      const refreshed = await snapshotQuery.refetch();
      if (refreshed.error) throw refreshed.error;
      const updated = refreshed.data?.artifacts.find((candidate) => candidate.id === artifactId);
      if (!updated || updated.reviewState !== state) throw new Error("The artifact review was accepted, but the authoritative snapshot did not advance.");
    } catch (error) {
      setArtifactError(errorMessage(error));
      void snapshotQuery.refetch();
    }
  }, [objectiveRun, snapshotQuery]);

  const workspace = useMemo(() => {
    const value = snapshotQuery.data;
    if (listQuery.error || snapshotQuery.error || !value || !objectiveRun || value.objective?.objectiveId !== objectiveRun.objectiveId) return null;
    return projectObjectiveSnapshot(value);
  }, [listQuery.error, objectiveRun, snapshotQuery.data, snapshotQuery.error]);

  const snapshotIdentityError = objectiveRun && snapshotQuery.data
    && snapshotQuery.data.objective?.objectiveId !== objectiveRun.objectiveId
    ? new Error("The daemon returned an objective snapshot for a different objective.")
    : null;

  const state = objectiveProjectionState({
    enabled,
    live,
    listPending: listQuery.isPending,
    listFetching: listQuery.isFetching,
    listError: listQuery.error,
    objectiveRun,
    snapshotPending: snapshotQuery.isPending,
    snapshotFetching: snapshotQuery.isFetching,
    snapshotError: snapshotQuery.error ?? snapshotIdentityError,
    snapshotReady: snapshotQuery.data?.objective?.objectiveId === objectiveRun?.objectiveId,
  });
  const errorSource = listQuery.error ? "list" : snapshotQuery.error ? "snapshot" : null;
  const errorSourceWithIdentity = errorSource ?? (snapshotIdentityError ? "snapshot" : null);
  const error = listQuery.error ? errorMessage(listQuery.error) : snapshotQuery.error ? errorMessage(snapshotQuery.error) : snapshotIdentityError ? snapshotIdentityError.message : null;
  return { workspace, state, errorSource: errorSourceWithIdentity, error, resolveApproval, resolvingApprovalId, approvalError: approvalError ?? artifactError, reviewArtifact };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ObjectiveLoading() {
  return (
    <div className="flex min-h-[18rem] flex-1 items-center justify-center text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <AgentLoader kind="square" size={18} label="Loading objective" />
        <span>Loading objective…</span>
      </div>
    </div>
  );
}

function ObjectiveUnavailable({ source, error }: { source: "list" | "snapshot" | null; error: string | null }) {
  const subject = source === "snapshot" ? "objective snapshot" : "objective list";
  return (
    <div className="flex min-h-[18rem] flex-1 items-center justify-center px-5 text-center" role="alert" aria-live="assertive">
      <div className="max-w-md">
        <span className="mx-auto grid size-9 place-items-center rounded-full border border-warning/30 bg-warning/10 text-warning" aria-hidden="true">!</span>
        <h3 className="mt-3 text-sm font-medium text-foreground/90">Authoritative runline unavailable</h3>
        <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
          The daemon {subject} could not be loaded. Reconnecting will retry the authoritative objective projection; chat activity is not substituted here.
        </p>
        {error ? <p className="mt-2 break-words font-mono text-[10px] text-warning/85">{error}</p> : null}
      </div>
    </div>
  );
}

function RunSurfaceLoading({ label }: { label: string }) {
  return (
    <div className="grid min-h-[28rem] place-items-center text-xs text-muted-foreground">
      <span className="flex items-center gap-2">
        <AgentLoader kind="square" size={16} label={label} />
        {label}…
      </span>
    </div>
  );
}

function WorkspaceHeader({
  tab,
  snapshot,
  live,
  liveAgentHarness,
}: {
  tab: RunWorkspaceTab;
  snapshot: RunSnapshot;
  live: number;
  liveAgentHarness?: string;
}) {
  return (
    <div className="mb-7 flex flex-col gap-5 md:mb-9 md:flex-row md:items-start md:justify-between">
      <div>
        <h2 className="text-xl font-medium tracking-[-0.025em] text-foreground md:text-2xl">{tab}</h2>
        <p className="mt-1.5 text-[13px] text-muted-foreground">{TAB_COPY[tab]}</p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground md:justify-end">
        <span className="inline-flex h-8 items-center gap-2 rounded-lg bg-muted/45 px-3 text-foreground/85">
          {live > 0 ? (
            <AgentLoader kind={loaderForHarness(liveAgentHarness ?? "pi")} size={13} label={`${live} agents active`} />
          ) : (
            <span className="size-1.5 rounded-full bg-muted-foreground/45" />
          )}
          {progressCopy(snapshot)}
        </span>
        {snapshot.workspace ? (
          <span
            className="max-w-[22rem] truncate rounded-lg bg-muted/30 px-3 py-2 font-mono text-[10px]"
            title={snapshot.workspace}
          >
            {snapshot.workspace}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function EmptyWorkspace({
  icon,
  title,
  detail,
  grid = false,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  grid?: boolean;
}) {
  return (
    <Surface className={cn("relative grid min-h-[32rem] flex-1 place-items-center overflow-hidden", grid && "symphony-graph-surface")}>
      <div className="relative max-w-sm px-8 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-xl bg-muted/60 text-muted-foreground [&>svg]:size-6">
          {icon}
        </span>
        <h3 className="mt-4 text-sm font-medium tracking-[-0.01em]">{title}</h3>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{detail}</p>
      </div>
    </Surface>
  );
}

function Surface({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn("rounded-xl bg-card/65", className)}>{children}</section>;
}

function SectionHeading({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="mb-5 flex items-center justify-between gap-3">
      <h3 className="text-[13px] font-medium text-foreground/90">{title}</h3>
      <span className="text-[10px] text-muted-foreground">{meta}</span>
    </div>
  );
}
