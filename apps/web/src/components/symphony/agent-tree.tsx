"use client";

import { useMemo } from "react";
import type { Agent } from "@/lib/symphony/contracts";
import { accessLabel, isActivelyWorkingAgent, statusLabel } from "@/lib/symphony/format";
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
  const { roots, childrenByParent } = useMemo(() => {
    const ids = new Set(agents.map((agent) => agent.id));
    const nextRoots: Agent[] = [];
    const nextChildren = new Map<string, Agent[]>();
    for (const agent of agents) {
      if (!agent.parentId || !ids.has(agent.parentId)) {
        nextRoots.push(agent);
        continue;
      }
      const children = nextChildren.get(agent.parentId) ?? [];
      children.push(agent);
      nextChildren.set(agent.parentId, children);
    }
    return { roots: nextRoots, childrenByParent: nextChildren };
  }, [agents]);

  if (agents.length === 0) {
    return <p className="text-xs text-muted-foreground">No agents in this conversation.</p>;
  }

  return (
    <ul className="space-y-1">
      {roots.map((agent) => (
        <TreeNode
          key={agent.id}
          agent={agent}
          childrenByParent={childrenByParent}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  agent,
  childrenByParent,
  selectedId,
  onSelect,
  depth = 0,
}: {
  agent: Agent;
  childrenByParent: ReadonlyMap<string, Agent[]>;
  selectedId?: string | null;
  onSelect?: (agent: Agent) => void;
  depth?: number;
}) {
  const children = childrenByParent.get(agent.id) ?? [];
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
        <AgentLoader
          kind={loaderForHarness(agent.harness)}
          size={14}
          label={`${agent.name} ${agent.state}`}
          animated={isActivelyWorkingAgent(agent.state)}
          tone={agent.state === "succeeded" ? "success" : agent.state === "failed" ? "danger" : agent.state === "running" || agent.state === "queued" ? "info" : "warning"}
        />
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
              childrenByParent={childrenByParent}
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
