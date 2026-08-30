import type { Agent } from "./contracts";

export type AgentReferenceData = Record<string, unknown>;

/**
 * Reconcile model-authored UI data with the daemon's current agent projection.
 * Exact ids are authoritative and never fall through to a similarly named
 * newer agent. Label matching is only a compatibility path for older surfaces
 * that did not include ids, and ambiguous matches deliberately become stale.
 */
export function resolveAgentReference(
  item: AgentReferenceData,
  agents: readonly Agent[],
): AgentReferenceData {
  const explicitId = optionalText(item.agentId) ?? optionalText(item.id);
  if (explicitId) {
    const explicit = agents.find((agent) => agent.id === explicitId);
    return explicit
      ? authoritativeAgentReference(item, explicit)
      : staleAgentReference(item, explicitId);
  }

  const labels = [item.name, item.title, item.label, item.objective]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(normalizeAgentLabel);
  const exact = agents.filter((agent) => {
    const name = normalizeAgentLabel(agent.name);
    const objective = normalizeAgentLabel(agent.objective);
    return labels.some((label) => label === name || label === objective || objective.startsWith(label));
  });
  if (exact.length === 1) return authoritativeAgentReference(item, exact[0] as Agent);

  const ranked = agents
    .map((agent) => ({
      agent,
      score: Math.max(
        0,
        ...labels.map((label) => Math.max(
          agentLabelScore(label, normalizeAgentLabel(agent.name)),
          agentLabelScore(label, normalizeAgentLabel(agent.objective)),
        )),
      ),
    }))
    .filter((candidate) => candidate.score >= 0.35)
    .sort((a, b) => b.score - a.score);
  if (ranked.length > 0 && (ranked.length === 1 || (ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0) >= 0.15)) {
    return authoritativeAgentReference(item, ranked[0]!.agent);
  }
  return staleAgentReference(item);
}

function authoritativeAgentReference(item: AgentReferenceData, matched: Agent): AgentReferenceData {
  return {
    ...item,
    agentId: matched.id,
    name: optionalText(item.name) ?? matched.name,
    model: optionalText(item.model) ?? matched.model,
    state: matched.state,
    nativeStatus: matched.nativeStatus ?? null,
    error: matched.error ?? null,
  };
}

function staleAgentReference(item: AgentReferenceData, explicitId?: string): AgentReferenceData {
  return {
    ...item,
    ...(explicitId ? { agentId: explicitId } : {}),
    state: "stale",
    nativeStatus: null,
    error: optionalText(item.error) ?? "This historical agent reference is not present in the current authoritative projection.",
  };
}

function normalizeAgentLabel(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function agentLabelScore(left: string, right: string): number {
  const leftTokens = labelTokens(left);
  const rightTokens = labelTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.max(leftTokens.size, Math.min(rightTokens.size, leftTokens.size * 2));
}

function labelTokens(value: string): Set<string> {
  return new Set(value.split(" ").filter(Boolean).map((token) => token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token));
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
