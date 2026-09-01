"use client";

import {
  ArrowBendUpLeft,
  ArrowSquareOut,
  Check,
  CircleNotch,
  Envelope,
  GitBranch,
  PaperPlaneTilt,
  Prohibit,
  WarningCircle,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { useSymphony } from "@/components/symphony/context";
import {
  cancelAgentMessage,
  fetchAgentMessageProjection,
  markAgentMessageHandled,
  newIdempotencyKey,
  replyToAgentMessage,
  isRetryableRuntimeRequestError,
  RuntimeRequestError,
  type AgentMessageProjection as AgentMessageItem,
} from "@/lib/symphony/runtime-client";
import {
  createPendingAgentMessageAction,
  readPendingAgentMessageActions,
  updatePendingAgentMessageAction,
  writePendingAgentMessageActions,
  type AgentMessageAction,
  type PendingAgentMessageAction,
} from "@/lib/symphony/agent-message-outbox";
import { cn } from "@/lib/utils";

type MessageView = "inbox" | "outbox";

/**
 * Live durable agent-message projection for the Control Room. The daemon
 * supplies both message identity and receipt history; this component only
 * groups and renders that authoritative snapshot.
 */
export function AgentMessageProjection({ onOpenAgent }: { onOpenAgent?: (agentId: string) => void }) {
  const symphony = useSymphony();
  const queryClient = useQueryClient();
  const [view, setView] = useState<MessageView>("inbox");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<PendingAgentMessageAction[]>(() => readPendingAgentMessageActions());
  const [, setInFlightVersion] = useState(0);
  const inFlight = useRef(new Set<string>());
  const runtime = symphony.mode === "runtime" && symphony.envelope.mode === "runtime";
  const projectionQuery = useQuery({
    queryKey: ["symphony", "agent-messages"],
    enabled: runtime,
    queryFn: ({ signal }) => fetchAgentMessageProjection(signal),
    retry: false,
    staleTime: 2_000,
    refetchInterval: runtime ? 10_000 : false,
    refetchOnWindowFocus: true,
  });
  const items = useMemo(
    () => [...(projectionQuery.data?.[view] ?? [])].sort((left, right) => right.message.createdAt.localeCompare(left.message.createdAt)),
    [projectionQuery.data, view],
  );
  const agentIds = useMemo(() => new Set(symphony.snapshot.agents.map((agent) => agent.id)), [symphony.snapshot.agents]);
  const grouped = useMemo(() => groupByCorrelation(items), [items]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["symphony", "agent-messages"] });
  }, [queryClient]);
  const updatePending = useCallback((update: (actions: PendingAgentMessageAction[]) => PendingAgentMessageAction[]) => {
    setPendingActions((current) => {
      const next = update(current);
      writePendingAgentMessageActions(next);
      return next;
    });
  }, []);
  const runAction = useCallback(async (item: AgentMessageItem, action: AgentMessageAction, payload: Readonly<Record<string, import("@/lib/symphony/contracts").JsonValue>>, operation: (requestKey: string) => Promise<unknown>) => {
    const existing = pendingActions.find((candidate) => candidate.id === `${action}:${item.message.id}`);
    const pending = existing ?? createPendingAgentMessageAction({ messageId: item.message.id, action, requestKey: newIdempotencyKey(), payload });
    if (inFlight.current.has(pending.id)) return;
    if (!existing) updatePending((current) => [...current, pending]);
    inFlight.current.add(pending.id);
    setInFlightVersion((version) => version + 1);
    setActionError(null);
    try {
      const result = await operation(pending.requestKey);
      // A conflict is a known daemon decision, not an uncertain transport
      // outcome. Clear the local outbox entry and surface the reason instead
      // of parking a permanently rejected action in the unknown-retry queue.
      if (isConflictResult(result)) {
        updatePending((current) => current.filter((candidate) => candidate.id !== pending.id));
        setActionError(`Request rejected: ${conflictReason(result)}`);
        await refresh();
        return;
      }
      updatePending((current) => current.filter((candidate) => candidate.id !== pending.id));
      await refresh();
    } catch (error) {
      if (isOutcomeUnknown(error)) {
        const detail = error instanceof Error ? error.message : String(error);
        updatePending((current) => current.map((candidate) => candidate.id === pending.id ? updatePendingAgentMessageAction(candidate, { state: "unknown", error: detail }) : candidate));
        setActionError(`Outcome unknown for ${action}. Retry with the same request key, or abandon it.`);
      } else {
        updatePending((current) => current.filter((candidate) => candidate.id !== pending.id));
        setActionError(`Request rejected: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      inFlight.current.delete(pending.id);
      setInFlightVersion((version) => version + 1);
    }
  }, [pendingActions, refresh, updatePending]);
  const allItems = useMemo(() => [...(projectionQuery.data?.inbox ?? []), ...(projectionQuery.data?.outbox ?? [])], [projectionQuery.data]);
  const retryAction = useCallback((action: PendingAgentMessageAction) => {
    const item = allItems.find((candidate) => candidate.message.id === action.messageId);
    if (!item) {
      setActionError("This message is no longer in the authoritative projection. Refresh before retrying.");
      return;
    }
    const operation = action.action === "reply"
      ? (requestKey: string) => replyToAgentMessage(item.message.id, { summary: String(action.payload.summary ?? "") }, requestKey)
      : action.action === "handled"
        ? (requestKey: string) => markAgentMessageHandled(item.message.id, String(action.payload.decision ?? "acknowledged") as "acknowledged" | "accepted" | "rejected" | "deferred" | "cancelled", requestKey)
        : (requestKey: string) => cancelAgentMessage(item.message.id, requestKey);
    void runAction(item, action.action, action.payload, operation);
  }, [allItems, runAction]);
  const abandonAction = useCallback((id: string) => updatePending((current) => current.filter((candidate) => candidate.id !== id)), [updatePending]);

  if (!runtime) {
    return <MessageState title="Agent messaging unavailable" detail="Connect to a live Symphony daemon to inspect durable messages." />;
  }
  if (projectionQuery.isPending) {
    return <MessageState title="Loading agent messages" detail="Reading the daemon's durable message projection." loading={symphony.connection === "live"} />;
  }
  if (projectionQuery.isError) {
    return <MessageState title="Agent messages unavailable" detail={projectionQuery.error instanceof Error ? projectionQuery.error.message : "The daemon message projection could not be loaded."} retryable />;
  }

  return (
    <section className="border-t border-border/45 bg-card/[0.14]" aria-labelledby="agent-message-heading">
      <div className="mx-auto w-full max-w-[108rem] px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
        <header className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <div className="mb-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground/75">
              <GitBranch className="size-3.5 text-info" aria-hidden="true" />
              Agent message bus
              <span className="inline-flex items-center gap-1 normal-case tracking-normal text-success" aria-label="Live projection">
                <span className="size-1.5 rounded-full bg-success" aria-hidden="true" /> live
              </span>
            </div>
            <h2 id="agent-message-heading" className="text-[clamp(1.1rem,2vw,1.55rem)] font-medium tracking-[-0.035em]">Inbox and outbox</h2>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">Typed findings, questions, handoffs, and decisions with durable delivery evidence.</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg bg-muted/40 p-0.5" role="tablist" aria-label="Agent message direction">
              {(["inbox", "outbox"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="tab"
                  aria-selected={view === candidate}
                  onClick={() => setView(candidate)}
                  className={cn("rounded-md px-2.5 py-1.5 text-[11px] capitalize transition-colors", view === candidate ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                >
                  {candidate} <span className="font-mono tabular-nums text-[10px] text-muted-foreground">{projectionQuery.data?.[candidate].length ?? 0}</span>
                </button>
              ))}
            </div>
          </div>
        </header>

        {actionError ? <div className="mb-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-[11px] text-destructive" role="alert"><WarningCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><span>{actionError}</span></div> : null}
        {items.length === 0 ? (
          <div className="rounded-xl bg-background/45 px-4 py-8 text-center text-[11px] text-muted-foreground">No durable messages in this {view}.</div>
        ) : (
          <div className="space-y-3" aria-live="polite">
            {grouped.map(([correlationId, thread]) => (
              <MessageThread
                key={correlationId}
                correlationId={correlationId}
                items={thread}
                expandedId={expandedId}
                onToggle={(id) => setExpandedId((current) => current === id ? null : id)}
                onOpenAgent={(id) => agentIds.has(id) ? onOpenAgent?.(id) : undefined}
                pendingActions={pendingActions}
                inFlight={inFlight.current}
                onReply={(item, summary) => void runAction(item, "reply", { summary }, (requestKey) => replyToAgentMessage(item.message.id, { summary }, requestKey))}
                onHandle={(item, decision) => void runAction(item, "handled", { decision }, (requestKey) => markAgentMessageHandled(item.message.id, decision, requestKey))}
                onCancel={(item) => void runAction(item, "cancel", {}, (requestKey) => cancelAgentMessage(item.message.id, requestKey))}
                onRetry={retryAction}
                onAbandon={abandonAction}
              />
            ))}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          <span>message cursor {projectionQuery.data?.messageCursor ?? 0}</span>
          <span>receipt cursor {projectionQuery.data?.receiptCursor ?? 0}</span>
          <span className="ml-auto">state comes from receipts</span>
        </div>
      </div>
    </section>
  );
}

function MessageThread({
  correlationId,
  items,
  expandedId,
  onToggle,
  onOpenAgent,
  onReply,
  onHandle,
  onCancel,
  pendingActions,
  inFlight,
  onRetry,
  onAbandon,
}: {
  correlationId: string;
  items: AgentMessageItem[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  onOpenAgent: (id: string) => void;
  onReply: (item: AgentMessageItem, summary: string) => void;
  onHandle: (item: AgentMessageItem, decision: "acknowledged" | "accepted" | "rejected" | "deferred" | "cancelled") => void;
  onCancel: (item: AgentMessageItem) => void;
  pendingActions: PendingAgentMessageAction[];
  inFlight: ReadonlySet<string>;
  onRetry: (action: PendingAgentMessageAction) => void;
  onAbandon: (id: string) => void;
}) {
  return (
    <article className="overflow-hidden rounded-xl bg-background/65 shadow-[0_14px_35px_-30px_color-mix(in_oklab,var(--foreground)_45%,transparent)]">
      <div className="flex items-center justify-between gap-3 bg-muted/30 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Envelope className="size-3.5 text-info" aria-hidden="true" />
          <span className="text-[10px] font-medium text-foreground/85">Thread</span>
          <code className="truncate font-mono text-[10px] text-muted-foreground" title={correlationId}>{shortId(correlationId)}</code>
          <span className="text-[10px] text-muted-foreground">{items.length} {items.length === 1 ? "message" : "messages"}</span>
        </div>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{formatDate(items[0]?.message.createdAt)}</span>
      </div>
      <div className="divide-y divide-border/35">
        {items.map((item) => (
          <MessageRow key={item.message.id} item={item} expanded={expandedId === item.message.id} onToggle={() => onToggle(item.message.id)} onOpenAgent={onOpenAgent} onReply={onReply} onHandle={onHandle} onCancel={onCancel} pendingAction={pendingActions.find((candidate) => candidate.messageId === item.message.id)} inFlight={inFlight} onRetry={onRetry} onAbandon={onAbandon} />
        ))}
      </div>
    </article>
  );
}

function MessageRow({ item, expanded, onToggle, onOpenAgent, onReply, onHandle, onCancel, pendingAction, inFlight, onRetry, onAbandon }: {
  item: AgentMessageItem;
  expanded: boolean;
  onToggle: () => void;
  onOpenAgent: (id: string) => void;
  onReply: (item: AgentMessageItem, summary: string) => void;
  onHandle: (item: AgentMessageItem, decision: "acknowledged" | "accepted" | "rejected" | "deferred" | "cancelled") => void;
  onCancel: (item: AgentMessageItem) => void;
  pendingAction?: PendingAgentMessageAction;
  inFlight: ReadonlySet<string>;
  onRetry: (action: PendingAgentMessageAction) => void;
  onAbandon: (id: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const message = item.message;
  const canRespond = ["pending", "delivered", "read"].includes(item.state);
  const actionInFlight = pendingAction ? inFlight.has(pendingAction.id) : false;
  const openActor = (id: string) => <button type="button" onClick={() => onOpenAgent(id)} className="font-mono text-[10px] text-info underline decoration-info/35 underline-offset-2 hover:text-foreground" title={`Open agent ${id}`}>{shortId(id)}</button>;

  return (
    <div className="px-3 py-3">
      <div className="flex items-start gap-3">
        <StatusMark state={item.state} />
        <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left" aria-expanded={expanded}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="rounded bg-muted/55 px-1.5 py-0.5 text-[10px] font-medium text-foreground/85">{message.kind}</span>
            <span className={cn("text-[10px] font-medium", stateTone(item.state))}>{item.state}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{formatDate(message.createdAt)}</span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-foreground/90">{message.summary || stringifyPayload(message.payload)}</p>
          <p className="mt-1 truncate text-[10px] text-muted-foreground">{openActor(message.senderId)} <span className="px-1 text-muted-foreground/55">→</span> {openActor(message.recipientId)}</p>
        </button>
        <button type="button" onClick={onToggle} className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground" aria-label={expanded ? "Collapse message details" : "Expand message details"}>
          <ArrowSquareOut className={cn("size-3.5 transition-transform", expanded && "rotate-90")} aria-hidden="true" />
        </button>
      </div>
      {expanded ? (
        <div className="ml-6 mt-3 space-y-3 border-l border-border/50 pl-3">
          <IdentityGrid message={message} />
          <ReceiptTrail item={item} />
          {pendingAction ? <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning/10 px-2.5 py-2 text-[10px] text-warning" role="status"><WarningCircle className="size-3.5 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1">{pendingAction.state === "unknown" ? "Outcome unknown" : "Action pending"}{pendingAction.error ? `: ${pendingAction.error}` : "."}</span><button type="button" onClick={() => onRetry(pendingAction)} disabled={actionInFlight} className="font-medium underline underline-offset-2 disabled:opacity-50">Retry</button><button type="button" onClick={() => onAbandon(pendingAction.id)} disabled={actionInFlight} className="text-muted-foreground underline underline-offset-2 disabled:opacity-50">Abandon</button></div> : null}
          <ReferenceList title="Artifacts" values={message.artifactRefs.map((reference) => reference.id)} empty="No artifact references." />
          <ReferenceList title="Evidence" values={message.evidenceRefs.map((reference) => reference.id)} empty="No evidence references." />
          {message.expiresAt ? <p className={cn("font-mono text-[10px]", new Date(message.expiresAt).getTime() <= Date.now() ? "text-warning" : "text-muted-foreground")}>Expires {formatDate(message.expiresAt)}</p> : null}
          {item.delivery?.reason ? <p className="rounded-md bg-destructive/8 px-2.5 py-2 text-[10px] leading-4 text-destructive">{item.delivery.reason}</p> : null}
          {canRespond ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <button type="button" onClick={() => onHandle(item, "acknowledged")} disabled={actionInFlight} className="inline-flex h-7 items-center gap-1 rounded-md bg-success/10 px-2 text-[10px] font-medium text-success hover:bg-success/15 disabled:opacity-50"><Check className="size-3" aria-hidden="true" /> {pendingAction?.action === "handled" && actionInFlight ? "Handling…" : "Mark handled"}</button>
              <button type="button" onClick={() => setReplying((current) => !current)} disabled={actionInFlight} className="inline-flex h-7 items-center gap-1 rounded-md bg-info/10 px-2 text-[10px] font-medium text-info hover:bg-info/15 disabled:opacity-50"><ArrowBendUpLeft className="size-3" aria-hidden="true" /> Reply</button>
              <button type="button" onClick={() => onCancel(item)} disabled={actionInFlight} className="inline-flex h-7 items-center gap-1 rounded-md bg-muted/60 px-2 text-[10px] font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"><Prohibit className="size-3" aria-hidden="true" /> {pendingAction?.action === "cancel" && actionInFlight ? "Cancelling…" : "Cancel"}</button>
            </div>
          ) : null}
          {replying ? (
            <form className="flex gap-1.5" onSubmit={(event) => { event.preventDefault(); if (!reply.trim()) return; onReply(item, reply.trim()); setReply(""); setReplying(false); }}>
              <input value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Write a semantic reply" aria-label="Reply summary" className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40" autoFocus />
              <button type="submit" className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground hover:bg-primary/85" aria-label="Send reply"><PaperPlaneTilt className="size-3.5" aria-hidden="true" /></button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function IdentityGrid({ message }: { message: AgentMessageItem["message"] }) {
  const entries = [["objective", message.objectiveId], ["run", message.runId], ["attempt", message.attemptId], ["parent", message.parentId], ["reply", message.replyToId]] as const;
  return <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">{entries.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-[9px] uppercase tracking-[0.09em] text-muted-foreground/70">{label}</dt><dd className="truncate font-mono text-[10px] text-foreground/75">{value ? shortId(value) : "—"}</dd></div>)}</dl>;
}

function ReceiptTrail({ item }: { item: AgentMessageItem }) {
  return <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">{item.receipts.length ? item.receipts.map((receipt) => <span key={receipt.id} className={stateTone(receipt.state)}>{receipt.kind}:{receipt.state}</span>) : <span>No receipts recorded.</span>}</div>;
}

function ReferenceList({ title, values, empty }: { title: string; values: string[]; empty: string }) {
  return <div><h3 className="text-[9px] uppercase tracking-[0.09em] text-muted-foreground/70">{title}</h3><p className="mt-1 font-mono text-[10px] text-foreground/70">{values.length ? values.map(shortId).join(" · ") : empty}</p></div>;
}

function StatusMark({ state }: { state: AgentMessageItem["state"] }) {
  if (state === "pending") return <CircleNotch className="mt-1 size-4 shrink-0 animate-spin text-info" aria-label="Pending" />;
  if (["failed", "unknown", "expired"].includes(state)) return <WarningCircle className={cn("mt-1 size-4 shrink-0", stateTone(state))} aria-label={state} />;
  return <Envelope className={cn("mt-1 size-4 shrink-0", stateTone(state))} aria-label={state} />;
}

function MessageState({ title, detail, loading = false, retryable = false }: { title: string; detail: string; loading?: boolean; retryable?: boolean }) {
  return <div className="border-t border-border/45 px-6 py-12 text-center" aria-live={retryable ? "assertive" : "polite"}>{loading ? <AgentLoader kind="circular" size={20} label={title} animated /> : retryable ? <WarningCircle className="mx-auto size-6 text-warning" aria-hidden="true" /> : <Envelope className="mx-auto size-6 text-muted-foreground/60" aria-hidden="true" />}<h2 className="mt-3 text-sm font-medium text-foreground/90">{title}</h2><p className="mx-auto mt-1.5 max-w-md text-[11px] leading-5 text-muted-foreground">{detail}</p></div>;
}

function groupByCorrelation(items: AgentMessageItem[]): Array<[string, AgentMessageItem[]]> {
  const groups = new Map<string, AgentMessageItem[]>();
  for (const item of items) {
    const id = item.message.correlationId ?? item.message.id;
    const group = groups.get(id) ?? [];
    group.push(item);
    groups.set(id, group);
  }
  return [...groups.entries()];
}

function stateTone(state: string): string {
  if (["handled", "delivered", "read"].includes(state)) return "text-success";
  if (["failed", "unknown"].includes(state)) return "text-destructive";
  if (["expired", "cancelled"].includes(state)) return "text-warning";
  return "text-info";
}

function shortId(value: string): string {
  return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function stringifyPayload(value: unknown): string {
  try { return typeof value === "string" ? value : JSON.stringify(value); } catch { return "Message payload unavailable."; }
}

function isOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof RuntimeRequestError)) return true;
  return isRetryableRuntimeRequestError(error);
}

function isConflictResult(value: unknown): value is { status: "conflict"; reason?: string } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { status?: unknown }).status === "conflict");
}

function conflictReason(value: { reason?: string }): string {
  return value.reason?.trim() || "The daemon rejected this action because the message state has changed.";
}
