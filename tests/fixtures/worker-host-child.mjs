import readline from "node:readline";

const executions = new Map();
const reusedServerRequestId = "fixture-reused-server-request";
const reusedServerResponses = [];

process.stdout.write(`${JSON.stringify({ type: "fixture.ready", pid: process.pid })}\n`);

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (
    message.jsonrpc === "2.0"
    && message.id === reusedServerRequestId
    && typeof message.method !== "string"
  ) {
    reusedServerResponses.push({
      result: message.result ?? null,
      error: message.error ?? null,
    });
    if (reusedServerResponses.length === 2) {
      process.stdout.write(`${JSON.stringify({
        type: "fixture.reused-server-responses",
        responses: reusedServerResponses,
        pid: process.pid,
      })}\n`);
    }
    return;
  }
  if (message.jsonrpc === "2.0" && message.id != null && typeof message.method === "string") {
    if (message.method === "fixture/delayed-response") {
      const count = (executions.get(message.id) ?? 0) + 1;
      executions.set(message.id, count);
      process.stdout.write(`${JSON.stringify({
        type: "fixture.request-accepted",
        requestId: message.id,
        pid: process.pid,
      })}\n`);
      const delayMs = Number.isSafeInteger(message.params?.delayMs) ? message.params.delayMs : 100;
      setTimeout(() => {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            method: message.method,
            params: message.params ?? null,
            pid: process.pid,
            count,
          },
        })}\n`);
      }, delayMs);
      return;
    }
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        method: message.method,
        params: message.params ?? null,
        pid: process.pid,
        daemonSecretPresent: Object.hasOwn(process.env, "SYMPHONY_DAEMON_SECRET"),
      },
    })}\n`);
    if (message.method === "fixture/request-reused-server-id") {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: reusedServerRequestId,
        method: "fixture/server-question-one",
        params: { ordinal: 1 },
      })}\n`);
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: reusedServerRequestId,
        method: "fixture/server-question-two",
        params: { ordinal: 2 },
      })}\n`);
    }
    return;
  }
  const id = typeof message.id === "string" ? message.id : "anonymous";
  const count = (executions.get(id) ?? 0) + 1;
  executions.set(id, count);

  if (message.type === "spam") {
    const bytes = Number.isSafeInteger(message.bytes) ? message.bytes : 4_096;
    process.stdout.write(`${"x".repeat(bytes)}\n`);
    return;
  }

  if (message.type === "spam-unterminated") {
    const bytes = Number.isSafeInteger(message.bytes) ? message.bytes : 4_096;
    process.stdout.write("x".repeat(bytes));
    return;
  }

  const delayMs = Number.isSafeInteger(message.delayMs) ? message.delayMs : 0;
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({
      type: "fixture.output",
      id,
      text: message.text,
      count,
      pid: process.pid,
    })}\n`);
  }, delayMs);
});
