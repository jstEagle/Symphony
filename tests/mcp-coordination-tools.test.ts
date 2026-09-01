import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "../apps/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../apps/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const servers: Server[] = [];
const transports: StdioClientTransport[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const transport of transports.splice(0)) await transport.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function daemon(): Promise<{ url: string; requests: Array<{ method: string; url: string; key?: string; body: unknown }> }> {
  const requests: Array<{ method: string; url: string; key?: string; body: unknown }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        ...(typeof request.headers["idempotency-key"] === "string" ? { key: request.headers["idempotency-key"] } : {}),
        body: text ? JSON.parse(text) as unknown : null,
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock daemon did not bind");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

async function client(url: string, canCreate = true): Promise<Client> {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: join(process.cwd(), "node_modules", ".bin", "tsx"),
    args: [join(process.cwd(), "apps", "mcp", "src", "index.ts")],
    env: { ...environment, SYMPHONY_DAEMON_URL: url, SYMPHONY_AGENT_ID: "mcp-test-agent", SYMPHONY_AGENT_TOKEN: "mcp-test-token", SYMPHONY_AGENT_CAN_CREATE: String(canCreate) },
    stderr: "pipe",
  });
  const value = new Client({ name: "mcp-coordination-test", version: "1.0.0" });
  transports.push(transport);
  clients.push(value);
  await value.connect(transport);
  return value;
}

describe("Symphony MCP coordination projections", () => {
  it("discovers capability, durable message-bus, and session-diagnostics tools", async () => {
    const service = await daemon();
    const value = await client(service.url, false);
    const listing = await value.listTools();
    const names = listing.tools.map((tool) => tool.name);
    for (const name of ["list_capabilities", "get_capability", "prepare_capability_execution", "list_agent_messages", "replay_agent_messages", "get_agent_message_cursor", "get_agent_message", "send_agent_message", "deliver_agent_message", "mark_agent_message_unknown", "read_agent_message", "handle_agent_message", "get_session_diagnostics"]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("create_capability");
    expect(listing.tools.find((tool) => tool.name === "send_agent_message")?.description).toContain("durable cross-harness");
    expect(listing.tools.find((tool) => tool.name === "send_agent_message")?.description).toContain("native ephemeral");
    expect(listing.tools.find((tool) => tool.name === "get_session_diagnostics")?.description).toContain("secret-free");

    await value.callTool({ name: "list_agent_messages", arguments: { afterCursor: 7, limit: 25 } });
    await value.callTool({ name: "replay_agent_messages", arguments: { afterCursor: 7, limit: 25 } });
    await value.callTool({ name: "get_agent_message_cursor", arguments: {} });
    await value.callTool({ name: "get_session_diagnostics", arguments: { targetAgentId: "agent/one" } });
    expect(service.requests.map((request) => request.url)).toEqual([
      "/v1/agent-messages?after=7&limit=25",
      "/v1/agent-messages/replay?after=7&limit=25",
      "/v1/agent-messages/cursor",
      "/v1/agents/agent%2Fone/diagnostics",
    ]);
  });

  it("keeps mutations thin and forwards idempotency keys without caller authority fields", async () => {
    const service = await daemon();
    const value = await client(service.url);
    await value.callTool({ name: "create_capability", arguments: {
      capabilityId: "test.capability",
      definition: { parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
      provenance: { source: "test" },
    } });
    await value.callTool({ name: "send_agent_message", arguments: {
      kind: "finding",
      senderId: "agent:worker",
      recipientId: "agent:parent",
      payload: { ok: true },
      createdAt: "2026-09-01T00:00:00.000Z",
    } });
    await value.callTool({ name: "handle_agent_message", arguments: {
      messageId: "message:one",
      decision: "accepted",
    } });
    const mutations = service.requests.filter((request) => request.method === "POST");
    expect(mutations.map((request) => request.url)).toEqual(["/v1/capabilities", "/v1/agent-messages", "/v1/agent-messages/message%3Aone/handled"]);
    expect(mutations.every((request) => request.key?.startsWith("mcp:mcp-test-agent:") === true)).toBe(true);
    expect(mutations[0]?.body).not.toHaveProperty("actor");
    expect(mutations[0]?.body).not.toHaveProperty("requestKey");
    expect(mutations[1]?.body).not.toHaveProperty("requestKey");
    expect(mutations[2]?.body).toEqual({ decision: "accepted" });
  });
});
