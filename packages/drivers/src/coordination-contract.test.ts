import { describe, expect, it } from "vitest";
import { AgentWorkOrderSchema } from "@symphony/protocol";
import {
  buildCoordinationCapabilityManifest,
  renderCoordinationCapabilityManifest,
} from "./coordination-contract.js";

function order(overrides: Record<string, unknown> = {}) {
  return AgentWorkOrderSchema.parse({
    workflowId: "workflow",
    runId: "run",
    depth: 1,
    mission: { id: "mission", revision: 1, hash: "12345678", statement: "Advance the work." },
    objective: "Complete the task.",
    outputSchema: {},
    workspace: { path: "/tmp" },
    ...overrides,
  });
}

describe("Symphony coordination capability manifest", () => {
  it("derives a complete full-access inventory and names the canonical bridge", () => {
    const manifest = buildCoordinationCapabilityManifest(order({ depth: 0 }), { canCreate: true });
    expect(manifest.access).toBe("full-access");
    expect(manifest.source).toBe("canonical");
    expect(manifest.canCreate).toBe(true);
    expect(manifest.tools.find((tool) => tool.canonicalName === "create_agent")).toMatchObject({
      name: "create_agent",
      available: true,
    });
  });

  it("explains an omitted create tool at the exact depth boundary", () => {
    const manifest = buildCoordinationCapabilityManifest(order({ depth: 3 }), { maxDepth: 3, canCreate: false });
    const create = manifest.tools.find((tool) => tool.canonicalName === "create_agent");
    expect(create).toMatchObject({ available: false });
    expect(create?.reason).toContain("unavailable at delegation depth 3");
    expect(create?.reason).toContain("maximum depth is 3");
    expect(manifest.tools.find((tool) => tool.canonicalName === "list_agents")?.available).toBe(true);
    expect(renderCoordinationCapabilityManifest(manifest)).toContain("do not claim they exist");
  });

  it("retains exact discovered prefixes and surfaces optional extensions without importing them", () => {
    const manifest = buildCoordinationCapabilityManifest(order(), {
      canCreate: true,
      availableTools: [
        "mcp__symphony__list_agents",
        "mcp__symphony__create_agent",
        "mcp__symphony__capability_library_list",
        "mcp__symphony__message_bus_send",
      ],
    });
    expect(manifest.prefix).toBe("mcp__symphony__");
    expect(manifest.tools.find((tool) => tool.canonicalName === "list_agents")).toMatchObject({
      name: "mcp__symphony__list_agents",
      available: true,
    });
    expect(manifest.tools.find((tool) => tool.canonicalName === "get_objective")?.available).toBe(false);
    expect(manifest.extensions).toEqual([
      { name: "mcp__symphony__capability_library_list", category: "capability-library" },
      { name: "mcp__symphony__message_bus_send", category: "message-bus" },
    ]);
  });

  it("marks full-access-only controls unavailable to a read-only work order", () => {
    const manifest = buildCoordinationCapabilityManifest(order({ permissions: "read-only" }), { canCreate: true });
    expect(manifest.tools.find((tool) => tool.canonicalName === "list_agents")?.available).toBe(true);
    expect(manifest.tools.find((tool) => tool.canonicalName === "cancel_agent")).toMatchObject({
      available: false,
      reason: "unavailable: this work order has read-only access",
    });
    expect(manifest.tools.find((tool) => tool.canonicalName === "create_agent")?.available).toBe(true);
  });

  it("advertises the daemon-backed capability, message, and diagnostics tools only after discovery", () => {
    const discovered = [
      "mcp__symphony__list_capabilities",
      "mcp__symphony__prepare_capability_execution",
      "mcp__symphony__list_agent_messages",
      "mcp__symphony__send_agent_message",
      "mcp__symphony__get_session_diagnostics",
    ];
    const manifest = buildCoordinationCapabilityManifest(order(), { availableTools: discovered });
    expect(manifest.tools.filter((tool) => [
      "list_capabilities",
      "prepare_capability_execution",
      "list_agent_messages",
      "send_agent_message",
      "get_session_diagnostics",
    ].includes(tool.canonicalName))).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalName: "list_capabilities", name: "mcp__symphony__list_capabilities", available: true, category: "capability" }),
      expect.objectContaining({ canonicalName: "prepare_capability_execution", name: "mcp__symphony__prepare_capability_execution", available: true, category: "capability" }),
      expect.objectContaining({ canonicalName: "list_agent_messages", name: "mcp__symphony__list_agent_messages", available: true, category: "message" }),
      expect.objectContaining({ canonicalName: "send_agent_message", name: "mcp__symphony__send_agent_message", available: true, category: "message" }),
      expect.objectContaining({ canonicalName: "get_session_diagnostics", name: "mcp__symphony__get_session_diagnostics", available: true, category: "diagnostic" }),
    ]));
    expect(manifest.extensions).toEqual([]);
  });
});
