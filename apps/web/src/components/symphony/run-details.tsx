"use client";

import { ClockCounterClockwise, FlowArrow, Pulse, TreeStructure } from "@phosphor-icons/react";
import { useCallback, type ReactNode } from "react";
import type { RunSnapshot, WorkNode } from "@/lib/symphony/contracts";
import { costLabel, isActivelyWorkingAgent, loaderForHarness, statusLabel } from "@/lib/symphony/format";
import { progressCopy } from "@/lib/symphony/project";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { RunTrace } from "@/components/symphony/run-trace";
import { WorkflowGraph } from "@/components/symphony/workflow-graph";
import { PluginSlot } from "@/components/symphony/plugin-slots";
import { cn } from "@/lib/utils";

export type RunWorkspaceTab = "Overview" | "Trace" | "Graph" | "Activity";

const TAB_COPY: Record<RunWorkspaceTab, string> = {
  Overview: "Mission, progress, and participating agents.",
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

          {tab === "Overview" ? (
            <Overview snapshot={snapshot} live={live} onSelectAgent={onSelectAgent} />
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
                  <RunTrace snapshot={snapshot} onSelectAgent={onSelectAgent} />
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
                <WorkflowGraph
                  nodes={snapshot.nodes}
                  edges={snapshot.edges}
                  selectedId={selectedAgentId}
                  onSelect={selectGraphNode}
                />
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

function Overview({
  snapshot,
  live,
  onSelectAgent,
}: {
  snapshot: RunSnapshot;
  live: number;
  onSelectAgent: (id: string) => void;
}) {
  return (
    <div className="grid flex-1 gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.72fr)]">
      <div className="space-y-5">
        <Surface className="p-6 md:p-8">
          <SectionHeading title="Mission" meta={`Revision ${snapshot.mission.revision}`} />
          <p className="max-w-4xl text-pretty text-lg leading-8 tracking-[-0.015em] text-foreground/95 md:text-xl">
            {snapshot.mission.statement}
          </p>
          {snapshot.mission.keyResults.length > 0 ? (
            <ul className="mt-6 grid gap-2 sm:grid-cols-2">
              {snapshot.mission.keyResults.map((result) => (
                <li key={result} className="flex min-h-12 items-start gap-3 rounded-lg bg-muted/35 px-4 py-3 text-xs leading-5 text-muted-foreground">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-foreground/65" />
                  <span>{result}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Surface>

        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Fact label="Status" value={snapshot.phase} />
          <Fact label="Agents" value={String(snapshot.agents.length)} />
          <Fact label="Active" value={String(live)} />
          <Fact label="Cost" value={costLabel(snapshot.cost)} />
        </div>
        <PluginSlot name="run-details.section" />
      </div>

      <Surface className="min-h-[22rem] p-5 md:p-6">
        <SectionHeading title="Agents" meta={`${snapshot.agents.length} total`} />
        {snapshot.agents.length === 0 ? (
          <div className="grid min-h-64 place-items-center px-5 text-center">
            <div>
              <TreeStructure className="mx-auto size-7 text-muted-foreground/65" weight="light" />
              <p className="mt-3 text-[13px] font-medium">No agents yet</p>
              <p className="mt-1 text-xs text-muted-foreground">Delegated work will appear here.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {snapshot.agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => onSelectAgent(agent.id)}
                className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/55"
              >
                <AgentLoader
                  kind={loaderForHarness(agent.harness)}
                  size={15}
                  label={`${agent.name} ${agent.state}`}
                  animated={isActivelyWorkingAgent(agent.state)}
                  tone={agent.state === "succeeded" ? "success" : agent.state === "failed" ? "danger" : agent.state === "running" || agent.state === "queued" ? "info" : "warning"}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium" title={agent.objective}>{agent.name}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{agent.harness} · {agent.model}</span>
                </span>
                <span className="text-[10px] text-muted-foreground">{statusLabel(agent.state, agent.nativeStatus)}</span>
              </button>
            ))}
          </div>
        )}
      </Surface>
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

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-h-24 rounded-xl bg-card/65 p-4 md:p-5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-3 truncate text-base font-medium capitalize tracking-[-0.02em]" title={value}>{value}</p>
    </div>
  );
}
