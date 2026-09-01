import { describe, expect, it } from "vitest";
import type { Agent } from "../apps/web/src/lib/symphony/contracts.js";
import { layoutFromAgents } from "../apps/web/src/lib/symphony/graph-projection.js";
import { graphBounds } from "../apps/web/src/components/symphony/workflow-graph.js";

function agent(id: string, options: Partial<Agent> = {}): Agent {
  return {
    id,
    logicalAgentId: options.logicalAgentId ?? `ledger-${id}`,
    parentId: options.parentId,
    depth: options.parentId ? 1 : 0,
    name: options.name ?? (options.parentId ? "Worker" : "Conductor"),
    objective: options.objective ?? `Work for ${id}`,
    model: "fixture",
    harness: "Codex",
    access: "read-only",
    state: options.state ?? "succeeded",
    elapsed: "1s",
    cost: 0,
    lastActivity: "now",
    startedAt: options.startedAt ?? `2026-09-01T00:00:0${id.slice(-1)}.000Z`,
    updatedAt: options.updatedAt,
    runId: options.runId,
    workflowId: options.workflowId,
    dependsOn: options.dependsOn,
  };
}

describe("graph projection semantics", () => {
  it("uses durable ledger ids and labels sequential conductor turns", () => {
    const first = agent("runtime-1", { logicalAgentId: "turn-1", runId: "chat-run", workflowId: "chat-workflow" });
    const second = agent("runtime-2", { logicalAgentId: "turn-2", runId: "chat-run", workflowId: "chat-workflow" });
    const forward = layoutFromAgents([first, second]);
    const reverse = layoutFromAgents([second, first]);

    expect(forward.nodes.map((node) => node.id)).toEqual(["turn-1", "turn-2"]);
    expect(forward.nodes.map((node) => node.label)).toEqual(["Conductor · turn 1", "Conductor · turn 2"]);
    expect(forward.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y }))).toEqual(
      reverse.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y })),
    );
    expect(forward.nodes[1]!.y - forward.nodes[0]!.y).toBe(96);
  });

  it("keeps delegation and dependency edges distinct and deterministic", () => {
    const root = agent("root", { logicalAgentId: "root-ledger" });
    const dependency = agent("dependency", { logicalAgentId: "dependency-ledger", parentId: "root" });
    const worker = agent("worker", {
      logicalAgentId: "worker-ledger",
      parentId: "root",
      dependsOn: ["dependency-ledger"],
    });
    const projection = layoutFromAgents([worker, root, dependency]);

    expect(projection.edges).toEqual([
      { from: "dependency-ledger", to: "worker-ledger", kind: "dependency" },
      { from: "root-ledger", to: "dependency-ledger", kind: "delegation" },
      { from: "root-ledger", to: "worker-ledger", kind: "delegation" },
    ]);
  });

  it("reconciles duplicate ledger rows to the freshest authoritative state", () => {
    const stale = agent("runtime-old", { logicalAgentId: "same-ledger", updatedAt: "2026-09-01T00:00:01.000Z", state: "running" });
    const fresh = agent("runtime-new", { logicalAgentId: "same-ledger", updatedAt: "2026-09-01T00:00:02.000Z", state: "succeeded" });
    const projection = layoutFromAgents([stale, fresh]);

    expect(projection.nodes).toHaveLength(1);
    expect(projection.nodes[0]).toMatchObject({ id: "same-ledger", agentId: "runtime-new", state: "succeeded" });
  });

  it("includes routed edge control points in fit bounds so same-column dependencies are not cropped", () => {
    const nodes = [
      { id: "from", label: "From", detail: "", state: "succeeded" as const, x: 0, y: 0 },
      { id: "to", label: "To", detail: "", state: "running" as const, x: 0, y: 120 },
    ];
    const withoutEdges = graphBounds(nodes);
    const withEdges = graphBounds(nodes, [{ from: "from", to: "to", kind: "dependency" }]);

    expect(withEdges.minX).toBeLessThan(withoutEdges.minX);
    expect(withEdges.maxX).toBeGreaterThan(withoutEdges.maxX);
  });
});
