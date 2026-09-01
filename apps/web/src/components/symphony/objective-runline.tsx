"use client";

import {
  ArrowSquareOut,
  CaretRight,
  Check,
  ClockCounterClockwise,
  TreeStructure,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useMemo } from "react";
import type { ActivityEvent, Agent, AgentState, RunSnapshot } from "@/lib/symphony/contracts";
import {
  costLabel,
  formatCost,
  isActivelyWorkingAgent,
  loaderForHarness,
  statusLabel,
} from "@/lib/symphony/format";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { cn } from "@/lib/utils";

type ObjectiveRunlineProps = {
  snapshot: RunSnapshot;
  onSelectAgent: (id: string) => void;
};

type AgentTree = {
  agent: Agent;
  children: AgentTree[];
};

type FrontierCounts = {
  active: number;
  queued: number;
  waiting: number;
  blocked: number;
  failed: number;
  completed: number;
  cancelled: number;
};

const terminalStates = new Set<AgentState>(["succeeded", "cancelled"]);

export function ObjectiveRunline({ snapshot, onSelectAgent }: ObjectiveRunlineProps) {
  const tree = useMemo(() => buildAgentTree(snapshot.agents), [snapshot.agents]);
  const counts = useMemo(() => countStates(snapshot.agents), [snapshot.agents]);
  const latestEvents = useMemo(() => latestEventsByAgent(snapshot.events), [snapshot.events]);
  const frontier = useMemo(
    () => flattenTree(tree).filter(({ agent }) => !terminalStates.has(agent.state)).slice(0, 4),
    [tree],
  );

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <MissionHeader snapshot={snapshot} counts={counts} />

      <div className="sticky top-0 z-20 -mx-1 border-y border-border/45 bg-background/95 px-1 py-3 backdrop-blur-xl">
        <FrontierSummary counts={counts} frontier={frontier} />
      </div>

      <section className="mt-5 flex-1" aria-labelledby="runline-heading">
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="size-1.5 shrink-0 rounded-full bg-foreground/65" aria-hidden="true" />
            <h3 id="runline-heading" className="text-[11px] font-medium tracking-[0.08em] text-foreground/85">
              Workline
            </h3>
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {snapshot.phase || "Awaiting phase"}
            </span>
          </div>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {snapshot.agents.length} packet{snapshot.agents.length === 1 ? "" : "s"}
          </span>
        </div>

        {tree.length === 0 ? (
          <EmptyRunline />
        ) : (
          <div className="relative border-l border-border/65 pl-4 md:pl-5">
            {tree.map((node) => (
              <AgentPacket
                key={node.agent.id}
                node={node}
                depth={0}
                latestEvents={latestEvents}
                currency={snapshot.cost.currency}
                onSelectAgent={onSelectAgent}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function MissionHeader({ snapshot, counts }: { snapshot: RunSnapshot; counts: FrontierCounts }) {
  const runStatus = snapshot.runStatus || "idle";

  return (
    <header className="pb-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 max-w-4xl">
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            <span className="font-medium text-foreground/80">Mission</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">run {snapshot.runId}</span>
            <span aria-hidden="true">·</span>
            <span>revision {snapshot.mission.revision}</span>
          </div>
          <h2 className="text-[clamp(1.15rem,1.5vw,1.55rem)] font-medium leading-tight tracking-[-0.025em] text-foreground">
            {snapshot.mission.statement || "No mission statement supplied"}
          </h2>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 text-[10px] text-muted-foreground lg:justify-end">
          <CompactFact label="Run" value={runStatus} emphasis={runStatus === "running"} />
          <CompactFact label="Phase" value={snapshot.phase || "—"} />
          <CompactFact label="Cost" value={costLabel(snapshot.cost)} />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border/45 pt-3 text-[10px] text-muted-foreground">
        <span className="font-mono text-foreground/70">{snapshot.workspace || "workspace unavailable"}</span>
        <span>{counts.completed}/{snapshot.agents.length || 0} completed</span>
        {snapshot.mission.hash ? <span className="font-mono">mission {snapshot.mission.hash}</span> : null}
      </div>

      {snapshot.mission.keyResults.length > 0 ? (
        <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2" aria-label="Mission key results">
          {snapshot.mission.keyResults.map((result) => (
            <li key={result} className="flex min-w-0 items-start gap-2 text-[11px] leading-4 text-muted-foreground">
              <Check className="mt-0.5 size-3 shrink-0 text-foreground/55" weight="bold" aria-hidden="true" />
              <span className="max-w-[31rem]">{result}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </header>
  );
}

function CompactFact({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <span className="inline-flex max-w-[13rem] items-baseline gap-1.5">
      <span className="text-muted-foreground/65">{label}</span>
      <span className={cn("truncate font-mono", emphasis && "text-info")}>{value}</span>
    </span>
  );
}

function FrontierSummary({
  counts,
  frontier,
}: {
  counts: FrontierCounts;
  frontier: AgentTree[];
}) {
  return (
    <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px] font-mono tabular-nums text-muted-foreground">
        <span className="mr-1 font-sans font-medium text-foreground/85">Frontier</span>
        <StateCount label="active" value={counts.active} tone="info" />
        <StateCount label="queued" value={counts.queued} tone="info" />
        <StateCount label="waiting" value={counts.waiting} tone="warning" />
        <StateCount label="blocked" value={counts.blocked} tone="warning" />
        <StateCount label="failed" value={counts.failed} tone="danger" />
        <StateCount label="done" value={counts.completed} tone="success" />
        {counts.cancelled > 0 ? <StateCount label="cancelled" value={counts.cancelled} tone="warning" /> : null}
      </div>

      <div className="flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground lg:max-w-[48%] lg:justify-end">
        <span className="shrink-0 text-muted-foreground/65">next</span>
        <span className="truncate font-medium text-foreground/80">
          {frontier.length > 0 ? frontier.map(({ agent }) => agent.name).join(" · ") : "All packets settled"}
        </span>
      </div>
    </div>
  );
}

function StateCount({ label, value, tone }: { label: string; value: number; tone: "info" | "success" | "warning" | "danger" }) {
  const toneClass = {
    info: "bg-info",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-destructive",
  }[tone];

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", toneClass)} aria-hidden="true" />
      {value} {label}
    </span>
  );
}

function AgentPacket({
  node,
  depth,
  latestEvents,
  currency,
  onSelectAgent,
}: {
  node: AgentTree;
  depth: number;
  latestEvents: ReadonlyMap<string, ActivityEvent>;
  currency: string;
  onSelectAgent: (id: string) => void;
}) {
  const { agent } = node;
  const latest = latestEvents.get(agent.id);
  const active = isActivelyWorkingAgent(agent.state);
  const tone = packetTone(agent.state);
  const state = statusLabel(agent.state, agent.nativeStatus);

  return (
    <div className="relative" style={{ marginLeft: depth * 18 }}>
      <span className="absolute -left-[1.32rem] top-5 size-1.5 rounded-full bg-foreground/55 ring-4 ring-background" aria-hidden="true" />
      {depth > 0 ? <span className="absolute -left-[1.32rem] top-0 h-5 w-px -translate-x-1/2 bg-border/70" aria-hidden="true" /> : null}
      <button
        type="button"
        onClick={() => onSelectAgent(agent.id)}
        className={cn(
          "group mb-2.5 flex w-full min-w-0 cursor-pointer flex-col gap-2 border-b border-border/45 py-3 text-left transition-[background-color,transform] duration-150 ease-out hover:bg-muted/28 active:translate-y-px",
          active && "bg-info/[0.035]",
          agent.state === "failed" && "bg-destructive/[0.035]",
        )}
        aria-label={`Open ${agent.name}, ${state}`}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <AgentLoader
            kind={loaderForHarness(agent.harness)}
            size={15}
            label={`${agent.name} ${state}`}
            animated={active}
            tone={tone}
          />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="truncate text-[13px] font-medium text-foreground/95">{agent.name}</span>
              <span className="font-mono text-[9px] text-muted-foreground">{agent.harness} · {agent.model}</span>
            </span>
          </span>
          <span className={cn("shrink-0 font-mono text-[10px]", toneTextClass(agent.state))}>{state}</span>
          <ArrowSquareOut className="size-3 shrink-0 text-muted-foreground/35 transition-colors group-hover:text-foreground/75" aria-hidden="true" />
        </span>

        <span className="block pl-[1.52rem] text-[11px] leading-4 text-foreground/80">
          {agent.objective}
        </span>

        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-[1.52rem] text-[10px] text-muted-foreground">
          <span className="font-mono tabular-nums">{agent.elapsed}</span>
          <span>{formatCost(agent.cost, currency)}</span>
          <span className="text-muted-foreground/55">{agent.access === "read-only" ? "read-only" : "full access"}</span>
          <ActivitySignal agent={agent} latest={latest} />
        </span>

        <PacketState agent={agent} latest={latest} />
      </button>

      {node.children.length > 0 ? (
        <div className="relative border-l border-dashed border-border/55 pl-3">
          {node.children.map((child) => (
            <AgentPacket
              key={child.agent.id}
              node={child}
              depth={depth + 1}
              latestEvents={latestEvents}
              currency={currency}
              onSelectAgent={onSelectAgent}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActivitySignal({ agent, latest }: { agent: Agent; latest?: ActivityEvent }) {
  if (latest) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <ClockCounterClockwise className="size-3 shrink-0 text-muted-foreground/65" aria-hidden="true" />
        <span className="max-w-[30rem] truncate" title={latest.detail || latest.title}>{latest.title}</span>
        {latest.cursor !== undefined ? <span className="font-mono text-[9px] text-muted-foreground/60">#{latest.cursor}</span> : null}
      </span>
    );
  }

  return <span>{agent.lastActivity ? `Last activity ${agent.lastActivity}` : "No activity observed"}</span>;
}

function PacketState({ agent, latest }: { agent: Agent; latest?: ActivityEvent }) {
  if (agent.state === "waiting") {
    return (
      <span className="flex items-start gap-1.5 pl-[1.52rem] text-[10px] leading-4 text-warning">
        <WarningCircle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
        <span>Waiting{agent.nativeStatus ? ` · native status ${agent.nativeStatus}` : ""}</span>
      </span>
    );
  }

  if (agent.state === "failed" || agent.state === "stale") {
    return (
      <span className="flex items-start gap-1.5 pl-[1.52rem] text-[10px] leading-4 text-destructive">
        <XCircle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate" title={agent.error || latest?.detail || undefined}>
          {agent.error || latest?.detail || "Failed without an error detail"}
        </span>
      </span>
    );
  }

  if (agent.state === "succeeded") {
    return (
      <span className="flex items-start gap-1.5 pl-[1.52rem] text-[10px] leading-4 text-success">
        <Check className="mt-0.5 size-3 shrink-0" weight="bold" aria-hidden="true" />
        <span>{agent.output !== null && agent.output !== undefined ? "Completed · output present" : "Completed · no output reported"}</span>
      </span>
    );
  }

  if (agent.state === "cancelled") {
    return <span className="pl-[1.52rem] text-[10px] text-warning">Cancelled</span>;
  }

  return null;
}

function EmptyRunline() {
  return (
    <div className="relative flex min-h-56 items-center gap-3 border-y border-border/45 px-3 py-8 text-muted-foreground">
      <TreeStructure className="size-5 shrink-0 opacity-65" weight="light" aria-hidden="true" />
      <div>
        <p className="text-[12px] font-medium text-foreground/85">No delegated work yet</p>
        <p className="mt-1 text-[11px] leading-5">The conductor will add work packets here as the mission unfolds.</p>
      </div>
      <CaretRight className="ml-auto size-4 opacity-45" aria-hidden="true" />
    </div>
  );
}

function buildAgentTree(agents: Agent[]): AgentTree[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const childrenByParent = new Map<string, Agent[]>();
  for (const agent of agents) {
    if (!agent.parentId || !byId.has(agent.parentId)) continue;
    const children = childrenByParent.get(agent.parentId) ?? [];
    children.push(agent);
    childrenByParent.set(agent.parentId, children);
  }

  const roots = agents.filter((agent) => !agent.parentId || !byId.has(agent.parentId));
  const startingPoints = roots.length > 0 ? roots : agents;
  const makeTree = (agent: Agent, ancestors: ReadonlySet<string>): AgentTree => {
    if (ancestors.has(agent.id)) return { agent, children: [] };
    const nextAncestors = new Set(ancestors).add(agent.id);
    return {
      agent,
      children: (childrenByParent.get(agent.id) ?? []).map((child) => makeTree(child, nextAncestors)),
    };
  };
  return startingPoints.map((agent) => makeTree(agent, new Set()));
}

function flattenTree(tree: AgentTree[]): AgentTree[] {
  const result: AgentTree[] = [];
  const visit = (node: AgentTree) => {
    result.push(node);
    node.children.forEach(visit);
  };
  tree.forEach(visit);
  return result;
}

function countStates(agents: Agent[]): FrontierCounts {
  return agents.reduce<FrontierCounts>((counts, agent) => {
    if (agent.state === "running") counts.active += 1;
    if (agent.state === "queued") counts.queued += 1;
    if (agent.state === "waiting") counts.waiting += 1;
    if (agent.state === "blocked" || agent.state === "stale") counts.blocked += 1;
    if (agent.state === "failed") counts.failed += 1;
    if (agent.state === "succeeded") counts.completed += 1;
    if (agent.state === "cancelled") counts.cancelled += 1;
    return counts;
  }, { active: 0, queued: 0, waiting: 0, blocked: 0, failed: 0, completed: 0, cancelled: 0 });
}

function latestEventsByAgent(events: ActivityEvent[]): ReadonlyMap<string, ActivityEvent> {
  const latest = new Map<string, { event: ActivityEvent; index: number; timestamp: number; cursor: number }>();
  events.forEach((event, index) => {
    if (!event.agentId) return;
    const timestamp = event.occurredAt ? Date.parse(event.occurredAt) : Number.NaN;
    const cursor = event.cursor ?? Number.NaN;
    const previous = latest.get(event.agentId);
    const later = !previous
      || (Number.isFinite(cursor) && (!Number.isFinite(previous?.cursor) || cursor >= previous.cursor))
      || (!Number.isFinite(cursor) && !Number.isFinite(previous?.cursor) && Number.isFinite(timestamp) && (!Number.isFinite(previous.timestamp) || timestamp >= previous.timestamp))
      || (!Number.isFinite(cursor) && !Number.isFinite(previous?.cursor) && !Number.isFinite(timestamp) && !Number.isFinite(previous.timestamp) && index >= previous.index);
    if (later) {
      latest.set(event.agentId, { event, index, timestamp, cursor });
    }
  });
  return new Map([...latest].map(([agentId, value]) => [agentId, value.event]));
}

function packetTone(state: AgentState): "default" | "info" | "success" | "warning" | "danger" {
  if (state === "running" || state === "queued") return "info";
  if (state === "succeeded") return "success";
  if (state === "failed" || state === "stale") return "danger";
  if (state === "waiting" || state === "blocked" || state === "cancelled") return "warning";
  return "default";
}

function toneTextClass(state: AgentState): string {
  if (state === "running" || state === "queued") return "text-info";
  if (state === "succeeded") return "text-success";
  if (state === "failed" || state === "stale") return "text-destructive";
  if (state === "waiting" || state === "blocked" || state === "cancelled") return "text-warning";
  return "text-muted-foreground";
}
