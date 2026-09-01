import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

// A deterministic Codex app-server-shaped child. It deliberately keeps the
// native turn alive long enough for the parent test to kill only the daemon;
// the worker-host then spools the remaining frames for a replacement daemon.
const root = process.cwd();
const seed = Number.parseInt(process.env.SYMPHONY_PROCESS_CRASH_SEED ?? "1", 10) || 1;
const delayMs = 650 + (Math.abs(seed) % 5) * 80;
const threadId = `process-crash-thread-${seed}`;
let turnOrdinal = 0;

function append(name, value) {
  appendFileSync(join(root, name), `${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function runTurn(id) {
  const turnId = `process-crash-turn-${++turnOrdinal}`;
  append(".process-crash-dispatches", { id, turnId, seed });
  respond(id, { turn: { id: turnId, status: "inProgress" } });
  const chunks = ["process ", "boundary ", "work ", "continued ", "after ", "restart."];
  chunks.forEach((text, index) => {
    setTimeout(() => send({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: `process-crash-message-${turnId}`, delta: text },
    }), delayMs + index * 60);
  });
  setTimeout(() => send({
    jsonrpc: "2.0",
    method: "tokenUsage/updated",
    params: { threadId, usage: { input_tokens: 13, output_tokens: 9 } },
  }), delayMs + chunks.length * 60 + 30);
  setTimeout(() => send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: { id: `process-crash-message-${turnId}`, type: "agentMessage", phase: "final", text: chunks.join("") },
    },
  }), delayMs + chunks.length * 60 + 70);
  setTimeout(() => send({
    jsonrpc: "2.0",
    method: "thread/status/changed",
    params: { threadId, status: { type: "idle" } },
  }), delayMs + chunks.length * 60 + 100);
  setTimeout(() => send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: "completed" } },
  }), delayMs + chunks.length * 60 + 130);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id == null || typeof message.method !== "string") return;
  if (message.method === "initialize") return respond(message.id, { capabilities: {} });
  if (message.method === "model/list") {
    return respond(message.id, { models: [{ id: "fixture", name: "Process crash fixture", description: "Test-only native boundary." }] });
  }
  if (message.method === "thread/start") {
    append(".process-crash-thread-starts", threadId);
    return respond(message.id, { thread: { id: threadId } });
  }
  if (message.method === "thread/resume") {
    append(".process-crash-forbidden-resumes", message.params?.threadId ?? "missing");
    return respond(message.id, { thread: { id: threadId, turns: [] } });
  }
  if (message.method === "turn/start") return runTurn(message.id);
  if (message.method === "turn/interrupt") return respond(message.id, {});
  if (message.method === "turn/steer") {
    // This marker is evidence that the side effect reached the native
    // boundary. No terminal response is emitted for the steer itself; if the
    // daemon dies here, the replacement must keep the outcome unknown.
    append(".process-crash-steers", message.params?._meta ?? {});
    return respond(message.id, {});
  }
  return respond(message.id, {});
});
