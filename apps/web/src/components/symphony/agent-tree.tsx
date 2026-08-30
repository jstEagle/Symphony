"use client";

import type { Agent } from "@/lib/symphony/contracts";
import { accessLabel, isLiveAgentState, statusLabel } from "@/lib/symphony/format";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { loaderForHarness } from "@/lib/symphony/format";
import { cn } from "@/lib/utils";

export function AgentTree({
  agents,
  selectedId,
  onSelect,
}: {
  agents: Agent[];
  selectedId?: string | null;
  onSelect?: (agent: Agent) => void;
}) {
  const roots = agents.filter((agent) => !agent.parentId || !agents.some((item) => item.id === agent.parentId));

  if (agents.length === 0) {
    return <p className="text-xs text-muted-foreground">No agents in this conversation.</p>;
  }

  return (
    <ul className="space-y-1">
      {roots.map((agent) => (
        <TreeNode
          key={agent.id}
          agent={agent}
          agents={agents}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  agent,
  agents,
  selectedId,
  onSelect,
  depth = 0,
}: {
  agent: Agent;
  agents: Agent[];
  selectedId?: string | null;
  onSelect?: (agent: Agent) => void;
  depth?: number;
}) {
  const children = agents.filter((item) => item.parentId === agent.id);
  const selected = selectedId === agent.id;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect?.(agent)}
        className={cn(
          "flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] transition-colors",
          selected ? "bg-muted text-foreground" : "hover:bg-muted/70 text-foreground/90",
        )}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {isLiveAgentState(agent.state) ? (
          <AgentLoader kind={loaderForHarness(agent.harness)} size={14} label={`${agent.name} active`} />
        ) : (
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              agent.state === "succeeded" && "bg-foreground",
              agent.state === "failed" && "bg-destructive",
              agent.state === "blocked" && "bg-destructive",
              agent.state === "cancelled" && "bg-muted-foreground/50",
              agent.state === "stale" && "bg-muted-foreground",
              (agent.state === "waiting" || agent.state === "queued") && "bg-muted-foreground/40",
            )}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{agent.objective}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {statusLabel(agent.state, agent.nativeStatus)}
        </span>
      </button>
      <p className="mb-1.5 truncate pl-7 text-[11px] text-muted-foreground" style={{ paddingLeft: 28 + depth * 14 }}>
        {agent.harness} · {agent.model} · {accessLabel(agent.access)}
      </p>
      {children.length > 0 && (
        <ul>
          {children.map((child) => (
            <TreeNode
              key={child.id}
              agent={child}
              agents={agents}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
