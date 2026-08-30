"use client";

import { ArrowClockwise } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentLoader } from "@/components/symphony/agent-tool";
import type { AgentDetail, AgentLogEntry, AgentSessionLog } from "@/lib/symphony/contracts";
import { isActivelyWorkingAgent } from "@/lib/symphony/format";
import { cn } from "@/lib/utils";

export function AgentSessionLog({
  detail,
  loadLogs,
}: {
  detail: AgentDetail;
  loadLogs: (agentId: string, after?: number) => Promise<AgentSessionLog>;
}) {
  const [session, setSession] = useState<AgentSessionLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const cursor = useRef(0);
  const inFlight = useRef(false);
  const active = isActivelyWorkingAgent(detail.state);

  const refresh = useCallback(async (reset = false, showProgress = true) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (showProgress) setRefreshing(true);
    try {
      const after = reset ? 0 : cursor.current;
      const next = await loadLogs(detail.id, after);
      cursor.current = next.cursor;
      setSession((current) => {
        if (reset || !current) return next;
        const seen = new Set(current.entries.map((entry) => entry.cursor));
        const additions = next.entries.filter((entry) => !seen.has(entry.cursor));
        if (additions.length === 0 && current.cursor === next.cursor) return current;
        return {
          ...next,
          entries: [...current.entries, ...additions].slice(-1_000),
        };
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Session logs could not be loaded.");
    } finally {
      inFlight.current = false;
      if (showProgress) setRefreshing(false);
    }
  }, [detail.id, loadLogs]);

  useEffect(() => {
    cursor.current = 0;
    setSession(null);
    setError(null);
    void refresh(true);
  }, [detail.id, refresh]);

  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => void refresh(false, false), 1_500);
    return () => window.clearInterval(interval);
  }, [active, refresh]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background/35 font-mono">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/55 bg-background/45 px-3 py-2 backdrop-blur-xl">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[9px] text-foreground/80">
            {session?.agent.nativeSessionId ?? detail.nativeSessionId ?? "Native session pending"}
          </p>
          <p className="mt-0.5 truncate text-[8px] text-muted-foreground">
            {detail.workspacePath ?? "No workspace"}
          </p>
        </div>
        <span className="text-[8px] tabular-nums text-muted-foreground">cursor {session?.cursor ?? 0}</span>
        <button
          type="button"
          onClick={() => void refresh(true)}
          className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Refresh session logs"
          title="Refresh session logs"
        >
          {refreshing ? <AgentLoader kind="circular" size={12} label="Refreshing session logs" /> : <ArrowClockwise className="size-3.5" />}
        </button>
      </div>

      {error ? <p className="border-b border-destructive/20 bg-destructive/8 px-3 py-2 text-[9px] text-destructive">{error}</p> : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {!session && !error ? (
          <div className="grid min-h-40 place-items-center text-[9px] text-muted-foreground">
            <span className="flex items-center gap-2"><AgentLoader kind="circular" size={14} label="Loading session logs" />Loading durable events…</span>
          </div>
        ) : session?.entries.length ? (
          <ol className="space-y-0.5">
            {session.entries.map((entry) => <LogRow key={entry.cursor} entry={entry} />)}
          </ol>
        ) : (
          <div className="grid min-h-40 place-items-center text-[9px] text-muted-foreground">No events recorded for this session.</div>
        )}
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: AgentLogEntry }) {
  return (
    <li className="group/log rounded-md px-2 py-1.5 [contain-intrinsic-size:auto_48px] [content-visibility:auto] hover:bg-muted/40">
      <div className="grid grid-cols-[4.5rem_2.6rem_minmax(0,1fr)] items-start gap-2 text-[8.5px] leading-4">
        <time className="tabular-nums text-muted-foreground/65" dateTime={entry.at}>{formatLogTime(entry.at)}</time>
        <span className={cn("uppercase tracking-[0.08em]", levelColor(entry.level))}>{entry.level}</span>
        <div className="min-w-0">
          <p className="break-words text-foreground/85">{entry.message}</p>
          <p className="truncate text-[7.5px] text-muted-foreground/55">{entry.source} · {entry.type} · #{entry.cursor}</p>
        </div>
      </div>
      <details className="ml-[7.1rem] mt-1 text-[7.5px] text-muted-foreground/65">
        <summary className="w-fit cursor-pointer select-none hover:text-foreground">event data</summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2 leading-3">{JSON.stringify(entry.data, null, 2)}</pre>
      </details>
    </li>
  );
}

function levelColor(level: AgentLogEntry["level"]): string {
  if (level === "error") return "text-destructive";
  if (level === "warn") return "text-warning";
  if (level === "info") return "text-info";
  return "text-muted-foreground/55";
}

function formatLogTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
