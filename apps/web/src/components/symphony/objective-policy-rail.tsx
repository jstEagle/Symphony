"use client";

import { CaretDown, Clock, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { AgentLoader } from "@/components/symphony/agent-tool";
import {
  formatObjectiveBudgetPair,
  formatObjectiveExpiry,
  formatObjectiveUsage,
  type ObjectiveBudgetFormatKind,
} from "@/lib/symphony/format";
import type { ObjectiveBudgetProjection, ObjectiveProjection } from "@/lib/symphony/objective-project";
import { cn } from "@/lib/utils";

type ObjectivePolicyRailProps = {
  projection: ObjectiveProjection;
};

/**
 * A read-only disclosure for the daemon's objective authority envelope. It is
 * intentionally a rail rather than a collection of dashboard cards: the
 * durable workline remains the primary surface, with policy facts close at
 * hand when a user needs to inspect why work can or cannot continue.
 */
export function ObjectivePolicyRail({ projection }: ObjectivePolicyRailProps) {
  const { policy, budget } = projection;
  const expired = policy.expiresAt !== null && Date.parse(policy.expiresAt) <= Date.now();
  const active = isObjectiveActive(projection, expired);
  const reason = budget.pauseReason ?? projection.error ?? (expired ? "Policy expired." : null) ?? (projection.state === "awaiting-approval" ? "Approval required." : null);
  const limitsAvailable = budget.limits !== null;

  return (
    <details className="group mt-5 border-y border-border/55" open>
      <summary className="flex list-none flex-wrap items-center gap-x-3 gap-y-2 py-3 text-[10px] marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2 font-medium text-foreground/85">
          {active ? (
            <AgentLoader kind="square" size={13} label="Objective policy active" animated tone="info" />
          ) : (
            <span className={cn("size-1.5 rounded-full", reason ? "bg-warning" : "bg-muted-foreground/55")} aria-hidden="true" />
          )}
          Policy &amp; budget
        </span>
        <span className="font-mono capitalize text-muted-foreground">{projection.state.replaceAll("-", " ")}</span>
        <span className="text-muted-foreground/55">·</span>
        <span className="font-mono text-muted-foreground">
          {budget.available ? (budget.status ?? "ledger available") : "ledger unavailable"}
        </span>
        <CaretDown className="ml-auto size-3.5 text-muted-foreground/65 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>

      <div className="grid gap-x-8 gap-y-4 border-t border-border/35 pb-4 pt-3 text-[10px] lg:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.2fr)]">
        <div className="space-y-3">
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground/80">Authority envelope</p>
              {policy.available ? (
                <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted-foreground">
                  <dt>permission</dt><dd className="truncate font-mono text-foreground/75">{policy.effectivePermission ?? "Unknown"}</dd>
                  <dt>side effects</dt><dd className="truncate font-mono text-foreground/75">{policy.sideEffectClassCeiling ?? "Unknown"}</dd>
                  <dt>policy</dt><dd className="truncate font-mono text-foreground/75" title={policy.hash ?? undefined}>{policy.hash ?? "Unknown"}</dd>
                  <dt>expiry</dt><dd className="truncate font-mono text-foreground/75">{formatObjectiveExpiry(policy.expiresAt)}</dd>
                  <dt>workspace</dt><dd className="truncate font-mono text-foreground/75" title={policy.workspacePath ?? undefined}>{policy.workspacePath ?? "Unknown"}</dd>
                  <dt>workspace mode</dt><dd className="truncate font-mono text-foreground/75">{policy.dirtyPolicy ?? "Unknown"}</dd>
                </dl>
              ) : (
                <p className="mt-1.5 leading-4 text-muted-foreground">Policy snapshot unavailable for this run; no permission or workspace ceiling is inferred.</p>
              )}
            </div>
          </div>

          {reason ? (
            <div className="flex items-start gap-2.5 border-l-2 border-warning/65 pl-2.5 text-warning">
              <WarningCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 leading-4"><span className="font-medium">Attention</span><span className="ml-1.5 text-warning/80">{reason}</span></span>
            </div>
          ) : null}
        </div>

        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="font-medium text-foreground/80">Resource envelope</p>
            <span className="font-mono text-[9px] text-muted-foreground/65">consumed / ceiling</span>
          </div>
          <div className="grid grid-cols-1 gap-x-5 gap-y-1.5 sm:grid-cols-2">
            <BudgetMetric label="Concurrency" consumed={projection.progress.active} limit={budget.limits?.maxConcurrentAgents} available={limitsAvailable} kind="count" />
            <BudgetMetric label="Agent depth" consumed={null} limit={budget.limits?.maxDepth} available={limitsAvailable} kind="count" />
            <BudgetMetric label="Model calls" consumed={budget.consumed?.modelCalls} limit={budget.limits?.maxModelCalls} available={limitsAvailable} kind="count" />
            <BudgetMetric label="Tool calls" consumed={budget.consumed?.toolCalls} limit={budget.limits?.maxToolCalls} available={limitsAvailable} kind="count" />
            <BudgetMetric label="Tokens" consumed={budget.consumed?.totalTokens} limit={budget.limits?.maxTotalTokens} available={limitsAvailable} kind="tokens" />
            <BudgetMetric label="Cost" consumed={budget.consumed?.costUsd} limit={budget.limits?.maxCostUsd} available={limitsAvailable} kind="cost" unknown={budget.unknownCost} />
            <BudgetMetric label="Wall clock" consumed={budget.consumed?.wallTimeSeconds} limit={budget.limits?.maxWallTimeSeconds} available={limitsAvailable} kind="seconds" />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[9px] text-muted-foreground/75">
            <span>{budget.debitsAvailable ? `${budget.debits.length} debit${budget.debits.length === 1 ? "" : "s"} reconciled` : "Debit history unavailable"}</span>
            <span>{budget.reservationsAvailable ? `${budget.activeReservations.length} active reservation${budget.activeReservations.length === 1 ? "" : "s"}` : "Reservation ledger unavailable"}</span>
          </div>
          {budget.reservationsAvailable && budget.activeReservations.length > 0 ? <ActiveReservations budget={budget} /> : null}
        </div>
      </div>
    </details>
  );
}

function BudgetMetric({
  label,
  consumed,
  limit,
  available,
  kind,
  unknown = false,
}: {
  label: string;
  consumed: number | null | undefined;
  limit: number | null | undefined;
  available: boolean;
  kind: ObjectiveBudgetFormatKind;
  unknown?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 border-b border-border/25 pb-1">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="shrink-0 font-mono tabular-nums text-foreground/80">{formatObjectiveBudgetPair(consumed, limit, available, kind, unknown)}</span>
    </div>
  );
}

function ActiveReservations({ budget }: { budget: ObjectiveBudgetProjection }) {
  return (
    <div className="mt-3 border-t border-border/25 pt-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground/75">
        <Clock className="size-3" aria-hidden="true" />
        <span className="font-medium">Active reservations</span>
      </div>
      <ul className="space-y-1">
        {budget.activeReservations.map((reservation) => (
          <li key={reservation.id} className="flex min-w-0 items-center justify-between gap-3 font-mono text-[9px] text-muted-foreground">
            <span className="truncate" title={reservation.agentId ?? reservation.attemptId ?? reservation.id}>{reservation.agentId ?? reservation.attemptId ?? reservation.id}</span>
            <span className="shrink-0 text-foreground/70">{reservationAmount(reservation.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function reservationAmount(amount: ObjectiveBudgetProjection["activeReservations"][number]["amount"]): string {
  const parts = [
    `${formatObjectiveUsage(amount.costUsd, "cost")} cost`,
    `${formatObjectiveUsage(amount.totalTokens, "tokens")} tokens`,
    `${formatObjectiveUsage(amount.toolCalls, "count")} tools`,
  ];
  return parts.join(" · ");
}

function isObjectiveActive(projection: ObjectiveProjection, expired: boolean): boolean {
  return !projection.terminal
    && !expired
    && ["executing", "evaluating", "replanning"].includes(projection.state)
    && projection.budget.status !== "paused"
    && projection.budget.status !== "exhausted"
    && projection.budget.status !== "settled";
}
