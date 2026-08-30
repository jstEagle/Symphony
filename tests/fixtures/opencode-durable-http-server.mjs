import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const hostnameArgument = process.argv.find((argument) => argument.startsWith("--hostname="));
const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
const hostname = hostnameArgument?.slice("--hostname=".length) || "127.0.0.1";
const port = Number(portArgument?.slice("--port=".length) || "4096");
const blockInitialPromptAcknowledgement = process.argv.includes("--block-initial-prompt-ack");
const sessionId = "fixture-opencode-session";
const eventClients = new Set();
const messages = [];
let status = "idle";
let turnOrdinal = 0;

if (process.env.SYMPHONY_OPENCODE_SERVICE_KEY) {
  throw new Error("The Symphony OpenCode service master must never reach the owned native child.");
}
const servicePassword = process.env.OPENCODE_SERVER_PASSWORD;
if (!servicePassword) throw new Error("The owned OpenCode fixture requires OPENCODE_SERVER_PASSWORD.");
const expectedAuthorization = `Basic ${Buffer.from(`opencode:${servicePassword}`, "utf8").toString("base64")}`;

appendFileSync(join(process.cwd(), ".fixture-opencode-server-launches"), `${process.pid}\n`);

function json(response, value, statusCode = 200) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function broadcast(event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const response of eventClients) response.write(frame);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.once("end", () => {
      try {
        resolve(body ? JSON.parse(body) : null);
      } catch (error) {
        reject(error);
      }
    });
    request.once("error", reject);
  });
}

function startTurn(body) {
  const turnId = `fixture-opencode-turn-${++turnOrdinal}`;
  const userMessageId = typeof body?.messageID === "string"
    ? body.messageID
    : `fixture-opencode-user-${turnOrdinal}`;
  const created = Date.now();
  messages.push({
    info: {
      id: userMessageId,
      sessionID: sessionId,
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "fixture", modelID: "fixture" },
    },
    parts: [{
      id: `fixture-opencode-user-part-${turnOrdinal}`,
      sessionID: sessionId,
      messageID: userMessageId,
      type: "text",
      text: String(body?.parts?.[0]?.text || ""),
    }],
  });
  appendFileSync(join(process.cwd(), ".fixture-opencode-native-dispatches"), `${turnId}\n`);
  status = "busy";
  broadcast({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
  setTimeout(() => {
    const assistantMessageId = `fixture-opencode-message-${turnOrdinal}`;
    const text = "Durable OpenCode worker completed after daemon adoption.";
    messages.push({
      info: {
        id: assistantMessageId,
        sessionID: sessionId,
        role: "assistant",
        parentID: userMessageId,
        time: { created: created + 1, completed: Date.now() },
        modelID: "fixture",
        providerID: "fixture",
        mode: "build",
        path: { cwd: process.cwd(), root: process.cwd() },
        cost: 0.001,
        tokens: { input: 8, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [{
        id: `fixture-opencode-text-${turnOrdinal}`,
        sessionID: sessionId,
        messageID: assistantMessageId,
        type: "text",
        text,
      }],
    });
    broadcast({
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        delta: text,
        part: {
          id: `fixture-opencode-text-${turnOrdinal}`,
          sessionID: sessionId,
          messageID: assistantMessageId,
          type: "text",
          text,
        },
      },
    });
  }, 4_000);
  setTimeout(() => {
    status = "idle";
    broadcast({ type: "session.idle", properties: { sessionID: sessionId } });
  }, 4_250);
}

const server = createServer(async (request, response) => {
  if (request.headers.authorization !== expectedAuthorization) {
    response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Basic" });
    return response.end(JSON.stringify({ error: "unauthorized" }));
  }
  const url = new URL(request.url || "/", `http://${hostname}:${port}`);
  if (request.method === "GET" && url.pathname === "/path") {
    return json(response, { directory: process.cwd() });
  }
  if (request.method === "GET" && url.pathname === "/mcp") return json(response, {});
  if (request.method === "POST" && url.pathname === "/mcp") {
    await readBody(request);
    return json(response, true);
  }
  if (request.method === "POST" && url.pathname === "/session") {
    await readBody(request);
    return json(response, { id: sessionId, title: "Durable OpenCode fixture" });
  }
  if (request.method === "GET" && url.pathname === "/session/status") {
    return json(response, { [sessionId]: { type: status } });
  }
  if (request.method === "GET" && url.pathname === `/session/${sessionId}`) {
    return json(response, { id: sessionId, title: "Durable OpenCode fixture" });
  }
  if (request.method === "GET" && url.pathname === `/session/${sessionId}/message`) {
    return json(response, messages);
  }
  if (request.method === "POST" && url.pathname === `/session/${sessionId}/prompt_async`) {
    const body = await readBody(request);
    startTurn(body);
    if (blockInitialPromptAcknowledgement && turnOrdinal === 1) {
      // Deliberately leave the HTTP request unresolved after the native server
      // has accepted and recorded exactly one dispatch. The daemon durability
      // test SIGKILLs its controller at this point to exercise the otherwise
      // tiny acceptance/checkpoint ambiguity window.
      return;
    }
    response.writeHead(204);
    return response.end();
  }
  if (request.method === "POST" && url.pathname === `/session/${sessionId}/abort`) {
    status = "idle";
    broadcast({ type: "session.idle", properties: { sessionID: sessionId } });
    return json(response, true);
  }
  if (request.method === "GET" && url.pathname === "/event") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(": fixture connected\n\n");
    eventClients.add(response);
    request.once("close", () => eventClients.delete(response));
    return;
  }
  return json(response, { error: `Unhandled fixture route: ${request.method} ${url.pathname}` }, 404);
});

server.listen(port, hostname, () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
  process.stdout.write(`opencode server listening on http://${hostname}:${address.port}\n`);
});

function close() {
  for (const response of eventClients) response.end();
  server.close(() => process.exit(0));
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
