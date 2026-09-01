import { describe, expect, it, vi } from "vitest";
import {
  DURABLE_MESSAGES_PATH,
  OperatorClient,
  parseOperatorArgs,
  runOperatorCommand,
} from "../apps/cli/src/operator-cli.js";

describe("operator CLI", () => {
  it("parses capability and durable-message options without shell semantics", () => {
    expect(parseOperatorArgs([
      "messages", "list", "--after", "12", "--limit", "20", "--recipient-id", "agent:child", "--json",
    ])).toMatchObject({
      resource: "messages",
      action: "list",
      positional: [],
      options: { after: 12, limit: 20, recipientId: "agent:child", json: true },
    });
  });

  it("uses daemon routes and preserves a stable mutation key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ status: "committed", message: { id: "message-1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new OperatorClient({ baseUrl: "http://localhost:3210", fetchFn });

    await runOperatorCommand([
      "messages", "send", "--body", JSON.stringify({
        kind: "status", senderId: "user:one", recipientId: "agent:one", createdAt: "2026-09-01T00:00:00.000Z",
      }), "--idempotency-key", "message-key-1", "--json",
    ], client);

    expect(calls[0]?.url).toBe(`${"http://localhost:3210"}${DURABLE_MESSAGES_PATH}`);
    expect(calls[0]?.init?.headers).toMatchObject({ "idempotency-key": "message-key-1" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ requestKey: "message-key-1" });
  });

  it("maps message list cursors and diagnostics export to daemon reads", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new OperatorClient({ baseUrl: "http://localhost:3210", fetchFn });
    const write = vi.fn();

    await runOperatorCommand(["messages", "list", "--after", "4", "--before", "9", "--limit", "10", "--json"], client, write);
    await runOperatorCommand(["diagnostics", "export", "agent/one", "--json"], client, write);

    expect(urls[0]).toContain("/v1/agent-messages?afterCursor=4&beforeCursor=9&limit=10");
    expect(urls[1]).toBe("http://localhost:3210/v1/diagnostics?agentId=agent%2Fone");
  });

  it("does not hide a lost mutation outcome", async () => {
    const fetchFn = vi.fn(async () => { throw new TypeError("socket closed"); }) as unknown as typeof fetch;
    const client = new OperatorClient({ baseUrl: "http://localhost:3210", fetchFn });
    await expect(client.mutate("/v1/agent-messages", {}, "stable-key")).rejects.toMatchObject({
      name: "UnknownMutationOutcomeError",
      idempotencyKey: "stable-key",
      message: expect.stringContaining("UNKNOWN"),
    });
  });
});
