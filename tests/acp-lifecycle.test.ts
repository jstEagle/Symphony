import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpDriver } from "../packages/drivers/src/acp.js";
import type { DriverEvent, DriverSession, DriverStartRequest } from "../packages/protocol/src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function request(): DriverStartRequest {
  return {
    agentId: "acp-agent",
    resolvedModel: "acp/fixture",
    workOrder: {
      workflowId: "acp-workflow",
      runId: "acp-run",
      parentAgentId: null,
      depth: 1,
      mission: { id: "acp-mission", revision: 1, hash: "12345678", statement: "Exercise ACP lifecycle handling.", keyResults: [] },
      objective: "Return a lifecycle test result.",
      model: "acp/fixture",
      harness: "acp",
      permissions: "read-only",
      outputSchema: {},
      inputs: [],
      workspace: { path: process.cwd(), dirtyPolicy: "local-only" },
      metadata: {},
    },
    coordination: {
      daemonUrl: "http://127.0.0.1:3210",
      token: "test-token",
      mcpCommand: process.execPath,
      mcpArgs: ["-e", "process.exit(0)"],
      canCreate: false,
      maxDepth: 1,
    },
  };
}

function driver(script: string, ...args: string[]): AcpDriver {
  return new AcpDriver([{
    id: "fixture",
    enabled: true,
    process: { command: process.execPath, args: ["-e", script, ...args] },
  }]);
}

function fixtureAgent(onNew: string, onPrompt: string): string {
  return String.raw`
const readline = require("node:readline");
const reply = (message, result, error) => {
  const response = error
    ? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error } }
    : { jsonrpc: "2.0", id: message.id, result };
  process.stdout.write(JSON.stringify(response) + "\n");
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message, { protocolVersion: message.params.protocolVersion });
  else if (message.method === "session/new") { ${onNew} }
  else if (message.method === "session/prompt") { ${onPrompt} }
  else if (message.id !== undefined) reply(message, {});
});
`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for ACP lifecycle evidence");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ACP process supervision", () => {
  it("rejects a spawn failure instead of leaving initialization pending", async () => {
    const unavailable = new AcpDriver([{
      id: "fixture",
      enabled: true,
      process: { command: `missing-acp-${Date.now()}`, args: [] },
    }]);

    await expect(unavailable.start(request(), () => undefined)).rejects.toThrow();
    await expect(unavailable.dispose()).resolves.toBeUndefined();
  });

  it("rejects an ACP child that exits before initialization completes", async () => {
    const events: DriverEvent[] = [];
    const subject = driver("process.exit(9)");

    await expect(subject.start(request(), (event) => events.push(event))).rejects.toThrow(/ACP (?:process exited|connection closed)/u);
    expect(events.filter((event) => event.kind === "run.failed")).toHaveLength(0);
    await expect(subject.dispose()).resolves.toBeUndefined();
  });

  it("terminates a partially initialized process when session creation fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-acp-"));
    temporary.push(directory);
    const marker = join(directory, "terminated");
    const script = String.raw`
const fs = require("node:fs");
const marker = process.argv[1];
process.on("SIGTERM", () => {
  fs.writeFileSync(marker, "terminated");
  process.exit(0);
});
${fixtureAgent('reply(message, undefined, "session refused")', "reply(message, { stopReason: \"end_turn\" })")}
`;
    const subject = driver(script, marker);

    await expect(subject.start(request(), () => undefined)).rejects.toThrow("session refused");
    await waitFor(() => existsSync(marker));
    await expect(subject.dispose()).resolves.toBeUndefined();
  });

  it("emits one terminal failure when the ACP child exits during a prompt", async () => {
    const events: DriverEvent[] = [];
    const script = fixtureAgent(
      'reply(message, { sessionId: "fixture-session" })',
      "setTimeout(() => process.exit(17), 20)",
    );
    const subject = driver(script);
    const session = await subject.start(request(), (event) => events.push(event));

    await waitFor(() => events.some((event) => event.kind === "run.failed"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(events.filter((event) => event.kind === "run.failed")).toHaveLength(1);
    await expect(subject.sendMessage(session, "retry")).rejects.toThrow("ACP session is not active");
    await expect(subject.dispose()).resolves.toBeUndefined();
  });

  it("makes normal disposal and forced termination idempotent without failure events", async () => {
    const events: DriverEvent[] = [];
    const script = fixtureAgent(
      'reply(message, { sessionId: "fixture-session" })',
      'reply(message, { stopReason: "end_turn" })',
    );
    const subject = driver(script);
    const session: DriverSession = await subject.start(request(), (event) => events.push(event));
    await waitFor(() => events.some((event) => event.kind === "run.completed"));

    await expect(subject.forceTerminate(session)).resolves.toBeUndefined();
    await expect(subject.forceTerminate(session)).resolves.toBeUndefined();
    await expect(subject.dispose()).resolves.toBeUndefined();
    await expect(subject.dispose()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(events.filter((event) => event.kind === "run.failed")).toHaveLength(0);
  });
});
