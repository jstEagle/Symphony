"use client";

import { CaretRight } from "@phosphor-icons/react";
import { AuiConfig, AuiProvider } from "@assistant-ui/store";
import { SpanPrimitive, SpanResource, type SpanData } from "@assistant-ui/react-o11y";
import { useMemo } from "react";
import type { Agent, RunSnapshot } from "@/lib/symphony/contracts";

export function RunTrace({ snapshot, onSelectAgent }: { snapshot: RunSnapshot; onSelectAgent: (id: string) => void }) {
  const spans = useMemo(() => spansForRun(snapshot), [snapshot]);
  const config = AuiConfig({ span: SpanResource({ spans }) });

  if (spans.length === 0) {
    return <p className="text-xs text-muted-foreground">No run spans yet.</p>;
  }

  return (
    <AuiProvider extends={null} config={config}>
      <SpanPrimitive.Timeline className="space-y-1.5">
        <SpanPrimitive.Children>
          {({ span }) => (
            <SpanPrimitive.Root
              className="group/trace grid min-h-9 grid-cols-[minmax(0,1fr)_7rem] items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/45 md:grid-cols-[minmax(0,1fr)_9rem]"
              onClick={() => span.type !== "run" && onSelectAgent(span.id)}
            >
              <SpanPrimitive.Indent className="flex min-w-0 items-center gap-1.5 pr-1">
                <SpanPrimitive.CollapseToggle className="grid size-4 shrink-0 place-items-center text-muted-foreground transition-transform data-[collapsed=false]:rotate-90">
                  <CaretRight className="size-3" />
                </SpanPrimitive.CollapseToggle>
                {!span.hasChildren && <span className="size-4 shrink-0" />}
                <SpanPrimitive.StatusIndicator className="size-1.5 shrink-0 rounded-full bg-muted-foreground/45 data-[span-status=completed]:bg-success data-[span-status=failed]:bg-destructive data-[span-status=running]:bg-foreground/80" />
                <SpanPrimitive.Name className="truncate text-xs" />
                <SpanPrimitive.TypeBadge className="shrink-0 rounded-md bg-muted/65 px-1.5 py-0.5 text-[10px] text-muted-foreground" />
              </SpanPrimitive.Indent>
              <div className="relative h-5 overflow-hidden rounded-md bg-muted/45">
                <SpanPrimitive.TimelineBar className="top-1.5 h-2 rounded-sm bg-foreground/35 data-[span-status=completed]:bg-success/65 data-[span-status=failed]:bg-destructive/70 data-[span-status=running]:bg-foreground/70" />
              </div>
            </SpanPrimitive.Root>
          )}
        </SpanPrimitive.Children>
      </SpanPrimitive.Timeline>
    </AuiProvider>
  );
}

function spansForRun(snapshot: RunSnapshot): SpanData[] {
  if (snapshot.agents.length === 0) return [];
  const timestamps = snapshot.agents.flatMap((agent) => [toTime(agent.startedAt), toTime(agent.updatedAt), toTime(agent.finishedAt)]).filter((value): value is number => value !== null);
  const startedAt = timestamps.length ? Math.min(...timestamps) : Date.now();
  const terminal = ["completed", "failed", "cancelled"].includes(snapshot.runStatus ?? "");
  const endedAt = terminal && timestamps.length ? Math.max(...timestamps) : null;
  const rootId = `run:${snapshot.runId}`;
  return [
    {
      id: rootId,
      parentSpanId: null,
      name: snapshot.mission.statement,
      type: "run",
      status: runStatus(snapshot),
      startedAt,
      endedAt,
      latencyMs: endedAt === null ? null : Math.max(0, endedAt - startedAt),
    },
    ...snapshot.agents.map((agent) => agentSpan(agent, rootId, snapshot.agents)),
  ];
}

function agentSpan(agent: Agent, rootId: string, agents: Agent[]): SpanData {
  const startedAt = toTime(agent.startedAt) ?? toTime(agent.updatedAt) ?? Date.now();
  const endedAt = toTime(agent.finishedAt);
  return {
    id: agent.id,
    parentSpanId: agent.parentId && agents.some((candidate) => candidate.id === agent.parentId) ? agent.parentId : rootId,
    name: agent.objective,
    type: agent.harness,
    status: agentStatus(agent),
    startedAt,
    endedAt,
    latencyMs: endedAt === null ? null : Math.max(0, endedAt - startedAt),
  };
}

function agentStatus(agent: Agent): SpanData["status"] {
  if (agent.state === "failed") return "failed";
  if (agent.state === "cancelled") return "skipped";
  if (agent.state === "succeeded") return "completed";
  return "running";
}

function runStatus(snapshot: RunSnapshot): SpanData["status"] {
  if (snapshot.runStatus === "failed") return "failed";
  if (snapshot.runStatus === "cancelled") return "skipped";
  if (snapshot.runStatus === "completed") return "completed";
  return "running";
}

function toTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
