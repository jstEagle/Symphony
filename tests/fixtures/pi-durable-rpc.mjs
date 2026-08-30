import { appendFileSync } from "node:fs";
import { join } from "node:path";

const fixtureRootIndex = process.argv.indexOf("--fixture-root");
const fixtureRoot = fixtureRootIndex >= 0 && process.argv[fixtureRootIndex + 1]
  ? process.argv[fixtureRootIndex + 1]
  : process.cwd();
const providerError = process.argv.includes("--provider-error");
const sessionId = `fixture-pi-session-${process.pid}`;
const sessionFile = join(fixtureRoot, ".fixture-pi-session.jsonl");
let inputBuffer = "";
let running = false;
let turnOrdinal = 0;
let launchRecorded = false;

function recordLaunch() {
  if (launchRecorded) return;
  launchRecorded = true;
  appendFileSync(join(fixtureRoot, ".fixture-pi-launches"), `${process.pid}\n`);
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(message, success, data = undefined, error = undefined) {
  send({
    id: message.id,
    type: "response",
    command: message.type,
    success,
    ...(data === undefined ? {} : { data }),
    ...(error === undefined ? {} : { error }),
  });
}

function runTurn(message) {
  const ordinal = ++turnOrdinal;
  const turnId = `fixture-pi-turn-${ordinal}`;
  const text = `Durable Pi worker completed turn ${ordinal} after daemon adoption.`;
  appendFileSync(join(fixtureRoot, ".fixture-pi-native-dispatches"), `${turnId}\n`);
  running = true;
  respond(message, true);
  send({ type: "agent_start" });
  if (providerError) {
    const assistant = {
      role: "assistant",
      content: [],
      provider: "fixture-provider",
      model: "fixture-batch-only",
      stopReason: "error",
      errorMessage: "404: fixture model is only available through the Batch API",
      usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
    };
    send({ type: "message_end", message: assistant });
    send({ type: "agent_end", messages: [{ role: "user", content: [] }, assistant], willRetry: false });
    running = false;
    send({ type: "agent_settled" });
    return;
  }
  setTimeout(() => send({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text.slice(0, 20) },
    usage: {
      input: 8,
      output: 3,
      totalTokens: 11,
      cost: { input: 0.0001, output: 0.0002, total: 0.0003 },
    },
  }), 900);
  setTimeout(() => send({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text.slice(20) },
    usage: {
      input: 8,
      output: 7,
      totalTokens: 15,
      cost: { input: 0.0001, output: 0.0004, total: 0.0005 },
    },
  }), 2_400);
  setTimeout(() => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: {
        input: 8,
        output: 7,
        totalTokens: 15,
        cost: { input: 0.0001, output: 0.0004, total: 0.0005 },
      },
    };
    send({ type: "message_end", message: assistant });
    send({ type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: String(message.message ?? "") }] }, assistant], willRetry: false });
    running = false;
    send({ type: "agent_settled" });
  }, 4_000);
}

function handle(message) {
  if (!message || typeof message !== "object" || typeof message.type !== "string") return;
  // Model discovery intentionally uses a short-lived Pi process. Keep that
  // probe out of the durable native-launch ledger used by crash tests.
  if (message.type !== "get_available_models") recordLaunch();
  if (message.type === "get_state") {
    return respond(message, true, {
      isStreaming: running,
      sessionId,
      sessionFile,
      messageCount: turnOrdinal * 2,
      pendingMessageCount: 0,
    });
  }
  if (message.type === "prompt") {
    if (running) return respond(message, false, undefined, "fixture already streaming");
    return runTurn(message);
  }
  if (message.type === "steer") return respond(message, true);
  if (message.type === "abort") {
    running = false;
    respond(message, true);
    return send({ type: "agent_settled" });
  }
  if (message.type === "switch_session") {
    appendFileSync(join(fixtureRoot, ".fixture-pi-forbidden-switch"), `${String(message.sessionPath ?? "unknown")}\n`);
    return respond(message, true, { cancelled: false });
  }
  if (message.type === "get_available_models") {
    return respond(message, true, { models: [{ provider: "fixture", id: "fixture", name: "Fixture" }] });
  }
  respond(message, false, undefined, `unsupported fixture command: ${message.type}`);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  while (true) {
    const newline = inputBuffer.indexOf("\n");
    if (newline < 0) break;
    let line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
