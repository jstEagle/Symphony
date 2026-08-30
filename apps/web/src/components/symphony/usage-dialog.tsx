"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSymphony } from "@/components/symphony/context";
import { fetchUsageHeatmap } from "@/lib/symphony/runtime-client";
import type { UsageHeatmap as UsageHeatmapData, UsageHeatmapDay } from "@/lib/symphony/contracts";
import { costLabel, formatCost } from "@/lib/symphony/format";
import { useQuery } from "@tanstack/react-query";
import { AgentLoader } from "@/components/symphony/agent-tool";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const dayFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function UsageDialog() {
  const { usageOpen, setUsageOpen, envelope } = useSymphony();
  const cost = envelope.costs;
  const entries = Object.entries(cost.byBasis ?? {});
  const heatmapQuery = useQuery({
    queryKey: ["symphony", "usage-heatmap", 12],
    queryFn: ({ signal }) => fetchUsageHeatmap(12, signal),
    enabled: usageOpen && envelope.mode === "runtime",
    refetchInterval: usageOpen ? 5_000 : false,
    refetchOnWindowFocus: true,
  });

  return (
    <Dialog open={usageOpen} onOpenChange={setUsageOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Usage</DialogTitle>
        </DialogHeader>
        <div className="rounded-2xl bg-muted/40 p-4">
          <p className="font-display text-3xl tabular-nums tracking-tight">{formatCost(cost.knownTotal ?? cost.amount, cost.currency)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{costLabel(cost)}</p>
        </div>
        <section className="space-y-2" aria-labelledby="usage-heatmap-title">
          <div className="flex items-center justify-between gap-3">
            <h3 id="usage-heatmap-title" className="text-xs font-medium">Last 12 weeks</h3>
            <span className="text-[10px] text-muted-foreground">Refreshes every 5s</span>
          </div>
          {heatmapQuery.data ? (
            <UsageHeatmap data={heatmapQuery.data} />
          ) : envelope.mode === "preview" ? (
            <p className="rounded-xl bg-muted/30 px-3 py-4 text-[11px] text-muted-foreground">
              Usage history is available when the local daemon is connected.
            </p>
          ) : heatmapQuery.isError ? (
            <p className="rounded-xl bg-muted/30 px-3 py-4 text-[11px] text-muted-foreground">
              Usage history is temporarily unavailable.
            </p>
          ) : (
            <div className="grid h-24 place-items-center rounded-xl bg-muted/40 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <AgentLoader kind="circular" size={16} label="Loading usage history" />
                <span>Loading usage history…</span>
              </div>
            </div>
          )}
        </section>
        <ul className="space-y-2 text-xs">
          {entries.map(([basis, amount]) => (
            <li key={basis} className="flex items-center justify-between rounded-xl bg-muted/30 px-3 py-2">
              <span className="capitalize text-muted-foreground">{basis.replaceAll("-", " ")}</span>
              <span className="tabular-nums">{formatCost(amount, cost.currency)}</span>
            </li>
          ))}
          <li className="flex items-center justify-between px-3 py-1 text-muted-foreground">
            <span>Unknown events</span>
            <span className="tabular-nums">{cost.unknownEvents ?? 0}</span>
          </li>
          <li className="flex items-center justify-between px-3 py-1 text-muted-foreground">
            <span>Recorded events</span>
            <span className="tabular-nums">{cost.eventCount ?? 0}</span>
          </li>
        </ul>
        {envelope.mode === "preview" && (
          <p className="text-[11px] text-muted-foreground">Preview totals are labelled estimates from the sample projection.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UsageHeatmap({ data }: { data: UsageHeatmapData }) {
  const activeDays = data.days.filter((day) => !day.future && day.eventCount > 0);
  const maxCost = Math.max(0, ...activeDays.map((day) => day.knownCost));
  return (
    <div className="rounded-xl bg-muted/25 p-3">
      <div className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-2">
        <div className="grid grid-rows-7 gap-1 text-[8px] leading-none text-muted-foreground" aria-hidden>
          {WEEKDAYS.map((label, index) => <span key={`${label}-${index}`} className="grid place-items-center">{index % 2 === 1 ? label : ""}</span>)}
        </div>
        <div
          className="grid grid-flow-col grid-rows-7 gap-1"
          style={{ gridTemplateColumns: `repeat(${data.weeks}, minmax(0, 1fr))` }}
          role="img"
          aria-label={`Daily Symphony usage from ${readableDate(data.startDate)} to ${readableDate(data.endDate)}`}
        >
          {data.days.map((day) => (
            <span
              key={day.date}
              className="aspect-square min-w-0 rounded-[2px] ring-1 ring-foreground/5"
              style={{ backgroundColor: heatColor(day, maxCost), opacity: day.future ? 0.28 : 1 }}
              title={dayLabel(day, data.currency)}
              aria-label={dayLabel(day, data.currency)}
            />
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-[9px] text-muted-foreground">
        <span>{readableDate(data.startDate)}</span>
        <span className="flex items-center gap-1" aria-hidden>
          Less
          {[0, 0.2, 0.45, 0.7, 1].map((intensity) => (
            <span
              key={intensity}
              className="size-2.5 rounded-[2px] ring-1 ring-foreground/5"
              style={{ backgroundColor: intensity === 0 ? "var(--muted)" : `color-mix(in oklab, var(--usage-heat) ${Math.round(20 + intensity * 80)}%, var(--muted))` }}
            />
          ))}
          More
        </span>
        <span>{readableDate(data.endDate)}</span>
      </div>
    </div>
  );
}

function heatColor(day: UsageHeatmapDay, maxCost: number): string {
  if (day.future || day.eventCount === 0) return "var(--muted)";
  if (day.knownCost === 0 && day.unknownEvents > 0) {
    return "color-mix(in oklab, var(--warning) 45%, var(--muted))";
  }
  const intensity = maxCost > 0 ? Math.log1p(day.knownCost) / Math.log1p(maxCost) : 0.2;
  return `color-mix(in oklab, var(--usage-heat) ${Math.round(20 + intensity * 80)}%, var(--muted))`;
}

function dayLabel(day: UsageHeatmapDay, currency: string): string {
  if (day.future) return `${readableDate(day.date)}: future`;
  if (day.eventCount === 0) return `${readableDate(day.date)}: no recorded usage`;
  const unknown = day.unknownEvents ? `, ${day.unknownEvents} unknown-cost event${day.unknownEvents === 1 ? "" : "s"}` : "";
  return `${readableDate(day.date)}: ${formatCost(day.knownCost, currency)}, ${day.eventCount} event${day.eventCount === 1 ? "" : "s"}${unknown}`;
}

function readableDate(date: string): string {
  return dayFormatter.format(new Date(`${date}T12:00:00`));
}
