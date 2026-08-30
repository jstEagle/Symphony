import type {
  AgentAccess,
  AgentState,
  CostSummary,
  HarnessId,
  LoaderKind,
  NativeAgentStatus,
} from "./contracts";

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const delta = Math.max(0, now - then);
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatElapsed(startedAt: string | null | undefined, finishedAt?: string | null): string {
  if (!startedAt) return "—";
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "—";
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  }
  return `${String(minutes).padStart(2, "0")}m ${String(remain).padStart(2, "0")}s`;
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatCost(amount: number, currency = "USD"): string {
  const fractionDigits = amount > 0 && amount < 0.01 ? 4 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

export function costLabel(cost: CostSummary): string {
  const amount = formatCost(cost.knownTotal ?? cost.amount, cost.currency);
  if (cost.provenance === "unavailable") return "Cost unavailable";
  if (cost.provenance === "pending") return `${amount} pending`;
  if ((cost.unknownEvents ?? 0) > 0) return `${amount} · ${cost.unknownEvents} unknown`;
  return `${amount} ${cost.provenance}`;
}

export function compactAgentState(status: NativeAgentStatus): AgentState {
  switch (status) {
    case "queued":
    case "routing":
    case "starting":
      return "queued";
    case "running":
      return "running";
    case "idle":
    case "waiting":
      return "waiting";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancel-requested":
      return "blocked";
    case "cancelled":
      return "cancelled";
    case "interrupted":
    case "lost":
      return "failed";
  }
}

export function statusLabel(state: AgentState, native?: NativeAgentStatus): string {
  if (native === "idle") return "idle";
  if (native === "cancel-requested") return "cancel requested";
  if (native === "interrupted") return "interrupted";
  if (native === "lost") return "lost";
  if (native === "routing") return "routing";
  if (native === "starting") return "starting";
  return state.replace("-", " ");
}

export function accessLabel(access: AgentAccess): string {
  return access === "read-only" ? "Read-only" : "Full access";
}

export function loaderForHarness(harness: string): LoaderKind {
  const value = harness.toLowerCase();
  if (value.includes("claude")) return "triangle";
  if (value.includes("pi") || value.includes("cursor")) return "circular";
  return "square";
}

export function harnessTitle(harness: string): string {
  const map: Record<string, string> = {
    auto: "Auto",
    codex: "Codex",
    claude: "Claude Code",
    cursor: "Cursor",
    opencode: "OpenCode",
    pi: "Pi",
    acp: "ACP",
  };
  return map[harness.toLowerCase()] ?? harness;
}

export function isLiveAgentState(state: AgentState): boolean {
  return state === "running" || state === "queued" || state === "waiting";
}

/**
 * A native session may remain available in `waiting` while no work is running.
 * Keep that resumable state distinct from visual activity so idle conductors do
 * not animate forever or make a settled run look live.
 */
export function isActivelyWorkingAgent(state: AgentState): boolean {
  return state === "running" || state === "queued";
}

/**
 * Settlement is an authority/lifecycle question, not an animation question.
 * A native agent in `waiting` has durable work queued and must remain open in
 * progress and trace projections even though its loader is intentionally still.
 * `idle` is different: the retained native session is reusable, but its current
 * turn has no outstanding work and may be bounded as settled.
 */
export function isSettledAgent(state: AgentState, nativeStatus?: NativeAgentStatus): boolean {
  if (nativeStatus === "idle") return true;
  if (nativeStatus === "waiting"
    || nativeStatus === "queued"
    || nativeStatus === "routing"
    || nativeStatus === "starting"
    || nativeStatus === "running"
    || nativeStatus === "cancel-requested") return false;
  if (nativeStatus === "completed"
    || nativeStatus === "failed"
    || nativeStatus === "cancelled"
    || nativeStatus === "interrupted"
    || nativeStatus === "lost") return true;
  return state === "succeeded" || state === "failed" || state === "cancelled" || state === "stale";
}

export function agentDisplayName(objective: string, depth: number): string {
  if (depth === 0) return "Conductor";
  const first = objective.split(/[.!?]/u)[0]?.trim() ?? objective;
  if (first.length <= 28) return first;
  return `${first.slice(0, 27).trimEnd()}…`;
}

export function parseHarness(value: string | null | undefined): HarnessId {
  const allowed: HarnessId[] = ["auto", "codex", "claude", "cursor", "opencode", "pi", "acp"];
  return allowed.includes(value as HarnessId) ? (value as HarnessId) : "auto";
}
