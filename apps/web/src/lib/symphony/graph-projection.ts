import type { Agent, WorkEdge, WorkNode } from "./contracts";

/** Keep graph geometry in one place so projection and viewport math agree. */
export const GRAPH_NODE_WIDTH = 206;
export const GRAPH_NODE_HEIGHT = 64;
const SIBLING_GAP = 24;
const ROOT_GAP = 32;
const COLUMN_GAP = 356;

type GraphAgent = Agent & { logicalAgentId?: string | undefined };

/**
 * Project the authoritative agent ledger into a deterministic graph.
 *
 * `Agent.id` is the materialized runtime row and can differ from the stable
 * idempotency/work-order identity. The latter is preferred for graph node ids,
 * which keeps reconnects and bootstrap refreshes from making a node appear to
 * be a new piece of work. `agentId` remains the materialized id used to open
 * the agent detail sheet.
 */
export function layoutFromAgents(input: readonly Agent[]): { nodes: WorkNode[]; edges: WorkEdge[] } {
  const agents = dedupeLedgerAgents(input);
  if (agents.length === 0) return { nodes: [], edges: [] };

  const nodeIdByAgentId = new Map<string, string>();
  const nodeIdByLedgerId = new Map<string, string>();
  for (const agent of agents) {
    const nodeId = ledgerId(agent);
    nodeIdByAgentId.set(agent.id, nodeId);
    nodeIdByLedgerId.set(nodeId, nodeId);
  }

  const byParent = new Map<string, GraphAgent[]>();
  for (const agent of agents) {
    const parentId = resolveNodeId(agent.parentId, nodeIdByAgentId, nodeIdByLedgerId);
    if (!parentId || parentId === ledgerId(agent)) continue;
    const list = byParent.get(parentId) ?? [];
    list.push(agent);
    byParent.set(parentId, list);
  }
  for (const children of byParent.values()) children.sort(compareAgentsForLayout);

  const roots = agents
    .filter((agent) => {
      const parentId = resolveNodeId(agent.parentId, nodeIdByAgentId, nodeIdByLedgerId);
      return !parentId || parentId === ledgerId(agent);
    })
    .sort(compareAgentsForLayout);

  const rootScope = roots.length > 1 && roots.every((agent) => (
    (agent.runId ?? null) === (roots[0]?.runId ?? null)
    && (agent.workflowId ?? null) === (roots[0]?.workflowId ?? null)
  )) ? "turn" : "run";
  const nodes: WorkNode[] = [];
  const edges: WorkEdge[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();

  const subtreeHeight = (agent: GraphAgent): number => {
    const nodeId = ledgerId(agent);
    if (visiting.has(nodeId)) return GRAPH_NODE_HEIGHT;
    visiting.add(nodeId);
    const children = byParent.get(nodeId) ?? [];
    const childrenHeight = children.reduce((total, child) => total + subtreeHeight(child), 0)
      + Math.max(0, children.length - 1) * SIBLING_GAP;
    visiting.delete(nodeId);
    return Math.max(GRAPH_NODE_HEIGHT, childrenHeight);
  };

  const place = (agent: GraphAgent, depth: number, top: number, root: GraphAgent, turn: number): number => {
    const nodeId = ledgerId(agent);
    if (placed.has(nodeId)) return GRAPH_NODE_HEIGHT;
    placed.add(nodeId);
    const children = (byParent.get(nodeId) ?? []).filter((child) => !placed.has(ledgerId(child)));
    const height = subtreeHeight(agent);
    const childrenHeight = children.reduce((total, child) => total + subtreeHeight(child), 0)
      + Math.max(0, children.length - 1) * SIBLING_GAP;
    const nodeTop = top + (height - GRAPH_NODE_HEIGHT) / 2;
    const isRoot = nodeId === ledgerId(root);
    const context = roots.length > 1
      ? ` · ${rootScope} ${turn}`
      : "";
    nodes.push({
      id: nodeId,
      ledgerId: nodeId,
      agentId: agent.id,
      runId: agent.runId,
      rootId: ledgerId(root),
      ...(isRoot && roots.length > 1 ? { turn } : {}),
      label: isRoot ? `${agent.name}${context}` : agent.name,
      detail: `${agent.harness} · ${agent.access}${context}`,
      state: agent.state,
      x: depth * COLUMN_GAP,
      y: nodeTop,
    });
    let childTop = top + Math.max(0, (height - childrenHeight) / 2);
    for (const child of children) {
      edges.push({ from: nodeId, to: ledgerId(child), kind: "delegation" });
      const childHeight = place(child, depth + 1, childTop, root, turn);
      childTop += childHeight + SIBLING_GAP;
    }
    return height;
  };

  let nextTop = 0;
  roots.forEach((root, index) => {
    nextTop += place(root, 0, nextTop, root, index + 1) + ROOT_GAP;
  });
  // Malformed persisted parent cycles should remain visible instead of
  // disappearing. Their edges are still useful evidence of the bad linkage.
  for (const agent of agents) {
    if (placed.has(ledgerId(agent))) continue;
    nextTop += place(agent, 0, nextTop, agent, roots.length + 1) + ROOT_GAP;
  }

  const edgeKeys = new Set(edges.map(edgeKey));
  for (const agent of agents) {
    const to = ledgerId(agent);
    for (const dependency of agent.dependsOn ?? []) {
      const from = resolveNodeId(dependency, nodeIdByAgentId, nodeIdByLedgerId);
      if (!from || from === to) continue;
      const edge = { from, to, kind: "dependency" as const };
      const key = edgeKey(edge);
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push(edge);
    }
  }
  return { nodes, edges: edges.sort(compareEdges) };
}

export function ledgerId(agent: Pick<GraphAgent, "id" | "logicalAgentId">): string {
  return agent.logicalAgentId?.trim() || agent.id;
}

function dedupeLedgerAgents(input: readonly Agent[]): GraphAgent[] {
  const byLedgerId = new Map<string, GraphAgent>();
  for (const candidate of input) {
    const agent = candidate as GraphAgent;
    const key = ledgerId(agent);
    const previous = byLedgerId.get(key);
    if (!previous || compareAgentFreshness(agent, previous) > 0) byLedgerId.set(key, agent);
  }
  return [...byLedgerId.values()].sort(compareAgentsForLayout);
}

function compareAgentFreshness(left: GraphAgent, right: GraphAgent): number {
  return dateValue(left.updatedAt) - dateValue(right.updatedAt)
    || dateValue(left.finishedAt) - dateValue(right.finishedAt)
    || left.id.localeCompare(right.id);
}

function compareAgentsForLayout(left: GraphAgent, right: GraphAgent): number {
  const leftAt = left.startedAt ?? left.updatedAt ?? "";
  const rightAt = right.startedAt ?? right.updatedAt ?? "";
  return leftAt.localeCompare(rightAt) || ledgerId(left).localeCompare(ledgerId(right)) || left.id.localeCompare(right.id);
}

function resolveNodeId(
  reference: string | undefined,
  byAgentId: ReadonlyMap<string, string>,
  byLedgerId: ReadonlyMap<string, string>,
): string | undefined {
  if (!reference) return undefined;
  return byAgentId.get(reference) ?? byLedgerId.get(reference);
}

function dateValue(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function edgeKey(edge: WorkEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
}

function compareEdges(left: WorkEdge, right: WorkEdge): number {
  return left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind);
}
