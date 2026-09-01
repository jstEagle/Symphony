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

async function mockDaemon(): Promise<{ url: string; requests: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: unknown }> }> {
  const requests: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: unknown }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({ url: request.url ?? "", headers: request.headers, body: text ? JSON.parse(text) as unknown : null });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ artifacts: [], status: "committed" }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock daemon did not bind");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

async function mcpClient(daemonUrl: string): Promise<Client> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: join(process.cwd(), "node_modules", ".bin", "tsx"),
    args: [join(process.cwd(), "apps", "mcp", "src", "index.ts")],
    env: { ...env, SYMPHONY_DAEMON_URL: daemonUrl, SYMPHONY_AGENT_ID: "artifact-mcp-agent", SYMPHONY_AGENT_TOKEN: "artifact-mcp-token" },
    stderr: "pipe",
  });
  const client = new Client({ name: "artifact-mcp-test", version: "1.0.0" });
  transports.push(transport);
  clients.push(client);
  await client.connect(transport);
  return client;
}

describe("MCP objective artifact tools", () => {
  it("exposes daemon-scoped read/publish tools and forwards idempotency", async () => {
    const daemon = await mockDaemon();
    const client = await mcpClient(daemon.url);
    const listing = await client.listTools();
    expect(listing.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "list_objective_artifacts",
      "get_objective_artifact",
      "publish_objective_artifact",
    ]));
    expect(listing.tools.find((tool) => tool.name === "publish_objective_artifact")?.description).toContain("daemon computes");
    await client.callTool({
      name: "publish_objective_artifact",
      arguments: {
        runId: "objective-run-1",
        planRevision: 0,
        kind: "evidence",
        name: "evidence.json",
        mediaType: "application/json",
        content: { ok: true },
        evidence: { eventCursor: 0 },
      },
    });
    const request = daemon.requests.find((candidate) => candidate.url?.endsWith("/artifacts"));
    expect(request?.headers["idempotency-key"]).toMatch(/^mcp:artifact-mcp-agent:publish-objective-artifact:/u);
    expect(request?.body).not.toHaveProperty("hash");
    expect(request?.body).not.toHaveProperty("actor");
  });
});
