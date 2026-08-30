#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const fixtureRootIndex = process.argv.indexOf("--fixture-root");
const fixtureRoot = fixtureRootIndex >= 0 && process.argv[fixtureRootIndex + 1]
  ? process.argv[fixtureRootIndex + 1]
  : process.cwd();
const resumeArgument = process.argv.find((argument) => argument.startsWith("--resume="));
const blockInitialAcceptance = process.argv.includes("--block-initial-acceptance") && !resumeArgument;
const sessionId = resumeArgument?.slice("--resume=".length) || "fixture-claude-session";
let buffer = "";
let turn = 0;
let running = false;
const pending = [];
const timers = new Set();

appendFileSync(join(fixtureRoot, ".fixture-claude-native-launches"), `${process.pid}\n`);
appendFileSync(join(fixtureRoot, ".fixture-claude-native-sessions"), `${sessionId}\n`);
appendFileSync(join(fixtureRoot, ".fixture-claude-native-argv"), `${JSON.stringify(process.argv.slice(2))}\n`);
appendFileSync(join(fixtureRoot, ".fixture-claude-debug-env"), `${process.env.DEBUG_CLAUDE_AGENT_SDK ?? "<unset>"}\n`);
appendFileSync(join(fixtureRoot, ".fixture-claude-token-env"), `${process.env.SYMPHONY_AGENT_TOKEN ? "present" : "missing"}\n`);
const emitSensitiveStderr = process.argv.includes("--emit-sensitive-stderr");
const hangInterrupt = process.argv.includes("--hang-interrupt");
if (hangInterrupt) setInterval(() => undefined, 60_000);

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function handle(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "control_request" && message.request_id) {
    if (message.request?.subtype === "interrupt") {
      if (hangInterrupt) return;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      pending.length = 0;
      running = false;
    }
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: message.request?.subtype === "initialize"
          ? { protocolVersion: 1, commands: [], output_style: "default" }
          : {},
      },
    });
    return;
  }
  if (message.type !== "user") return;
  pending.push(message);
  dispatchNext();
}

function dispatchNext() {
  if (running || pending.length === 0) return;
  pending.shift();
  running = true;
  turn += 1;
  if (emitSensitiveStderr && turn === 1) {
    process.stderr.write(`fixture debug capability=${process.env.SYMPHONY_AGENT_TOKEN ?? "<missing>"}\n`);
    process.stderr.write(`fixture provider credential=${process.env.ANTHROPIC_API_KEY ?? "<missing>"}\n`);
    process.stderr.write(`fixture oauth credential=${process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "<missing>"}\n`);
    process.stderr.write(`fixture aws credential=${process.env.AWS_SECRET_ACCESS_KEY ?? "<missing>"}\n`);
    process.stderr.write(`fixture generic credential=${process.env.FIXTURE_DATABASE_PASSWORD ?? "<missing>"}\n`);
    process.stderr.write(`fixture pg credential=${process.env.PGPASSWORD ?? "<missing>"}\n`);
    process.stderr.write(`fixture pg credential concatenated=x${process.env.PGPASSWORD ?? "<missing>"}x\n`);
    process.stderr.write(`fixture database url=${process.env.DATABASE_URL ?? "<missing>"}\n`);
    process.stderr.write(`fixture redis credential=${process.env.REDISCLI_AUTH ?? "<missing>"}\n`);
    process.stderr.write(`fixture redis credential concatenated=x${process.env.REDISCLI_AUTH ?? "<missing>"}x\n`);
    process.stderr.write(`fixture github credential=${process.env.GITHUB_PAT ?? "<missing>"}\n`);
    process.stderr.write(`fixture embedded connection=${process.env.FIXTURE_CONNECTION_URL ?? "<missing>"}\n`);
    // No writes may interpose between these halves: this proves the host can
    // redact a credential split across native stream chunks on one line.
    const splitProviderCredential = process.env.ANTHROPIC_API_KEY ?? "<missing>";
    const splitAt = Math.max(1, Math.floor(splitProviderCredential.length / 2));
    process.stderr.write(`fixture split provider credential=${splitProviderCredential.slice(0, splitAt)}`);
    setTimeout(() => process.stderr.write(`${splitProviderCredential.slice(splitAt)}\n`), 10);
  }
  const turnId = `fixture-claude-turn-${turn}`;
  const text = `Durable Claude SDK host completed turn ${turn}.`;
  appendFileSync(join(fixtureRoot, ".fixture-claude-native-dispatches"), `${turnId}\n`);
  if (blockInitialAcceptance && turn === 1) {
    const releasePath = join(fixtureRoot, ".fixture-claude-release-initial-acceptance");
    const timer = setInterval(() => {
      if (!existsSync(releasePath)) return;
      clearInterval(timer);
      timers.delete(timer);
      emitTurn(turnId, turn, text);
    }, 20);
    timers.add(timer);
    return;
  }
  emitTurn(turnId, turn, text);
}

function emitTurn(turnId, turn, text) {
  send({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
    model: "fixture",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    apiKeySource: "none",
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: `${turnId}-init`,
  });
  schedule(() => send({
    type: "tool_progress",
    tool_use_id: `${turnId}-tool`,
    tool_name: "FixtureTool",
    elapsed_time_seconds: 1,
    parent_tool_use_id: null,
    uuid: `${turnId}-tool-progress-1`,
    session_id: sessionId,
  }), 1_000);
  schedule(() => send({
    type: "tool_progress",
    tool_use_id: `${turnId}-tool`,
    tool_name: "FixtureTool",
    elapsed_time_seconds: 2,
    parent_tool_use_id: null,
    uuid: `${turnId}-tool-progress-2`,
    session_id: sessionId,
  }), 1_400);
  schedule(() => send({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, 18) } },
    parent_tool_use_id: null,
    uuid: `${turnId}-delta-1`,
    session_id: sessionId,
  }), 600);
  schedule(() => send({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(18) } },
    parent_tool_use_id: null,
    uuid: `${turnId}-delta-2`,
    session_id: sessionId,
  }), 1_600);
  if (emitSensitiveStderr) {
    const secret = process.env.ANTHROPIC_API_KEY ?? "<missing>";
    schedule(() => send({
      type: "assistant",
      message: {
        id: `${turnId}-sensitive-tool-message`,
        type: "message",
        role: "assistant",
        content: [{
          type: "tool_use",
          id: `${turnId}-sensitive-tool`,
          name: "SensitiveFixtureTool",
          input: { id: secret, type: secret, state: secret, method: secret, [secret]: "secret-key-value" },
        }],
      },
      parent_tool_use_id: null,
      uuid: `${turnId}-sensitive-tool-assistant`,
      session_id: sessionId,
    }), 1_800);
    schedule(() => send({
      type: "user",
      message: {
        id: `${turnId}-sensitive-result-message`,
        type: "message",
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `${turnId}-sensitive-tool`, content: "fixture" }],
      },
      tool_use_result: { id: secret, type: secret, state: secret, method: secret, [secret]: "secret-key-value" },
      parent_tool_use_id: null,
      uuid: `${turnId}-sensitive-tool-result`,
      session_id: sessionId,
    }), 2_000);
  }
  schedule(() => send({
    type: "assistant",
    message: { id: `${turnId}-message`, type: "message", role: "assistant", content: [{ type: "text", text }], model: "fixture", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 8, output_tokens: 7 } },
    parent_tool_use_id: null,
    uuid: `${turnId}-assistant`,
    session_id: sessionId,
  }), 2_400);
  schedule(() => {
    send({
      type: "result",
      subtype: "success",
      duration_ms: 3_200,
      duration_api_ms: 3_000,
      is_error: false,
      num_turns: 1,
      result: text,
      stop_reason: "end_turn",
      total_cost_usd: 0.0005,
      usage: { input_tokens: 8, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: `${turnId}-result`,
      session_id: sessionId,
    });
    running = false;
    dispatchNext();
  }, 3_200);
}

function schedule(callback, delay) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    callback();
  }, delay);
  timers.add(timer);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).replace(/\r$/u, "");
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => { if (!hangInterrupt) process.exit(0); });
