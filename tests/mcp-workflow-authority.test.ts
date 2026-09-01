import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "../apps/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../apps/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

async function toolNames(canCreate: boolean): Promise<string[]> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const transport = new StdioClientTransport({
    command: join(process.cwd(), "node_modules", ".bin", "tsx"),
    args: [join(process.cwd(), "apps", "mcp", "src", "index.ts")],
    env: {
      ...environment,
      SYMPHONY_DAEMON_URL: "http://127.0.0.1:1",
      SYMPHONY_AGENT_ID: "capability-test-agent",
      SYMPHONY_AGENT_TOKEN: "capability-test-token",
      SYMPHONY_AGENT_CAN_CREATE: String(canCreate),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "symphony-mcp-capability-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

describe("Symphony MCP workflow authority", () => {
  it("exposes both workflow mutations only to agents allowed to create", async () => {
    const readOnlyTools = await toolNames(false);
    expect(readOnlyTools).toContain("preview_workflow");
    expect(readOnlyTools).not.toContain("register_workflow");
    expect(readOnlyTools).not.toContain("run_workflow");
    expect(readOnlyTools).not.toContain("activate_workflow");
    expect(readOnlyTools).not.toContain("deactivate_workflow");

    const creatorTools = await toolNames(true);
    expect(creatorTools).toContain("preview_workflow");
    expect(creatorTools).toContain("register_workflow");
    expect(creatorTools).toContain("run_workflow");
    expect(creatorTools).toContain("activate_workflow");
    expect(creatorTools).toContain("deactivate_workflow");
  });
});
