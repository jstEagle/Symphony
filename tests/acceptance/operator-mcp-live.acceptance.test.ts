import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "../../apps/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../apps/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { createStore } from "../../packages/storage/src/index.js";

const repositoryRoot = resolve(".");
const daemonRunner = resolve("tests/fixtures/daemon-process.ts");
const cliEntry = resolve("apps/cli/src/index.ts");
const mcpEntry = resolve("apps/mcp/src/index.ts");
const tsx = resolve("node_modules/.bin/tsx");
const daemonSecret = "4f".repeat(32);
const temporary: string[] = [];
const daemons = new Set<ChildProcess>();
const mcpClients = new Set<Client>();
const mcpTransports = new Set<StdioClientTransport>();

type JsonRecord = Record<string, any>;
type StartedDaemon = { child: ChildProcess; pid: number };

afterEach(async () => {
  for (const client of mcpClients) await client.close().catch(() => undefined);
  mcpClients.clear();
  for (const transport of mcpTransports) await transport.close().catch(() => undefined);
  mcpTransports.clear();
  for (const daemon of daemons) {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
  }
  await Promise.all([...daemons].map(waitForExit));
  daemons.clear();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate acceptance port."));
      server.close(() => resolvePort(address.port));
    });
  });
}

function writeConfig(root: string, dataDirectory: string, port: number): string {
  const configPath = join(root, "acceptance.config.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    dataDirectory,
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 300 },
    conductor: { harness: "codex", model: "fixture" },
    agents: {
      maxDepth: null,
      maxConcurrent: 2,
      defaultPermissions: "full-access",
      startupTimeoutMs: 500,
      recoveryTimeoutMs: 500,
      recoveryConcurrency: 1,
      cancellationAcknowledgementTimeoutMs: 100,
      cancellationTerminationGraceMs: 100,
    },
    workerHosts: { enabled: false, maxSpoolBytes: 1_048_576, maxSpoolFrames: 1_000 },
    harnesses: {
      codex: { enabled: false },
      claude: { enabled: false },
      cursor: { enabled: false },
      opencode: { enabled: false },
      pi: { enabled: false },
      acp: [],
    },
    router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
    observer: { provider: "deterministic" },
    uiUtilities: { provider: "deterministic", chatTitles: false },
    plugins: { watch: false },
    workflows: { directory: join(root, "workflows"), triggersEnabled: false, approvalExpiryScanMs: 100 },
  }));
  return configPath;
}

async function startDaemonProcess(configPath: string): Promise<StartedDaemon> {
  const child = spawn(tsx, ["--tsconfig", resolve("tsconfig.json"), daemonRunner, configPath, repositoryRoot], {
    cwd: repositoryRoot,
    env: { ...process.env, SYMPHONY_DAEMON_SECRET: daemonSecret },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemons.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const pid = await new Promise<number>((resolveReady, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Acceptance daemon did not become ready. ${stderr}`));
    }, 10_000);
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/u)) {
        if (!line.includes('"type":"ready"')) continue;
        try {
          const ready = JSON.parse(line) as { type?: string; pid?: number };
          if (ready.type !== "ready" || !ready.pid || settled) continue;
          settled = true;
          clearTimeout(timer);
          resolveReady(ready.pid);
          return;
        } catch {
          // Wait for a complete JSON line.
        }
      }
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Acceptance daemon exited before readiness (code=${String(code)}, signal=${String(signal)}). ${stderr}`));
    });
  });
  return { child, pid };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

async function waitFor(assertion: () => unknown | Promise<unknown>, timeout = 10_000): Promise<void> {
  await vi.waitFor(assertion, { timeout, interval: 40 });
}

async function waitForHealth(base: string): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "ready" });
  });
}

async function request(base: string, path: string, init: RequestInit = {}): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { response, body };
}

async function stopDaemon(daemon: StartedDaemon): Promise<void> {
  if (daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill("SIGTERM");
  await waitForExit(daemon.child);
}

function cli(configPath: string, args: string[]): Promise<JsonRecord | any[]> {
  return new Promise((resolveCli, rejectCli) => {
    const child = spawn(tsx, ["--tsconfig", resolve("tsconfig.json"), cliEntry, ...args, "--config", configPath, "--json"], {
      cwd: repositoryRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectCli(new Error(`CLI timed out: ${stderr}`));
    }, 10_000);
    child.once("error", (error) => { clearTimeout(timer); rejectCli(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) return rejectCli(new Error(`CLI failed (code=${String(code)}, signal=${String(signal)}): ${stderr || stdout}`));
      try { resolveCli(JSON.parse(stdout.trim()) as JsonRecord | any[]); }
      catch (error) { rejectCli(new Error(`CLI returned invalid JSON: ${stdout}; ${String(error)}`)); }
    });
  });
}

async function connectMcp(base: string, agentId: string, token: string): Promise<Client> {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: tsx,
    args: ["--tsconfig", resolve("tsconfig.json"), mcpEntry],
    env: { ...environment, SYMPHONY_DAEMON_URL: base, SYMPHONY_AGENT_ID: agentId, SYMPHONY_AGENT_TOKEN: token, SYMPHONY_AGENT_CAN_CREATE: "true" },
    stderr: "pipe",
  });
  const client = new Client({ name: "operator-mcp-live-acceptance", version: "1.0.0" });
  mcpTransports.add(transport);
  mcpClients.add(client);
  await client.connect(transport);
  return client;
}

async function callTool(client: Client, name: string, args: JsonRecord = {}): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(`${name} failed: ${JSON.stringify(response)}`);
  // The MCP result helper wraps arrays/primitives in `{ value }` for the
  // structured-content channel. The text channel retains the exact daemon
  // payload, so decode that to keep assertions transport-shape independent.
  return JSON.parse((response.content?.[0] as { text: string }).text);
}

function agentWorkOrder(root: string): JsonRecord {
  return {
    id: "operator-mcp-acceptance-agent",
    workflowId: "operator-mcp-acceptance-workflow",
    runId: "operator-mcp-acceptance-run",
    parentAgentId: null,
    depth: 0,
    mission: { id: "operator-mcp-acceptance-mission", revision: 1, hash: "operator-mcp-acceptance-hash", statement: "Exercise live operator and MCP surfaces.", keyResults: [] },
    objective: "Remain available for the operator/MCP acceptance test.",
    model: "fixture",
    harness: "codex",
    permissions: "full-access",
    outputSchema: {},
    inputs: [],
    workspace: { path: root, dirtyPolicy: "local-only" },
    metadata: {},
  };
}

function capability(id: string): JsonRecord {
  return {
    capabilityId: id,
    definition: {
      name: "Live acceptance capability",
      description: "A capability registered through a real client boundary.",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      defaults: { harness: "codex", model: "fixture", permission: "read-only" },
    },
    provenance: { source: "operator-mcp-live-acceptance", revision: "1" },
  };
}

function message(senderId: string, runId: string, summary: string): JsonRecord {
  return {
    kind: "status",
    senderId,
    recipientId: "operator-mcp-acceptance-recipient",
    parentId: null,
    parentAgentId: null,
    objectiveId: null,
    runId,
    attemptId: null,
    correlationId: null,
    replyToId: null,
    payload: { source: "live-acceptance", summary },
    summary,
    artifactRefs: [],
    evidenceRefs: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: null,
  };
}

describe("live operator CLI and MCP acceptance", () => {
  it("drives real daemon HTTP paths and retains state, receipts, replay, and idempotency across restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-operator-mcp-live-"));
    temporary.push(root);
    const dataDirectory = join(root, "data");
    const port = await availablePort();
    const configPath = writeConfig(root, dataDirectory, port);

    // On macOS the daemon normally creates its credential in Keychain. Seed
    // the legacy compatibility value in this test-only SQLite directory so
    // both daemon generations use a known, isolated credential and token.
    const seed = createStore(dataDirectory);
    seed.setMetadata("daemon-secret", daemonSecret);
    seed.close();

    const first = await startDaemonProcess(configPath);
    const base = `http://127.0.0.1:${port}`;
    await waitForHealth(base);
    const createdAgent = await request(base, "/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "operator-mcp:agent:create" },
      body: JSON.stringify(agentWorkOrder(root)),
    });
    expect(createdAgent.response.status).toBe(202);
    const agentId = String(createdAgent.body.id);
    const agentToken = createHmac("sha256", daemonSecret).update(agentId).digest("hex");
    const firstMcp = await connectMcp(base, agentId, agentToken);
    const cliCapability = capability("acceptance.cli-capability");
    const cliCreate = await cli(configPath, ["capability", "create", "--body", JSON.stringify(cliCapability), "--idempotency-key", "acceptance:cli:capability:create"]);
    expect(cliCreate).toMatchObject({ status: "committed" });
    expect(await cli(configPath, ["capability", "list"])).toEqual(expect.arrayContaining([expect.objectContaining({ capabilityId: cliCapability.capabilityId })]));
    expect(await cli(configPath, ["capability", "activate", String(cliCapability.capabilityId), "1", "--body", "{}", "--idempotency-key", "acceptance:cli:capability:activate"])).toMatchObject({ status: "committed" });
    expect(await cli(configPath, ["capability", "prepare", String(cliCapability.capabilityId), "1", "--body", JSON.stringify({ parameters: { value: "cli" } })])).toMatchObject({ compatible: true, parameters: { value: "cli" } });

    const cliMessage = message("local-user", String(createdAgent.body.runId), "CLI message");
    const cliSent = await cli(configPath, ["messages", "send", "--body", JSON.stringify(cliMessage), "--idempotency-key", "acceptance:cli:message:send"]);
    expect(cliSent).toMatchObject({ status: "committed", message: { id: expect.any(String) } });
    expect(await cli(configPath, ["messages", "list", "--recipient-id", "operator-mcp-acceptance-recipient"])).toEqual(expect.objectContaining({ messages: expect.arrayContaining([expect.objectContaining({ summary: "CLI message" })]) }));

    expect((await cli(configPath, ["diagnostics", "export", agentId]))).toMatchObject({ identity: { agentId } });
    const exportedDiagnostics = await request(base, `/v1/agents/${encodeURIComponent(agentId)}/diagnostics/export`);
    expect(exportedDiagnostics.response.status).toBe(200);
    expect(exportedDiagnostics.response.headers.get("content-disposition")).toContain("attachment");
    expect(exportedDiagnostics.body).toMatchObject({ identity: { agentId } });

    const listed = await callTool(firstMcp, "list_capabilities");
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ capabilityId: cliCapability.capabilityId })]));
    const mcpCapability = capability("acceptance.mcp-capability");
    expect(await callTool(firstMcp, "create_capability", mcpCapability)).toMatchObject({ status: "committed" });
    expect(await callTool(firstMcp, "activate_capability", { capabilityId: mcpCapability.capabilityId, version: 1 })).toMatchObject({ status: "committed" });
    expect(await callTool(firstMcp, "prepare_capability_execution", { capabilityId: mcpCapability.capabilityId, version: 1, parameters: { value: "mcp" } })).toMatchObject({ compatible: true, parameters: { value: "mcp" } });

    const firstMessage = await callTool(firstMcp, "send_agent_message", message(agentId, String(createdAgent.body.runId), "MCP delivered message"));
    const firstMessageId = String(firstMessage.message.id);
    const secondMessage = await callTool(firstMcp, "send_agent_message", message(agentId, String(createdAgent.body.runId), "MCP cancelled message"));
    const secondMessageId = String(secondMessage.message.id);
    expect((await callTool(firstMcp, "replay_agent_messages", { afterCursor: 0 })).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: firstMessageId }), expect.objectContaining({ id: secondMessageId })]));
    expect(await callTool(firstMcp, "deliver_agent_message", { messageId: firstMessageId, state: "delivered" })).toMatchObject({ status: "committed" });
    expect((await callTool(firstMcp, "get_agent_message", { messageId: firstMessageId })).state).toBe("delivered");
    expect(await callTool(firstMcp, "cancel_agent_message", { messageId: secondMessageId, reason: "Acceptance cancellation" })).toMatchObject({ status: "committed" });
    expect((await callTool(firstMcp, "get_agent_message", { messageId: secondMessageId })).state).toBe("cancelled");
    expect((await callTool(firstMcp, "get_session_diagnostics", { targetAgentId: agentId })).identity).toMatchObject({ agentId });

    await firstMcp.close();
    await stopDaemon(first);

    const second = await startDaemonProcess(configPath);
    await waitForHealth(base);
    const replayedCliCreate = await cli(configPath, ["capability", "create", "--body", JSON.stringify(cliCapability), "--idempotency-key", "acceptance:cli:capability:create"]);
    expect(replayedCliCreate).toMatchObject({ status: "replayed" });
    const replayedCliMessage = await cli(configPath, ["messages", "send", "--body", JSON.stringify(cliMessage), "--idempotency-key", "acceptance:cli:message:send"]);
    expect(replayedCliMessage).toMatchObject({ status: "replayed", message: { id: cliSent.message.id } });
    expect(await cli(configPath, ["capability", "list"])).toEqual(expect.arrayContaining([expect.objectContaining({ capabilityId: mcpCapability.capabilityId, state: "active" })]));

    const secondMcp = await connectMcp(base, agentId, agentToken);
    try {
      const replayedMessages = await callTool(secondMcp, "replay_agent_messages", { afterCursor: 0 });
      expect(replayedMessages.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: firstMessageId }), expect.objectContaining({ id: secondMessageId })]));
      expect((await callTool(secondMcp, "get_agent_message", { messageId: firstMessageId })).state).toBe("delivered");
      expect((await callTool(secondMcp, "get_agent_message", { messageId: secondMessageId })).state).toBe("cancelled");
      expect((await callTool(secondMcp, "get_session_diagnostics", { targetAgentId: agentId })).identity).toMatchObject({ agentId });
    } finally {
      await secondMcp.close();
    }
    await stopDaemon(second);
  }, 60_000);
});
