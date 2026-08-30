import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const threadId = `fixture-thread-${process.pid}`;
const blockInitialTurnAcknowledgement = process.argv.includes("--block-initial-turn-ack");
let turnOrdinal = 0;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function runTurn(id) {
  const turnId = `fixture-turn-${++turnOrdinal}`;
  appendFileSync(join(process.cwd(), ".fixture-native-dispatches"), `${turnId}\n`);
  const begin = () => {
    respond(id, { turn: { id: turnId, status: "inProgress" } });
    const chunks = ["Durable ", "worker ", "continued ", "while ", "the ", "daemon ", "was ", "gone."];
    chunks.forEach((text, index) => {
      setTimeout(() => send({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: "fixture-message", delta: text },
      }), 250 + index * 180);
    });
    setTimeout(() => send({
      jsonrpc: "2.0",
      method: "tokenUsage/updated",
      params: { threadId, usage: { input_tokens: 12, output_tokens: 8 } },
    }), 1_500);
    setTimeout(() => send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: "fixture-message", type: "agentMessage", phase: "final", text: chunks.join("") },
      },
    }), 1_750);
    setTimeout(() => send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    }), 1_900);
  };
  if (!blockInitialTurnAcknowledgement || turnOrdinal !== 1) return begin();
  const releasePath = join(process.cwd(), ".fixture-release-initial-turn-ack");
  const release = setInterval(() => {
    if (!existsSync(releasePath)) return;
    clearInterval(release);
    begin();
  }, 20);
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id == null || typeof message.method !== "string") return;
  if (message.method === "initialize") return respond(message.id, { capabilities: {} });
  if (message.method === "model/list") {
    return respond(message.id, { models: [{ id: "fixture", name: "Durable fixture", description: "Test-only Codex app-server." }] });
  }
  if (message.method === "thread/start") {
    appendFileSync(join(process.cwd(), ".fixture-native-thread-starts"), `${threadId}\n`);
    return respond(message.id, { thread: { id: threadId } });
  }
  if (message.method === "turn/start") return runTurn(message.id);
  if (message.method === "turn/interrupt") return respond(message.id, {});
  if (message.method === "turn/steer") return respond(message.id, {});
  if (message.method === "thread/resume") {
    appendFileSync(join(process.cwd(), ".fixture-forbidden-resume"), "thread/resume\n");
    return respond(message.id, { thread: { id: threadId, turns: [] } });
  }
  respond(message.id, {});
});
