"use client";

import type { ComponentProps } from "react";
import { CheckIcon } from "lucide-react";
import { AgentLoader } from "@/components/symphony/agent-tool";
import type { AgentState, NativeAgentStatus } from "@/lib/symphony/contracts";
import { isActivelyWorkingAgent, statusLabel } from "@/lib/symphony/format";
import { cn } from "@/lib/utils";
import { mono, paper } from "./surfaces";
import { pct } from "../utils/range";

export interface SubagentItem {
  id?: string;
  agentId?: string;
  name: string;
  model: string;
  state?: AgentState;
  nativeStatus?: NativeAgentStatus;
  error?: string;
}

export function SubagentList({
  agents,
  completedCount,
  progress,
  showSummary,
  summaryAgent,
  onOpenAgent,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "agents"
  | "completedCount"
  | "progress"
  | "showSummary"
  | "summaryAgent"
> & {
  agents: readonly SubagentItem[];
  completedCount: number;
  progress: readonly number[];
  showSummary: boolean;
  summaryAgent: SubagentItem;
  onOpenAgent?: (agentId: string) => void;
}) {
  return (
    <div
      data-slot="subagent-list"
      className={cn(
        "flex min-h-[14.5rem] w-full max-w-xs flex-col gap-2",
        className,
      )}

      {...props}
    >
      {agents.map((agent, index) => {
        const done = agent.state ? agent.state === "succeeded" : index < completedCount;
        const active = agent.state ? isActivelyWorkingAgent(agent.state) : false;
        const width = progress[index] ?? 0;

        const agentId = agent.agentId ?? agent.id;
        return (
          <button
            key={`${agentId ?? agent.name}:${index}`}
            type="button"
            disabled={!agentId || !onOpenAgent}
            onClick={() => agentId && onOpenAgent?.(agentId)}
            className={cn(
              paper,
              "flex flex-col gap-2 rounded-2xl px-3.5 py-2.5 text-left transition-colors",
              agentId && onOpenAgent && "cursor-pointer hover:border-foreground/20 hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
            )}
            aria-label={agentId ? `Open ${agent.name}` : undefined}
          >
            <div className="flex items-center gap-2">
              {agent.state ? (
                <AgentLoader
                  kind="square"
                  size={14}
                  label={`${agent.name} ${statusLabel(agent.state, agent.nativeStatus)}`}
                  animated={active}
                  tone={stateTone(agent.state, agent.nativeStatus)}
                />
              ) : done ? (
                <CheckIcon className="fade-in zoom-in-90 animate-in size-3.5 shrink-0 text-success duration-200" />
              ) : <AgentLoader kind="square" size={14} label={`${agent.name} status unavailable`} animated={false} tone="warning" />}
              <span className="flex-1 truncate text-[13.5px]">
                {agent.name}
              </span>
              <span className={cn(mono, "max-w-[48%] truncate text-foreground/35")}>
                {agent.state ? statusLabel(agent.state, agent.nativeStatus) : agent.model}
              </span>
            </div>
            {agent.error ? (
              <span className="truncate text-[10px] text-destructive" title={agent.error}>{agent.error}</span>
            ) : null}
            <span className="bg-foreground/[0.06] h-[3px] w-full overflow-hidden rounded-full">
              <span
                className={cn(
                  "block h-full rounded-full transition-[width] duration-700",
                  agent.state === "failed" ? "bg-destructive/80" : done ? "bg-success/75" : agent.nativeStatus === "idle" ? "bg-info/75" : agent.state === "waiting" ? "bg-warning/75" : "bg-info/75",
                )}
                style={{ width: `${agent.state && !active ? 100 : pct(width, 100)}%` }}
              />
            </span>
          </button>
        );
      })}
      {showSummary && (
        <button
          type="button"
          disabled={!(summaryAgent.agentId ?? summaryAgent.id) || !onOpenAgent}
          onClick={() => {
            const agentId = summaryAgent.agentId ?? summaryAgent.id;
            if (agentId) onOpenAgent?.(agentId);
          }}
          className={cn(
            paper,
            "fade-in slide-in-from-bottom-2 animate-in flex flex-col gap-2 rounded-2xl px-3.5 py-2.5 text-left duration-300",
            (summaryAgent.agentId ?? summaryAgent.id) && onOpenAgent && "cursor-pointer hover:border-foreground/20 hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
          )}
          aria-label={(summaryAgent.agentId ?? summaryAgent.id) ? `Open ${summaryAgent.name}` : undefined}
        >
          <div className="flex items-center gap-2">
            <AgentLoader
              kind="triangle"
              size={14}
              label={`${summaryAgent.name} ${summaryAgent.state ? statusLabel(summaryAgent.state, summaryAgent.nativeStatus) : "status unavailable"}`}
              animated={summaryAgent.state ? isActivelyWorkingAgent(summaryAgent.state) : false}
              tone={summaryAgent.state ? stateTone(summaryAgent.state, summaryAgent.nativeStatus) : "info"}
            />
            <span className="flex-1 truncate text-[13.5px]">
              {summaryAgent.name}
            </span>
            <span className={cn(mono, "text-foreground/35")}>
              {summaryAgent.state ? statusLabel(summaryAgent.state, summaryAgent.nativeStatus) : summaryAgent.model}
            </span>
          </div>
          <span className="bg-foreground/[0.06] h-[3px] w-full overflow-hidden rounded-full">
            <span
              className={cn(
                "block h-full rounded-full transition-[width] duration-700",
                summaryAgent.state === "failed" ? "bg-destructive/80" : summaryAgent.state === "succeeded" ? "bg-success/75" : summaryAgent.nativeStatus === "idle" ? "bg-info/75" : summaryAgent.state === "waiting" ? "bg-warning/75" : "bg-info/75",
              )}
              style={{ width: `${summaryAgent.state && !isActivelyWorkingAgent(summaryAgent.state) ? 100 : 42}%` }}
            />
          </span>
        </button>
      )}
    </div>
  );
}

function stateTone(state: AgentState, native?: NativeAgentStatus): "info" | "success" | "danger" | "warning" {
  if (native === "idle") return "info";
  if (state === "succeeded") return "success";
  if (state === "failed") return "danger";
  if (state === "running" || state === "queued") return "info";
  return "warning";
}
