"use client";

import type { AgentState, WorkEdge, WorkNode } from "@/lib/symphony/contracts";
import { cn } from "@/lib/utils";

const stateFill: Record<AgentState, string> = {
  queued: "var(--muted-foreground)",
  running: "var(--primary)",
  waiting: "var(--chart-2)",
  blocked: "var(--destructive)",
  succeeded: "var(--success)",
  failed: "var(--destructive)",
  cancelled: "var(--muted-foreground)",
  stale: "var(--warning)",
};

export function WorkflowGraph({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: WorkNode[];
  edges: WorkEdge[];
  selectedId?: string | null;
  onSelect?: (node: WorkNode) => void;
}) {
  if (nodes.length === 0) {
    return <p className="text-xs text-muted-foreground">No workflow graph for this conversation yet.</p>;
  }

  const width = Math.max(360, ...nodes.map((node) => node.x + 180));
  const height = Math.max(220, ...nodes.map((node) => node.y + 82));
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="max-w-full"
        role="img"
        aria-label="Workflow graph"
      >
        {edges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to) return null;
          const x1 = from.x + 72;
          const y1 = from.y + 25;
          const x2 = to.x + 72;
          const y2 = to.y + 25;
          return (
            <path
              key={`${edge.from}-${edge.to}`}
              d={`M ${x1} ${y1} C ${x1 + 48} ${y1}, ${x2 - 48} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="currentColor"
              strokeOpacity={edge.kind === "delegation" ? 0.28 : 0.18}
              strokeWidth={edge.kind === "delegation" ? 1.5 : 1.25}
              strokeDasharray={edge.kind === "dependency" ? "4 4" : undefined}
            />
          );
        })}
        {nodes.map((node) => {
          const selected = node.id === selectedId || node.agentId === selectedId;
          return (
            <g
              key={node.id}
              transform={`translate(${node.x} ${node.y})`}
              className={onSelect && node.agentId ? "cursor-pointer" : undefined}
              onClick={() => node.agentId && onSelect?.(node)}
            >
              <rect
                width="144"
                height="50"
                rx="10"
                fill="var(--color-card)"
                stroke={selected ? "var(--primary)" : "transparent"}
                strokeWidth={selected ? 1.25 : 0}
              />
              <circle cx="17" cy="25" r="3.5" fill={stateFill[node.state]} />
              <text x="28" y="21" fill="var(--foreground)" fontSize="11" fontWeight="500">
                {truncate(node.label, 17)}
              </text>
              <text x="28" y="37" fill="var(--muted-foreground)" fontSize="9">
                {truncate(node.detail, 22)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-4 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        <Legend swatch="var(--primary)" label="Running" />
        <Legend swatch="var(--success)" label="Done" />
        <Legend swatch="var(--destructive)" label="Blocked" />
        <span className={cn("inline-flex items-center gap-1.5")}>
          <span className="w-5 border-t border-foreground/30" /> Delegation
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-5 border-t border-dashed border-foreground/25" /> Dependency
        </span>
      </div>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2 rounded-full" style={{ background: swatch }} />
      {label}
    </span>
  );
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
