import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "../apps/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../apps/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const servers: Server[] = [];
const transports: StdioClientTransport[] = [];
const clients: Client[] = [];

type CapturedRequest = {
  method: string;
  url: string;
  idempotencyKey: string | undefined;
  body: unknown;
};

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const transport of transports.splice(0)) await transport.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function mockDaemon(): Promise<{ url: string; requests: string[]; captured: CapturedRequest[] }> {
  const requests: string[] = [];
  const captured: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(request.url ?? "");
      const text = Buffer.concat(chunks).toString("utf8");
      captured.push({
        method: request.method ?? "",
        url: request.url ?? "",
        idempotencyKey: typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined,
        body: text ? JSON.parse(text) as unknown : null,
      });
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith("/v1/objectives/") === true) {
        response.end(JSON.stringify({
          run: { runId: "objective/run 1", state: "executing" },
          planRevisions: [],
          checkpoints: [],
          approvals: [],
          events: [{ cursor: 12, type: "objective.task.started" }],
          eventCursor: 12,
          hasMore: false,
        }));
        return;
      }
      response.end(JSON.stringify({ objectives: [{ runId: "objective/run 1", state: "executing" }], limit: 3 }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock daemon did not bind a TCP port");
  return { url: `http://127.0.0.1:${address.port}`, requests, captured };
}

async function mcpClient(daemonUrl: string, canCreate = false): Promise<Client> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const transport = new StdioClientTransport({
    command: join(process.cwd(), "node_modules", ".bin", "tsx"),
    args: [join(process.cwd(), "apps", "mcp", "src", "index.ts")],
    env: {
      ...environment,
      SYMPHONY_DAEMON_URL: daemonUrl,
      SYMPHONY_AGENT_ID: "objective-tool-test-agent",
      SYMPHONY_AGENT_TOKEN: "objective-tool-test-token",
      SYMPHONY_AGENT_CAN_CREATE: String(canCreate),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "symphony-objective-tool-test", version: "1.0.0" });
  transports.push(transport);
  clients.push(client);
  await client.connect(transport);
  return client;
}

function textResult(value: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const text = value.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") throw new Error("MCP result did not contain text content");
  return JSON.parse(text.text) as unknown;
}

describe("Symphony MCP objective projections", () => {
  it("exposes read-only objective inspection and teaches the conductor boundary", async () => {
    const daemon = await mockDaemon();
    const client = await mcpClient(daemon.url);
    const listing = await client.listTools();
    const listTool = listing.tools.find((tool) => tool.name === "list_objectives");
    const getTool = listing.tools.find((tool) => tool.name === "get_objective");
    const workflowsTool = listing.tools.find((tool) => tool.name === "list_workflows");

    expect(listTool?.description).toContain("durable Symphony objectives");
    expect(listTool?.description).toContain("cross-harness conductor");
    expect(listTool?.description).toContain("Native harness subagents");
    expect(getTool?.description).toContain("plan revisions");
    expect(workflowsTool?.description).toContain("fanout/map");
    expect(workflowsTool?.description).toContain("item/itemIndex/itemKey");
    expect(listing.tools.map((tool) => tool.name)).not.toContain("create_objective");

    const list = await client.callTool({
      name: "list_objectives",
      arguments: { limit: 3, state: ["executing", "awaiting-approval"], workflowId: "workflow/a" },
    });
    expect(textResult(list)).toMatchObject({ objectives: [{ runId: "objective/run 1" }], limit: 3 });

    const detail = await client.callTool({
      name: "get_objective",
      arguments: { runId: "objective/run 1", limit: 50, after: 12 },
    });
    expect(textResult(detail)).toMatchObject({ run: { runId: "objective/run 1" }, eventCursor: 12 });
    expect(daemon.requests).toEqual([
      "/v1/objectives?limit=3&state=executing%2Cawaiting-approval&workflowId=workflow%2Fa",
      "/v1/objectives/objective%2Frun%201?limit=50&after=12",
    ]);
  });

  it("exposes durable objective mutations to an authorized conductor and forwards fresh idempotency keys", async () => {
    const daemon = await mockDaemon();
    const client = await mcpClient(daemon.url, true);
    const listing = await client.listTools();
    for (const name of ["create_objective", "commit_objective_plan", "checkpoint_objective", "request_objective_approval"]) {
      expect(listing.tools.map((tool) => tool.name)).toContain(name);
    }
    expect(listing.tools.find((tool) => tool.name === "create_objective")?.description).toContain("cross-harness conductor");
    expect(listing.tools.find((tool) => tool.name === "create_objective")?.description).toContain("Native harness subagents");
    expect(listing.tools.find((tool) => tool.name === "register_workflow")?.description).toContain("null/unlimited concurrency");
    expect(listing.tools.find((tool) => tool.name === "run_workflow")?.description).toContain("durable execution and recovery");
    expect(listing.tools.map((tool) => tool.name)).not.toContain("resolve_objective_approval");

    await client.callTool({
      name: "create_objective",
      arguments: {
        workflowId: "workflow/a",
        workflowRevision: 1,
        workflowHash: "workflow-hash-1",
        spec: { id: "objective-1", statement: "Ship the objective." },
        tasks: [{ id: "build", objective: "Build the change." }],
      },
    });
    await client.callTool({
      name: "commit_objective_plan",
      arguments: {
        runId: "objective/run 1",
        expectedPlanRevision: 0,
        tasks: [{ id: "verify", objective: "Verify the change.", dependsOn: ["build"] }],
        reason: "The verification branch is now required.",
      },
    });
    await client.callTool({
      name: "checkpoint_objective",
      arguments: {
        runId: "objective/run 1",
        eventCursor: 12,
        taskUpdates: [{ taskId: "build", state: "completed", output: { ok: true } }],
        reason: "The build completed.",
      },
    });
    await client.callTool({
      name: "request_objective_approval",
      arguments: {
        runId: "objective/run 1",
        kind: "task",
        taskId: "build",
        question: "May this task proceed?",
        operationId: "operation-1",
        requestHash: "request-hash-1",
        policyHash: "policy-hash-1",
        sideEffectClass: "local",
        canonicalTarget: "workspace:/repo",
      },
    });

    const mutations = daemon.captured.filter((request) => request.method === "POST");
    expect(mutations.map((request) => request.url)).toEqual([
      "/v1/objectives",
      "/v1/objectives/objective%2Frun%201/plans",
      "/v1/objectives/objective%2Frun%201/checkpoints",
      "/v1/objectives/objective%2Frun%201/approvals",
    ]);
    const keys = mutations.map((request) => request.idempotencyKey);
    expect(keys.every((key): key is string => typeof key === "string" && key.length >= 8)).toBe(true);
    expect(new Set(keys).size).toBe(4);
    expect(mutations[0]?.body).not.toHaveProperty("requestKey");
    expect(mutations[1]?.body).toMatchObject({ expectedPlanRevision: 0, tasks: [{ id: "verify" }] });
    expect(mutations[1]?.body).not.toHaveProperty("runId");
    expect(mutations[2]?.body).toMatchObject({ eventCursor: 12, taskUpdates: [{ taskId: "build", state: "completed" }] });
    expect(mutations[3]?.body).toMatchObject({ kind: "task", taskId: "build", sideEffectClass: "local" });
  });

  it("exposes typed strategy CAS tools without accepting caller-derived durable state", async () => {
    const daemon = await mockDaemon();
    const client = await mcpClient(daemon.url);
    const listing = await client.listTools();
    expect(listing.tools.map((tool) => tool.name)).toContain("get_objective_strategy");
    expect(listing.tools.map((tool) => tool.name)).toContain("revise_objective_strategy");
    expect(listing.tools.find((tool) => tool.name === "get_objective_strategy")?.description).toContain("durable materializer");
    expect(listing.tools.find((tool) => tool.name === "revise_objective_strategy")?.description).toContain("stable item bindings");
    expect(listing.tools.find((tool) => tool.name === "preview_objective_strategy")?.description).toContain("do not materialize child executions");

    await client.callTool({
      name: "get_objective_strategy",
      arguments: { runId: "objective/run 1" },
    });
    await client.callTool({
      name: "revise_objective_strategy",
      arguments: {
        runId: "objective/run 1",
        type: "replace-node",
        expectedRevision: 0,
        nodeId: "root",
        node: {
          id: "root",
          sourceNodeId: "root",
          sourcePath: "root",
          dependsOn: [],
          type: "set",
          value: { approved: true },
        },
        reason: "Apply the approved strategy adjustment.",
        evidence: { eventCursor: 12, eventIds: [] },
      },
    });

    expect(daemon.requests).toEqual([
      "/v1/objectives/objective%2Frun%201/strategy",
      "/v1/objectives/objective%2Frun%201/strategy",
    ]);
    const mutation = daemon.captured[1];
    expect(mutation?.method).toBe("POST");
    expect(mutation?.idempotencyKey).toMatch(/^mcp:objective-tool-test-agent:revise-objective-strategy:/u);
    expect(mutation?.body).toMatchObject({ type: "replace-node", expectedRevision: 0, nodeId: "root" });
    expect(mutation?.body).not.toHaveProperty("runId");
    expect(mutation?.body).not.toHaveProperty("actor");
    expect(mutation?.body).not.toHaveProperty("requestKey");
    expect(mutation?.body).not.toHaveProperty("revision");
    expect(mutation?.body).not.toHaveProperty("snapshot");
  });

  it("exposes portable handoff tools and forwards an explicit rejection decision", async () => {
    const daemon = await mockDaemon();
    const client = await mcpClient(daemon.url, true);
    const listing = await client.listTools();
    const offerTool = listing.tools.find((tool) => tool.name === "offer_objective_handoff");
    const acceptTool = listing.tools.find((tool) => tool.name === "accept_objective_handoff");
    expect(offerTool?.description).toContain("immutable");
    expect(acceptTool?.description).toContain("new-attempt");

    await client.callTool({
      name: "accept_objective_handoff",
      arguments: {
        runId: "objective/run 1",
        envelopeId: "handoff-1",
        decision: "rejected",
        reason: "The target harness is unavailable.",
      },
    });
    const request = daemon.captured.at(-1);
    expect(request?.url).toBe("/v1/objectives/objective%2Frun%201/handoffs/handoff-1/accept");
    expect(request?.idempotencyKey).toMatch(/^mcp:objective-tool-test-agent:accept-objective-handoff:/u);
    expect(request?.body).toMatchObject({ envelopeId: "handoff-1", decision: "rejected" });
    expect(request?.body).not.toHaveProperty("runId");
  });
});
