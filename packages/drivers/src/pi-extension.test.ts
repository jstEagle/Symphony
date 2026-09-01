import { afterEach, describe, expect, it, vi } from "vitest";

type RegisteredTool = {
  name: string;
  description: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

const originalEnvironment = {
  daemonUrl: process.env.SYMPHONY_DAEMON_URL,
  agentId: process.env.SYMPHONY_AGENT_ID,
  token: process.env.SYMPHONY_AGENT_TOKEN,
  canCreate: process.env.SYMPHONY_AGENT_CAN_CREATE,
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries({
    SYMPHONY_DAEMON_URL: originalEnvironment.daemonUrl,
    SYMPHONY_AGENT_ID: originalEnvironment.agentId,
    SYMPHONY_AGENT_TOKEN: originalEnvironment.token,
    SYMPHONY_AGENT_CAN_CREATE: originalEnvironment.canCreate,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function registeredTools(canCreate: boolean): Promise<RegisteredTool[]> {
  process.env.SYMPHONY_DAEMON_URL = "http://127.0.0.1:3210";
  process.env.SYMPHONY_AGENT_ID = "pi-extension-test-agent";
  process.env.SYMPHONY_AGENT_TOKEN = "pi-extension-test-token";
  process.env.SYMPHONY_AGENT_CAN_CREATE = String(canCreate);
  vi.resetModules();
  const extension = await import("./pi-extension.js");
  const tools: RegisteredTool[] = [];
  extension.default({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
  return tools;
}

describe("Pi Symphony Objective Runtime extension", () => {
  it("exposes only objective inspection at the delegation boundary", async () => {
    const tools = await registeredTools(false);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("list_objectives");
    expect(names).toContain("get_objective");
    expect(names).not.toContain("create_objective");
    expect(names).not.toContain("commit_objective_plan");
    expect(names).not.toContain("checkpoint_objective");
    expect(names).not.toContain("request_objective_approval");
  });

  it("exposes objective mutations to an authorized Pi session and forwards idempotency", async () => {
    const tools = await registeredTools(true);
    const objectiveTools = tools.filter((tool) => tool.name.includes("objective"));
    expect(objectiveTools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "list_objectives", "get_objective", "create_objective", "commit_objective_plan",
      "checkpoint_objective", "request_objective_approval",
    ]));
    expect(tools.find((tool) => tool.name === "create_objective")?.description).toContain("durable Symphony objective");
    expect(tools.find((tool) => tool.name === "create_objective")?.description).toContain("native Pi subagents");

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const create = tools.find((tool) => tool.name === "create_objective");
    if (!create) throw new Error("Pi create_objective tool was not registered.");
    await create.execute("call-create-1", {
      workflowId: "workflow",
      workflowRevision: 1,
      workflowHash: "workflow-hash",
      spec: { id: "objective", statement: "Ship the objective." },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/v1/objectives", "http://127.0.0.1:3210"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-symphony-agent-id": "pi-extension-test-agent",
          "x-symphony-agent-token": "pi-extension-test-token",
          "idempotency-key": "pi:pi-extension-test-agent:create-objective:call-create-1",
        }),
      }),
    );
  });

  it("describes the Pi bridge as durable Symphony coordination, not native subagent control", async () => {
    const tools = await registeredTools(true);
    for (const name of ["list_agents", "create_agent", "list_objectives", "get_objective", "send_message", "observe_agent"]) {
      const description = tools.find((tool) => tool.name === name)?.description;
      expect(description, `${name} should be registered`).toBeTruthy();
      expect(description).toContain("Symphony");
    }
    expect(tools.find((tool) => tool.name === "create_agent")?.description).toContain("ephemeral, tightly coupled");
    expect(tools.find((tool) => tool.name === "send_message")?.description).toContain("authenticated Symphony graph");
  });
});
