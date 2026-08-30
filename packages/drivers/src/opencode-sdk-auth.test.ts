import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe("OpenCode SDK Basic authentication", () => {
  it("attaches a static Authorization header to ordinary HTTP and SSE requests", async () => {
    const authorization = `Basic ${Buffer.from("opencode:per-agent-password", "utf8").toString("base64")}`;
    const requests: Array<{ path: string; authorization: string | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
      if (request.headers.authorization !== authorization) {
        response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Basic" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (request.url?.startsWith("/event")) {
        response.writeHead(200, {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
          connection: "keep-alive",
        });
        response.end('data: {"type":"server.connected","properties":{}}\n\n');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ directory: "/tmp/opencode-auth-test" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      headers: { Authorization: authorization },
    });

    const path = await client.path.get();
    expect(path.data).toEqual({ directory: "/tmp/opencode-auth-test" });

    const subscription = await client.event.subscribe({ sseMaxRetryAttempts: 0 });
    const event = await subscription.stream.next();
    expect(event.value).toMatchObject({ type: "server.connected" });
    await subscription.stream.return?.(undefined);

    expect(requests).toEqual([
      { path: "/path", authorization },
      { path: "/event", authorization },
    ]);
  });
});
