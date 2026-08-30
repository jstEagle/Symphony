"use client";

import { CaretRight } from "@phosphor-icons/react";
import { AuiConfig, AuiProvider } from "@assistant-ui/store";
import { SpanPrimitive, SpanResource, type SpanData } from "@assistant-ui/react-o11y";
import { useMemo } from "react";
import type { Agent, EventEnvelope, JsonValue, RunSnapshot } from "../../lib/symphony/contracts";
import { isSettledAgent } from "../../lib/symphony/format";

const TICK_COUNT = 5;

export type TraceModel = {
  spans: SpanData[];
  agentBySpan: Map<string, string>;
  range: { min: number; max: number };
};

export function RunTrace({ snapshot, onSelectAgent }: { snapshot: RunSnapshot; onSelectAgent: (id: string) => void }) {
  const model = useMemo(() => buildTraceModel(snapshot), [snapshot]);
  const config = AuiConfig({ span: SpanResource({ spans: model.spans }) });

  if (model.spans.length === 0) {
    return <p className="text-xs text-muted-foreground">No run spans yet.</p>;
  }

  const duration = model.range.max - model.range.min;
  return (
    <AuiProvider extends={null} config={config}>
      <div className="max-h-[min(62vh,46rem)] overflow-auto overscroll-contain rounded-lg border border-border/70 bg-background/28">
        <SpanPrimitive.Timeline timeRange={model.range} className="min-w-[62rem]" aria-label="Run trace waterfall">
          <div className="sticky top-0 z-10 grid h-9 grid-cols-[minmax(17rem,21rem)_minmax(34rem,1fr)_5.5rem] items-end border-b border-border/70 bg-card/95 text-[9px] text-muted-foreground backdrop-blur">
            <span className="px-3 pb-2 uppercase tracking-[0.12em]">Span</span>
            <div className="relative h-full border-x border-border/45">
              {Array.from({ length: TICK_COUNT }, (_, index) => {
                const ratio = index / (TICK_COUNT - 1);
                return (
                  <span key={ratio} className="absolute inset-y-0 border-l border-border/50" style={{ left: `${ratio * 100}%` }}>
                    <span className="absolute bottom-1.5 left-1 font-mono tabular-nums">{formatDuration(duration * ratio)}</span>
                  </span>
                );
              })}
            </div>
            <span className="px-3 pb-2 text-right uppercase tracking-[0.12em]">Duration</span>
          </div>

          <SpanPrimitive.Children>
            {({ span }) => {
              const agentId = model.agentBySpan.get(span.id);
              return (
                <SpanPrimitive.Root
                  className={`group/trace grid min-h-10 grid-cols-[minmax(17rem,21rem)_minmax(34rem,1fr)_5.5rem] items-stretch border-b border-border/35 last:border-b-0 ${agentId ? "cursor-pointer hover:bg-muted/35" : ""}`}
                  onClick={() => agentId && onSelectAgent(agentId)}
                >
                  <SpanPrimitive.Indent baseIndent={10} indentPerLevel={15} className="flex min-w-0 items-center gap-1.5 px-2 py-2">
                    {span.hasChildren ? (
                      <SpanPrimitive.CollapseToggle
                        className="grid size-4 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground transition-transform hover:bg-muted data-[collapsed=false]:rotate-90"
                        onClick={(event) => event.stopPropagation()}
                        aria-label={span.isCollapsed ? "Expand span" : "Collapse span"}
                      >
                        <CaretRight className="size-3" />
                      </SpanPrimitive.CollapseToggle>
                    ) : (
                      <span className="size-4 shrink-0" />
                    )}
                    <SpanPrimitive.StatusIndicator className="size-1.5 shrink-0 rounded-full bg-warning data-[span-status=completed]:bg-success data-[span-status=failed]:bg-destructive data-[span-status=running]:bg-info" />
                    <SpanPrimitive.Name className="min-w-0 flex-1 truncate text-[11px] text-foreground/90" />
                    <SpanPrimitive.TypeBadge className="max-w-24 shrink-0 truncate rounded bg-muted/65 px-1.5 py-0.5 font-mono text-[8px] text-muted-foreground" />
                  </SpanPrimitive.Indent>

                  <div className="relative min-h-10 overflow-hidden border-x border-border/45">
                    <TimelineGrid />
                    <SpanPrimitive.TimelineBar
                      timeRange={model.range}
                      className="top-1/2 h-2.5 -translate-y-1/2 rounded-[3px] bg-warning/75 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-warning)_45%,transparent)] [--span-timeline-min-width:4px] data-[span-status=completed]:bg-success/75 data-[span-status=failed]:bg-destructive/80 data-[span-status=running]:bg-info/80"
                    />
                  </div>

                  <span className="self-center px-3 text-right font-mono text-[9px] tabular-nums text-muted-foreground">
                    {formatDuration(span.latencyMs ?? Math.max(0, model.range.max - span.startedAt))}
                  </span>
                </SpanPrimitive.Root>
              );
            }}
          </SpanPrimitive.Children>
        </SpanPrimitive.Timeline>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[9px] text-muted-foreground">
        <Legend color="bg-info" label="Running" />
        <Legend color="bg-success" label="Completed" />
        <Legend color="bg-destructive" label="Failed" />
        <Legend color="bg-warning" label="Waiting or cancelled" />
        <span className="ml-auto">Scroll horizontally for long traces</span>
      </div>
    </AuiProvider>
  );
}

function TimelineGrid() {
  return (
    <span className="pointer-events-none absolute inset-0">
      {Array.from({ length: TICK_COUNT }, (_, index) => (
        <span key={index} className="absolute inset-y-0 border-l border-border/35" style={{ left: `${(index / (TICK_COUNT - 1)) * 100}%` }} />
      ))}
    </span>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-1.5"><span className={`size-1.5 rounded-full ${color}`} />{label}</span>;
}

/**
 * Build absolute span timestamps from durable runtime facts. `observedAt` only
 * extends the visible range for a live run; it must never become a historical
 * span's start or end timestamp. That keeps settled spans stable across React
 * rerenders, SSE snapshots, and full page refreshes.
 */
export function buildTraceModel(snapshot: RunSnapshot, observedAt = Date.now()): TraceModel {
  if (snapshot.agents.length === 0) {
    return { spans: [], agentBySpan: new Map(), range: { min: 0, max: 100 } };
  }

  const traceEvents = [...(snapshot.traceEvents ?? [])].sort((a, b) => a.cursor - b.cursor);
  const idleBoundaries = new Map(
    snapshot.agents.flatMap((agent) => {
      const boundary = idleBoundaryForAgent(agent, traceEvents);
      return boundary === null ? [] : [[agent.id, boundary] as const];
    }),
  );
  const allTimes = [
    ...snapshot.agents.flatMap((agent) => [
      toTime(agent.startedAt),
      toTime(agent.finishedAt),
      idleBoundaries.get(agent.id) ?? toTime(agent.updatedAt),
    ]),
    ...traceEvents.filter((event) => event.type.startsWith("driver.")).flatMap(eventTimes),
  ].filter((value): value is number => value !== null);
  const hasObservedTime = allTimes.length > 0;
  const startedAt = hasObservedTime ? Math.min(...allTimes) : 0;
  const active = snapshot.agents.some((agent) => !isSettledAgent(agent.state, agent.nativeStatus));
  const observedEnd = hasObservedTime ? Math.max(...allTimes) : startedAt;
  const liveEnd = active && hasObservedTime && Number.isFinite(observedAt)
    ? Math.max(observedEnd, observedAt)
    : observedEnd;
  const max = Math.max(startedAt + 100, liveEnd);
  const range = { min: startedAt, max };
  const rootId = `run:${snapshot.runId}`;
  const agentIds = new Set(snapshot.agents.map((agent) => agent.id));
  const agentBySpan = new Map<string, string>();
  const spans: SpanData[] = [runSpan(snapshot, rootId, range)];

  for (const agent of snapshot.agents) {
    spans.push(agentSpan(agent, rootId, agentIds, range, idleBoundaries.get(agent.id) ?? null));
    agentBySpan.set(agent.id, agent.id);
  }

  const toolSpans = toolSpansForEvents(traceEvents, snapshot.agents, rootId, range);
  spans.push(...toolSpans.spans);
  for (const [spanId, agentId] of toolSpans.agentBySpan) agentBySpan.set(spanId, agentId);
  return { spans, agentBySpan, range };
}

function eventTimes(event: EventEnvelope): Array<number | null> {
  if (!event.type.startsWith("driver.tool.")) return [toTime(event.occurredAt)];
  return [toTime(event.occurredAt), toolTime(event, "start"), toolTime(event, "end")];
}

function runSpan(snapshot: RunSnapshot, id: string, range: { min: number; max: number }): SpanData {
  const status = runStatus(snapshot);
  const endedAt = status === "running" ? null : range.max;
  return { id, parentSpanId: null, name: snapshot.mission.statement, type: "run", status, startedAt: range.min, endedAt, latencyMs: endedAt === null ? null : endedAt - range.min };
}

function agentSpan(
  agent: Agent,
  rootId: string,
  agentIds: ReadonlySet<string>,
  range: { min: number; max: number },
  idleBoundary: number | null,
): SpanData {
  const startedAt = toTime(agent.startedAt) ?? toTime(agent.updatedAt) ?? range.min;
  const status = agentStatus(agent);
  const endedAt = status === "running"
    ? null
    : (toTime(agent.finishedAt) ?? idleBoundary ?? toTime(agent.updatedAt) ?? range.max);
  return {
    id: agent.id,
    parentSpanId: agent.parentId && agentIds.has(agent.parentId) ? agent.parentId : rootId,
    name: agent.objective,
    type: agent.harness,
    status,
    startedAt,
    endedAt,
    latencyMs: endedAt === null ? null : Math.max(0, endedAt - startedAt),
  };
}

/**
 * An idle native session is reusable, but it is not still executing. Its first
 * durable recovery into idle is the best available boundary when the harness
 * did not emit a terminal timestamp while the daemon was away. Later daemon
 * restarts must not make the historical span grow again.
 */
function idleBoundaryForAgent(agent: Agent, events: EventEnvelope[]): number | null {
  if (agent.nativeStatus !== "idle") return null;
  let explicitBoundary: number | null = null;
  let legacyActiveBoundary: number | null = null;
  let legacyIdleBoundary: number | null = null;
  for (const event of events) {
    if (event.agentId !== agent.id || event.type !== "agent.recovered") continue;
    const occurredAt = toTime(event.occurredAt);
    if (occurredAt === null) continue;
    if (payloadHasIdleState(event.payload)) {
      if (explicitBoundary === null || occurredAt < explicitBoundary) explicitBoundary = occurredAt;
      continue;
    }
    const previousStatus = payloadString(event.payload, "previousStatus");
    if (previousStatus === "running" || previousStatus === "starting") {
      if (legacyActiveBoundary === null || occurredAt < legacyActiveBoundary) legacyActiveBoundary = occurredAt;
    } else if (previousStatus === "idle") {
      if (legacyIdleBoundary === null || occurredAt < legacyIdleBoundary) legacyIdleBoundary = occurredAt;
    }
  }
  return explicitBoundary ?? legacyActiveBoundary ?? legacyIdleBoundary;
}

function payloadHasIdleState(payload: JsonValue): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, JsonValue>;
  return record.resumedState === "idle" || record.recoveredStatus === "idle";
}

function payloadString(payload: JsonValue, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, JsonValue>)[key];
  return typeof value === "string" ? value : null;
}

function toolSpansForEvents(events: EventEnvelope[], agents: Agent[], rootId: string, range: { min: number; max: number }): { spans: SpanData[]; agentBySpan: Map<string, string> } {
  type ToolAccumulator = {
    key: string;
    agentId: string | null;
    name: string;
    firstCursor: number;
    startedAt: number;
    endedAt: number | null;
    status: SpanData["status"];
  };
  const accumulated = new Map<string, ToolAccumulator>();
  const spans: SpanData[] = [];
  const agentBySpan = new Map<string, string>();
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

  for (const event of events) {
    if (!event.type.startsWith("driver.tool.")) continue;
    const key = toolKey(event);
    const eventAt = toTime(event.occurredAt) ?? range.min;
    const nativeStart = toolTime(event, "start");
    const nativeEnd = toolTime(event, "end");
    const state = toolLifecycleStatus(event);
    const previous = accumulated.get(key);
    const startedAt = Math.min(previous?.startedAt ?? Number.POSITIVE_INFINITY, nativeStart ?? eventAt);
    const terminal = isTerminalToolEvent(event.type) || state === "completed" || state === "failed";
    const failed = event.type === "driver.tool.failed" || state === "failed" || toolFailed(event);
    const cancelled = event.type === "driver.tool.cancelled";
    accumulated.set(key, {
      key,
      agentId: event.agentId ?? previous?.agentId ?? null,
      name: toolName(event) === "Native tool" ? previous?.name ?? "Native tool" : toolName(event),
      firstCursor: previous?.firstCursor ?? event.cursor,
      startedAt: Number.isFinite(startedAt) ? startedAt : eventAt,
      endedAt: terminal ? Math.max(startedAt, nativeEnd ?? eventAt) : previous?.endedAt ?? null,
      status: failed
        ? "failed"
        : cancelled
          ? "skipped"
        : terminal
          ? "completed"
          : "running",
    });
  }

  for (const tool of [...accumulated.values()].sort((left, right) => left.startedAt - right.startedAt).slice(-120)) {
    const agent = tool.agentId ? agentsById.get(tool.agentId) : undefined;
    const terminalStatus = tool.status === "running" && agent && isSettledAgent(agent.state, agent.nativeStatus)
      ? agent?.state === "failed" ? "failed" : "skipped"
      : tool.status;
    const endedAt = terminalStatus === "running"
      ? null
      : tool.endedAt ?? toTime(agent?.finishedAt) ?? toTime(agent?.updatedAt) ?? tool.startedAt;
    const id = `tool:${tool.firstCursor}:${tool.key}`;
    spans.push({
      id,
      parentSpanId: tool.agentId && agentsById.has(tool.agentId) ? tool.agentId : rootId,
      name: tool.name,
      type: "tool",
      status: terminalStatus,
      startedAt: tool.startedAt,
      endedAt,
      latencyMs: endedAt === null ? null : Math.max(0, endedAt - tool.startedAt),
    });
    if (tool.agentId) agentBySpan.set(id, tool.agentId);
  }
  return { spans, agentBySpan };
}

function isTerminalToolEvent(type: string): boolean {
  return type === "driver.tool.completed"
    || type === "driver.tool.failed"
    || type === "driver.tool.cancelled";
}

function toolKey(event: EventEnvelope): string {
  const records = toolRecords(event.payload);
  return `${event.agentId ?? "run"}:${recordString(records, ["toolCallId", "tool_call_id", "callID", "callId", "call_id", "itemId", "id"]) ?? event.provenance?.nativeEventId ?? event.cursor}`;
}

function toolName(event: EventEnvelope): string {
  const raw = recordString(toolRecords(event.payload), ["toolName", "tool_name", "name", "tool"]);
  if (!raw) return "Native tool";
  return raw
    .replace(/^mcp[_\s-]*symphony[_\s-]*/iu, "")
    .replace(/^symphony[_\s-]*/iu, "")
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function toolFailed(event: EventEnvelope): boolean {
  const records = toolRecords(event.payload);
  const status = recordString(records, ["status"])?.toLowerCase();
  return status === "failed" || status === "error" || records.some((record) => record.error !== undefined && record.error !== null);
}

function toolLifecycleStatus(event: EventEnvelope): "running" | "completed" | "failed" {
  const status = recordString(toolRecords(event.payload), ["status"])?.toLowerCase();
  if (status === "failed" || status === "error" || status === "cancelled") return "failed";
  if (status === "completed" || status === "complete" || status === "success" || status === "succeeded") return "completed";
  return "running";
}

function toolTime(event: EventEnvelope, boundary: "start" | "end"): number | null {
  const keys = boundary === "start" ? ["start", "startedAt", "startTime"] : ["end", "endedAt", "endTime"];
  for (const record of toolRecords(event.payload)) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1_000 : value;
      if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return null;
}

function toolRecords(payload: JsonValue): Record<string, JsonValue>[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const root = payload as Record<string, JsonValue>;
  const records = [root];
  for (const key of ["state", "time", "item", "part", "data", "update"]) {
    const direct = root[key];
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      const nested = direct as Record<string, JsonValue>;
      records.push(nested);
      const time = nested.time;
      if (time && typeof time === "object" && !Array.isArray(time)) records.push(time as Record<string, JsonValue>);
    }
  }
  return records;
}

function recordString(records: Record<string, JsonValue>[], keys: string[]): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}

function agentStatus(agent: Agent): SpanData["status"] {
  if (agent.state === "failed") return "failed";
  if (agent.state === "succeeded") return "completed";
  if (!isSettledAgent(agent.state, agent.nativeStatus)) return "running";
  return "skipped";
}

function runStatus(snapshot: RunSnapshot): SpanData["status"] {
  if (snapshot.agents.some((agent) => !isSettledAgent(agent.state, agent.nativeStatus))) return "running";
  if (snapshot.agents.some((agent) => agent.state === "failed")) return "failed";
  const reusableChat = snapshot.runId.startsWith("chat-run:") || snapshot.workflowId?.startsWith("chat:") === true;
  if (!reusableChat && snapshot.runStatus === "failed") return "failed";
  if (!reusableChat && snapshot.runStatus === "cancelled") return "skipped";
  return "completed";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function toTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
