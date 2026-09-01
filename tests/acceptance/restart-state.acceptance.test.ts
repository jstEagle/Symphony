import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityApiAdapter, type CapabilityApiResponse } from "../../apps/daemon/src/capability-api.js";
import { AgentMessageApiAdapter } from "../../apps/daemon/src/agent-message-api.js";
import { buildSessionDiagnosticBundle, verifySessionDiagnosticContentHash } from "../../packages/runtime/src/session-diagnostics.js";
import { AgentMessageStore, createStore, type SymphonyStore } from "../../packages/storage/src/index.js";

const repositoryRoot = resolve(".");
const daemonRunner = resolve("tests/fixtures/process-crash-daemon.ts");
const tsx = resolve("node_modules/.bin/tsx");
const daemonSecret = "3d".repeat(32);
const temporary: string[] = [];
const daemons = new Set<ChildProcess>();

const actor = { type: "user" as const, id: "local-user" };
const recordedAt = "2026-09-01T00:00:00.000Z";

afterEach(async () => {
  for (const daemon of daemons) {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
  }
  await Promise.all([...daemons].map((daemon) => waitForExit(daemon)));
  daemons.clear();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate restart-state test port."));
      server.close(() => resolvePort(address.port));
    });
  });
}

function writeConfig(root: string, dataDirectory: string, port: number): string {
  const configPath = join(root, "restart-state.config.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    dataDirectory,
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 300 },
    conductor: { harness: "codex", model: "fixture" },
    agents: {
      maxDepth: null,
      maxConcurrent: 2,
      defaultPermissions: "full-access",
      startupTimeoutMs: 1_000,
      recoveryTimeoutMs: 1_000,
      recoveryConcurrency: 1,
      cancellationAcknowledgementTimeoutMs: 100,
      cancellationTerminationGraceMs: 100,
    },
    workerHosts: { enabled: true, maxSpoolBytes: 1_048_576, maxSpoolFrames: 1_000 },
    harnesses: {
      codex: { enabled: true, process: { command: process.execPath, args: [resolve("tests/fixtures/process-crash-native.mjs")] } },
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
    workflows: { directory: join(root, "workflows"), triggersEnabled: false, approvalExpiryScanMs: 500 },
  }));
  return configPath;
}

type StartedDaemon = { child: ChildProcess; pid: number };

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
      reject(new Error(`Restart-state daemon did not become ready. ${stderr}`));
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
      reject(new Error(`Restart-state daemon exited before readiness (code=${String(code)}, signal=${String(signal)}). ${stderr}`));
    });
  });
  return { child, pid };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

async function waitFor(assertion: () => unknown | Promise<unknown>, timeout = 10_000): Promise<void> {
  await vi.waitFor(assertion, { timeout, interval: 30 });
}

async function waitForHealth(base: string): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "ready" });
  });
}

async function killDaemon(daemon: StartedDaemon): Promise<void> {
  process.kill(daemon.pid, "SIGKILL");
  await waitForExit(daemon.child);
}

function capability(description = "A restart-safe capability"): Record<string, unknown> {
  return {
    capabilityId: "acceptance.restart-state",
    definition: {
      name: "Restart-state acceptance",
      description,
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      defaults: { harness: "fixture", permission: "read-only" },
    },
    provenance: { source: "acceptance", actor: "local-user" },
  };
}

function capabilityBody(response: CapabilityApiResponse): Record<string, any> {
  return response.body as Record<string, any>;
}

function agentMessage(requestKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    requestKey,
    kind: "finding",
    senderId: "agent:worker",
    recipientId: "agent:parent",
    parentId: "parent:restart-state",
    parentAgentId: "agent:parent",
    objectiveId: "objective:restart-state",
    runId: "run:restart-state",
    attemptId: "attempt:restart-state",
    correlationId: null,
    replyToId: null,
    payload: { result: "durable" },
    summary: "A restart-safe semantic finding.",
    artifactRefs: [],
    evidenceRefs: [],
    createdAt: recordedAt,
    expiresAt: null,
    ...overrides,
  };
}

function messageAuthority() {
  return {
    canAppend: (actorId: string, value: { senderId: string }) => actorId === value.senderId,
    canRead: (actorId: string, value: { recipientId: string }) => actorId === value.recipientId,
    canHandle: (actorId: string) => actorId === "agent:parent",
    canCancel: (actorId: string) => actorId === "agent:parent",
    canExpire: (actorId: string) => actorId === "system:expiry",
  };
}

function storeAt(dataDirectory: string): SymphonyStore {
  return createStore(dataDirectory);
}

describe("restart-state acceptance (real daemon and SQLite)", () => {
  it("retains capability, semantic message, and diagnostic state across daemon SIGKILL", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-restart-state-"));
    temporary.push(root);
    const dataDirectory = join(root, "sqlite");
    const port = await availablePort();
    const configPath = writeConfig(root, dataDirectory, port);
    const first = await startDaemonProcess(configPath);
    const base = `http://127.0.0.1:${port}`;
    const capabilityPath = join(dataDirectory, "capabilities.sqlite");
    const messagesPath = join(dataDirectory, "agent-messages.sqlite");
    try {
      await waitForHealth(base);
      const beforeBootstrap = await fetch(`${base}/v1/bootstrap`);
      expect(beforeBootstrap.status).toBe(200);

      // These are the exact SQLite files opened by SymphonyDaemon's owned
      // capability and agent-message services. Keeping the adapter handles
      // separate lets this acceptance test model a client/native process
      // writing at the same durable boundary as the daemon.
      const capabilities = new CapabilityApiAdapter(capabilityPath, { clock: () => recordedAt });
      const messagesStore = new AgentMessageStore(messagesPath);
      const messages = new AgentMessageApiAdapter(messagesStore, messageAuthority());
      const mainStore = storeAt(dataDirectory);
      let diagnostic: ReturnType<typeof buildSessionDiagnosticBundle>;
      let createdCapability: Record<string, unknown>;
      let createdMessageId: string;
      try {
        const created = capabilities.create({ ...capability(), actor, requestKey: "restart-state:capability:create" });
        expect(created.status).toBe(201);
        expect(capabilityBody(created).status).toBe("committed");
        createdCapability = capabilityBody(created).version;
        const activated = capabilities.activate({ capabilityId: "acceptance.restart-state", version: 1, actor, requestKey: "restart-state:capability:activate" });
        expect(activated.status).toBe(200);
        expect(capabilityBody(activated).status).toBe("committed");
        expect(capabilityBody(activated).version).toMatchObject({ state: "active" });

        const appended = messages.append(agentMessage("restart-state:message:create"), "agent:worker");
        expect(appended.status).toBe("committed");
        createdMessageId = appended.message?.id ?? "";
        expect(createdMessageId).toBeTruthy();
        expect(messages.deliver(createdMessageId, {
          requestKey: "restart-state:message:delivery",
          actorId: "agent:parent",
          recordedAt,
          reason: "Accepted before the daemon process boundary.",
        }).status).toBe("committed");

        diagnostic = buildSessionDiagnosticBundle({
          identity: {
            objectiveId: "objective:restart-state",
            runId: "run:restart-state",
            agentId: "agent:restart-state",
            attemptId: "attempt:restart-state",
            nativeSessionId: "native:restart-state",
            nativeRunId: "native-run:restart-state",
          },
          termination: "unknown",
          eventCursorRanges: [{ from: 1, to: mainStore.latestCursor() }],
          harness: { harness: "codex", model: "fixture", version: "acceptance", available: true, auth: "not-required" },
          exits: [{ process: "daemon", state: "signaled", signal: "SIGKILL", stderr: "daemon process boundary" }],
          liveness: { state: "dead", recovery: "eligible", reason: "Daemon generation ended before native outcome was observed." },
          environment: { NODE_ENV: "test", SECRET_TOKEN: "must-not-be-exported" },
          verificationCommands: [{ command: "symphony logs agent:restart-state", purpose: "Inspect durable session logs." }],
          provenance: { source: "restart-state-acceptance", generatedAt: recordedAt, generatorVersion: "acceptance-1" },
        }, { environmentAllowlist: ["NODE_ENV"] });
        expect(verifySessionDiagnosticContentHash(diagnostic)).toBe(true);
        mainStore.setMetadata("session-diagnostic:agent:restart-state", diagnostic as any);
      } finally {
        mainStore.close();
        messages.close();
        capabilities.close();
      }

      // The daemon is killed only after all three durable records have
      // committed. No browser/SSE connection is involved in their recovery.
      await killDaemon(first);
      expect(existsSync(capabilityPath)).toBe(true);
      expect(existsSync(messagesPath)).toBe(true);

      const second = await startDaemonProcess(configPath);
      await waitForHealth(base);
      const restartedCapabilities = new CapabilityApiAdapter(capabilityPath, { clock: () => "2026-09-01T00:02:00.000Z" });
      const restartedMessages = new AgentMessageApiAdapter({ storage: messagesPath, authority: messageAuthority() });
      const restartedMain = storeAt(dataDirectory);
      try {
        const capabilityReplay = restartedCapabilities.create({ ...capability(), actor, requestKey: "restart-state:capability:create" });
        expect(capabilityReplay.status).toBe(200);
        expect(capabilityBody(capabilityReplay).status).toBe("replayed");
        expect(capabilityBody(capabilityReplay).version).toEqual(createdCapability);
        expect(capabilityBody(restartedCapabilities.get("acceptance.restart-state", 1))).toMatchObject({ state: "active" });
        const capabilityConflict = restartedCapabilities.create({ ...capability("conflicting definition"), actor, requestKey: "restart-state:capability:create" });
        expect(capabilityConflict.status).toBe(409);
        expect(capabilityBody(capabilityConflict).status).toBe("conflict");
        expect((restartedCapabilities.list().body as unknown[])).toHaveLength(1);

        expect(restartedMessages.get(createdMessageId, "agent:parent")?.message).toMatchObject({
          id: createdMessageId,
          requestKey: "restart-state:message:create",
        });
        expect(restartedMessages.getMessage(createdMessageId, "agent:parent")?.cursor).toBe(1);
        expect(restartedMessages.replay(0, "agent:parent").messages.map((message) => message.id)).toEqual([createdMessageId]);
        const messageReplay = restartedMessages.append(agentMessage("restart-state:message:create"), "agent:worker");
        expect(messageReplay.status).toBe("replayed");
        const messageConflict = restartedMessages.append(agentMessage("restart-state:message:create", { payload: { result: "changed" } }), "agent:worker");
        expect(messageConflict.status).toBe("conflict");
        expect(restartedMessages.getCursorSnapshot()).toMatchObject({ messageCursor: 1, receiptCursor: 1 });

        const recoveredDiagnostic = restartedMain.getMetadata<typeof diagnostic>("session-diagnostic:agent:restart-state");
        expect(recoveredDiagnostic).not.toBeNull();
        expect(recoveredDiagnostic).toEqual(diagnostic!);
        expect(verifySessionDiagnosticContentHash(recoveredDiagnostic!)).toBe(true);
        expect(recoveredDiagnostic?.termination).toBe("unknown");
        expect(recoveredDiagnostic?.liveness).toMatchObject({ state: "dead", recovery: "eligible" });
        expect(JSON.stringify(recoveredDiagnostic)).not.toContain("must-not-be-exported");
      } finally {
        restartedMain.close();
        restartedMessages.close();
        restartedCapabilities.close();
      }
      process.kill(second.pid, "SIGTERM");
      await waitForExit(second.child);
      daemons.delete(second.child);
    } finally {
      // The shared afterEach cleanup owns exact daemon process termination.
    }
  }, 30_000);
});
