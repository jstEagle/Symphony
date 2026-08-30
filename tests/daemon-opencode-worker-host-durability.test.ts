import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../packages/storage/src/index.js";

const repositoryRoot = resolve(".");
const daemonRunner = resolve("tests/fixtures/daemon-process.ts");
const fixtureServer = resolve("tests/fixtures/opencode-durable-http-server.mjs");
const tsx = resolve("node_modules/.bin/tsx");
const daemonSecret = "5d".repeat(32);
const temporary: string[] = [];
const ownedProcessGroups = new Set<number>();
const ownedDaemonPids = new Set<number>();
const daemons = new Set<ChildProcess>();

afterEach(() => {
  for (const daemonPid of ownedDaemonPids) {
    try {
      process.kill(daemonPid, "SIGKILL");
    } catch {
      // The exact daemon process already exited.
    }
  }
  ownedDaemonPids.clear();
  for (const daemon of daemons) {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
  }
  daemons.clear();
  for (const processGroup of ownedProcessGroups) {
    try {
      if (process.platform === "win32") process.kill(processGroup, "SIGKILL");
      else process.kill(-processGroup, "SIGKILL");
    } catch {
      // The retained worker-host group may already have exited.
    }
  }
  ownedProcessGroups.clear();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a test port."));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function startDaemonProcess(configPath: string, serviceMaster: string): Promise<{ child: ChildProcess; daemonPid: number }> {
  const child = spawn(tsx, ["--tsconfig", resolve("tsconfig.json"), daemonRunner, configPath, repositoryRoot], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SYMPHONY_DAEMON_SECRET: daemonSecret,
      SYMPHONY_OPENCODE_SERVICE_KEY: serviceMaster,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemons.add(child);
  let stdout = "";
  let stderr = "";
  let daemonPid = 0;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Daemon did not become ready. ${stderr}`)), 8_000);
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const readyLine = stdout.split(/\r?\n/u).find((line) => line.includes('"type":"ready"'));
      if (!readyLine) return;
      daemonPid = (JSON.parse(readyLine) as { pid: number }).pid;
      clearTimeout(timer);
      resolveReady();
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Daemon exited before readiness (code=${String(code)}, signal=${String(signal)}). ${stderr}`));
    });
  });
  if (!daemonPid) throw new Error("Daemon readiness did not include its PID.");
  ownedDaemonPids.add(daemonPid);
  return { child, daemonPid };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").trim().split(/\r?\n/u).filter(Boolean);
}

function regularFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return regularFiles(path);
    return entry.isFile() && statSync(path).isFile() ? [path] : [];
  });
}

describe("daemon OpenCode worker-host durability", () => {
  it("adopts the same auto-started OpenCode service and completes its in-flight turn exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-opencode-durability-"));
    temporary.push(root);
    const dataDirectory = join(root, "data");
    const configPath = join(root, "symphony.config.json");
    const daemonPort = await availablePort();
    const openCodePort = await availablePort();
    const serviceMaster = Buffer.alloc(32, 0x6b).toString("base64url");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      dataDirectory,
      server: { host: "127.0.0.1", port: daemonPort, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 3_000 },
      conductor: { harness: "opencode", model: "fixture" },
      agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access", recoveryTimeoutMs: 8_000 },
      workerHosts: { enabled: true, maxSpoolBytes: 8_388_608, maxSpoolFrames: 10_000 },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: {
          enabled: true,
          autoStart: true,
          baseUrl: `http://127.0.0.1:${openCodePort}`,
          process: {
            command: process.execPath,
            args: [fixtureServer, "serve", "--block-initial-prompt-ack", "--hostname=127.0.0.1", `--port=${openCodePort}`],
          },
        },
        pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      uiUtilities: { provider: "deterministic", chatTitles: false },
      plugins: { watch: false },
    }));

    const firstDaemon = await startDaemonProcess(configPath, serviceMaster);
    const base = `http://127.0.0.1:${daemonPort}`;
    const thread = await fetch(`${base}/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "test-thread-opencode-crash" },
      body: JSON.stringify({ title: "OpenCode daemon crash durability", workspacePath: root }),
    }).then((response) => response.json()) as { id: string };
    const accepted = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "durable-opencode-turn", content: "Complete across a daemon crash.", attachments: [] }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`OpenCode fixture turn was rejected: ${response.status} ${await response.text()}`);
      return await response.json() as { agentId: string };
    });
    const servicePassword = createHmac("sha256", Buffer.from(serviceMaster, "base64url"))
      .update(`symphony-opencode-basic:v1:${accepted.agentId}`)
      .digest("base64url");
    const authorization = `Basic ${Buffer.from(`opencode:${servicePassword}`, "utf8").toString("base64")}`;

    let initialLease: ReturnType<ReturnType<typeof createStore>["getWorkerProcessLease"]> = null;
    await expect.poll(() => {
      const store = createStore(dataDirectory);
      try {
        const lease = store.listWorkerProcessLeases({ agentId: accepted.agentId, states: ["running"] })[0] ?? null;
        const initialTurn = lease?.adapterState
          && typeof lease.adapterState === "object"
          && !Array.isArray(lease.adapterState)
          && lease.adapterState.initialTurn
          && typeof lease.adapterState.initialTurn === "object"
          && !Array.isArray(lease.adapterState.initialTurn)
          ? lease.adapterState.initialTurn
          : null;
        if (
          lease?.transport.kind === "worker-host"
          && lease.nativeSessionId
          && initialTurn?.state === "dispatching"
          && lines(join(root, ".fixture-opencode-native-dispatches")).length === 1
        ) initialLease = lease;
        return Boolean(initialLease);
      } finally {
        store.close();
      }
    }, { timeout: 8_000, interval: 50 }).toBe(true);
    if (!initialLease || initialLease.transport.kind !== "worker-host") throw new Error("Hosted OpenCode lease was not established.");
    const leaseId = initialLease.id;
    const firstOwner = initialLease.daemonOwnerId;
    const hostPid = initialLease.transport.hostIdentity?.pid;
    const servicePid = initialLease.transport.workerIdentity?.pid;
    const hostedEndpoint = initialLease.adapterState
      && typeof initialLease.adapterState === "object"
      && !Array.isArray(initialLease.adapterState)
      && typeof initialLease.adapterState.endpoint === "string"
      ? initialLease.adapterState.endpoint
      : null;
    if (!hostPid || !servicePid) throw new Error("OpenCode host and service process identities were not captured.");
    if (!hostedEndpoint) throw new Error("OpenCode hosted endpoint was not persisted.");
    ownedProcessGroups.add(hostPid);
    expect(lines(join(root, ".fixture-opencode-server-launches"))).toEqual([String(servicePid)]);
    expect(lines(join(root, ".fixture-opencode-native-dispatches"))).toEqual(["fixture-opencode-turn-1"]);
    expect(initialLease.activeTurnId).toBe(`initial:${accepted.agentId}`);
    expect(initialLease.adapterState).toMatchObject({
      endpoint: hostedEndpoint,
      initialTurn: { id: `initial:${accepted.agentId}`, state: "dispatching" },
    });

    process.kill(firstDaemon.daemonPid, "SIGKILL");
    await waitForExit(firstDaemon.child);
    ownedDaemonPids.delete(firstDaemon.daemonPid);
    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(servicePid, 0)).not.toThrow();
    await expect(fetch(`${hostedEndpoint}/path`)).resolves.toMatchObject({ status: 401 });
    await expect.poll(async () => {
      const response = await fetch(`${hostedEndpoint}/path`, { headers: { Authorization: authorization } });
      return response.ok;
    }, { timeout: 2_000, interval: 50 }).toBe(true);

    // Let the native turn finish with no daemon and no SSE subscriber. The
    // replacement must reconstruct terminal evidence from OpenCode's durable
    // transcript rather than dispatching a continuation or duplicate prompt.
    await new Promise((resolveWait) => setTimeout(resolveWait, 4_750));
    const offlineStatus = await fetch(`${hostedEndpoint}/session/status?directory=${encodeURIComponent(root)}`, {
      headers: { Authorization: authorization },
    })
      .then((response) => response.json()) as Record<string, { type: string }>;
    expect(offlineStatus[initialLease.nativeSessionId as string]?.type).toBe("idle");

    const secondDaemon = await startDaemonProcess(configPath, serviceMaster);
    expect(secondDaemon.daemonPid).not.toBe(firstDaemon.daemonPid);
    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/agents/${accepted.agentId}`);
      if (!response.ok) return "unavailable";
      return ((await response.json()) as { status: string }).status;
    }, { timeout: 12_000, interval: 100 }).toBe("completed");

    const store = createStore(dataDirectory);
    const adopted = store.getWorkerProcessLease(leaseId);
    const leases = store.listWorkerProcessLeases({ agentId: accepted.agentId });
    const events = store.eventsAfter(0, { agentId: accepted.agentId, limit: 10_000 });
    store.close();
    expect(adopted).not.toBeNull();
    expect(adopted?.daemonOwnerId).not.toBe(firstOwner);
    expect(adopted?.nativeSessionId).toBe(initialLease.nativeSessionId);
    expect(adopted?.adapterState).toEqual({
      endpoint: hostedEndpoint,
      initialTurn: { id: `initial:${accepted.agentId}`, state: "dispatching" },
    });
    expect(adopted?.transport).toMatchObject({
      kind: "worker-host",
      hostIdentity: { pid: hostPid },
      workerIdentity: { pid: servicePid },
    });
    expect(leases).toHaveLength(1);
    expect(lines(join(root, ".fixture-opencode-server-launches"))).toEqual([String(servicePid)]);
    expect(lines(join(root, ".fixture-opencode-native-dispatches"))).toEqual(["fixture-opencode-turn-1"]);
    expect(events.filter((event) => event.type === "supervisor.process.reserved")).toHaveLength(1);
    expect(events.filter((event) => event.type === "supervisor.host.adopted")).toHaveLength(1);
    const recoveries = events.filter((event) => event.type === "agent.recovered");
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]?.payload).toMatchObject({
      nativeSessionId: initialLease.nativeSessionId,
      continuity: "terminal-event-observed",
    });
    expect(events.filter((event) => event.type === "driver.output.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.run.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent.interrupted")).toHaveLength(0);
    expect(events.filter((event) => event.type === "supervisor.orphan.detected")).toHaveLength(0);
    expect(events.filter((event) => event.type === "agent.recovery.continued")).toHaveLength(0);
    if (adopted?.transport.kind !== "worker-host") throw new Error("Adopted OpenCode lease lost its worker-host transport.");
    expect(adopted.transport.processedOutputSeq).toBe(adopted.transport.producedOutputSeq);
    expect(adopted.transport.ackedOutputSeq).toBe(adopted.transport.producedOutputSeq);
    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(servicePid, 0)).not.toThrow();
    await expect(fetch(`${hostedEndpoint}/path`)).resolves.toMatchObject({ status: 401 });

    const durableText = regularFiles(root)
      .map((path) => readFileSync(path).toString("utf8"))
      .join("\n");
    expect(durableText).not.toContain(serviceMaster);
    expect(durableText).not.toContain(servicePassword);
    expect(durableText).not.toContain(authorization);

    process.kill(secondDaemon.daemonPid, "SIGTERM");
    await waitForExit(secondDaemon.child);
    ownedDaemonPids.delete(secondDaemon.daemonPid);
  }, 25_000);
});
