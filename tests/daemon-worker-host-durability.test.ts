import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../packages/storage/src/index.js";

const repositoryRoot = resolve(".");
const runner = resolve("tests/fixtures/daemon-process.ts");
const fixtureServer = resolve("tests/fixtures/codex-durable-app-server.mjs");
const tsx = resolve("node_modules/.bin/tsx");
const legacyDaemonSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const temporary: string[] = [];
const ownedPids = new Set<number>();
const daemons = new Set<ChildProcess>();

afterEach(async () => {
  for (const daemon of daemons) {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
  }
  daemons.clear();
  for (const pid of ownedPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
  }
  ownedPids.clear();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate test port."));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function startDaemonProcess(configPath: string): Promise<{ child: ChildProcess; daemonPid: number }> {
  const child = spawn(tsx, ["--tsconfig", resolve("tsconfig.json"), runner, configPath, repositoryRoot], {
    cwd: repositoryRoot,
    env: { ...process.env, SYMPHONY_DAEMON_SECRET: legacyDaemonSecret },
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
      const ready = JSON.parse(readyLine) as { pid: number };
      daemonPid = ready.pid;
      clearTimeout(timer);
      resolveReady();
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Daemon exited before readiness (code=${String(code)}, signal=${String(signal)}). ${stderr}`));
    });
  });
  if (!daemonPid) throw new Error("Daemon readiness did not include its PID.");
  return { child, daemonPid };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

describe("daemon worker-host durability", () => {
  it("reattaches the same native process after the daemon is SIGKILLed", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-host-durability-"));
    temporary.push(root);
    const dataDirectory = join(root, "data");
    const configPath = join(root, "symphony.config.json");
    const port = await availablePort();
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      dataDirectory,
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 3_000 },
      conductor: { harness: "codex", model: "fixture" },
      agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access", recoveryTimeoutMs: 8_000 },
      workerHosts: { enabled: true, maxSpoolBytes: 8_388_608, maxSpoolFrames: 10_000 },
      harnesses: {
        codex: { enabled: true, process: { command: process.execPath, args: [fixtureServer, "--block-initial-turn-ack"] } },
        claude: { enabled: false }, cursor: { enabled: false }, opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      uiUtilities: { provider: "deterministic", chatTitles: false },
      plugins: { watch: false },
    }));
    const legacyStore = createStore(dataDirectory);
    legacyStore.setMetadata("daemon-secret", legacyDaemonSecret);
    legacyStore.close();

    const firstDaemon = await startDaemonProcess(configPath);
    const base = `http://127.0.0.1:${port}`;
    const thread = await fetch(`${base}/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "test-thread-worker-host-crash" },
      body: JSON.stringify({ title: "Daemon crash durability", workspacePath: root }),
    }).then((response) => response.json()) as { id: string };
    const accepted = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "durable-host-turn", content: "Continue across a daemon crash.", attachments: [] }),
    }).then((response) => response.json()) as { agentId: string };

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
        const dispatches = existsSync(join(root, ".fixture-native-dispatches"))
          ? readFileSync(join(root, ".fixture-native-dispatches"), "utf8").trim().split(/\r?\n/u).filter(Boolean)
          : [];
        if (
          lease?.transport.kind === "worker-host"
          && lease.nativeSessionId
          && !lease.nativeRunId
          && !lease.activeTurnId
          && initialTurn?.state === "dispatching"
          && dispatches.length === 1
        ) initialLease = lease;
        return Boolean(initialLease);
      } finally { store.close(); }
    }, { timeout: 8_000 }).toBe(true);
    if (!initialLease || initialLease.transport.kind !== "worker-host") throw new Error("Hosted lease was not established.");
    const migratedStore = createStore(dataDirectory);
    expect(migratedStore.getMetadata("daemon-secret")).toBe(legacyDaemonSecret);
    expect(migratedStore.getMetadata("daemon-credential-id")).toEqual(expect.any(String));
    expect(migratedStore.getMetadata("daemon-credential-generation")).toBe(1);
    expect(migratedStore.getMetadata("daemon-credential-fingerprint")).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/u));
    migratedStore.close();
    const leaseId = initialLease.id;
    const firstOwner = initialLease.daemonOwnerId;
    const hostPid = initialLease.transport.hostIdentity?.pid;
    const workerPid = initialLease.transport.workerIdentity?.pid;
    if (!hostPid || !workerPid) throw new Error("Process identities were not captured.");
    ownedPids.add(hostPid);
    ownedPids.add(workerPid);
    expect(initialLease.nativeRunId).toBeNull();
    expect(initialLease.activeTurnId).toBeNull();
    expect(initialLease.adapterState).toMatchObject({
      initialTurn: {
        id: `initial:${accepted.agentId}`,
        requestId: `codex:initial-turn:${accepted.agentId}`,
        state: "dispatching",
        turnId: null,
      },
    });
    expect(readFileSync(join(root, ".fixture-native-thread-starts"), "utf8").trim().split(/\r?\n/u)).toEqual([
      initialLease.nativeSessionId,
    ]);

    process.kill(firstDaemon.daemonPid, "SIGKILL");
    await waitForExit(firstDaemon.child);
    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(workerPid, 0)).not.toThrow();
    writeFileSync(join(root, ".fixture-release-initial-turn-ack"), "release\n");
    // Let the native turn finish entirely while there is no daemon. The
    // replacement must replay the terminal result without appending a stale
    // "continuing" or "ready" recovery notice after the answer.
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_150));

    const secondDaemon = await startDaemonProcess(configPath);
    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/agents/${accepted.agentId}`);
      if (!response.ok) return "unavailable";
      return ((await response.json()) as { status: string }).status;
    }, { timeout: 10_000, interval: 100 }).toBe("completed");

    const store = createStore(dataDirectory);
    const adopted = store.getWorkerProcessLease(leaseId);
    const leases = store.listWorkerProcessLeases({ agentId: accepted.agentId });
    const events = store.eventsAfter(0, { agentId: accepted.agentId, limit: 10_000 });
    store.close();
    expect(adopted).not.toBeNull();
    expect(adopted?.daemonOwnerId).not.toBe(firstOwner);
    expect(adopted?.nativeSessionId).toBe(initialLease.nativeSessionId);
    expect(adopted?.nativeRunId).toBe("fixture-turn-1");
    expect(adopted?.activeTurnId).toBeNull();
    expect(adopted?.adapterState).toMatchObject({
      initialTurn: {
        id: `initial:${accepted.agentId}`,
        requestId: `codex:initial-turn:${accepted.agentId}`,
        state: "accepted",
        turnId: "fixture-turn-1",
      },
      lastSettledTurnId: "fixture-turn-1",
    });
    expect(adopted?.transport).toMatchObject({
      kind: "worker-host",
      hostIdentity: { pid: hostPid },
      workerIdentity: { pid: workerPid },
    });
    if (adopted?.transport.kind !== "worker-host") throw new Error("Adopted transport is not hosted.");
    expect(adopted.transport.ackedOutputSeq).toBe(adopted.transport.processedOutputSeq);
    expect(adopted.transport.processedOutputSeq).toBe(adopted.transport.producedOutputSeq);
    expect(leases).toHaveLength(1);
    expect(readFileSync(join(root, ".fixture-native-dispatches"), "utf8").trim().split(/\r?\n/u)).toEqual(["fixture-turn-1"]);
    expect(readFileSync(join(root, ".fixture-native-thread-starts"), "utf8").trim().split(/\r?\n/u)).toEqual([
      initialLease.nativeSessionId,
    ]);
    expect(existsSync(join(root, ".fixture-forbidden-resume"))).toBe(false);
    const recoveredProjection = await fetch(`${base}/v1/threads/${thread.id}`).then((response) => response.json()) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(recoveredProjection.messages.flatMap((message) => message.parts)
      .map((part) => typeof part.text === "string" ? part.text : "")
      .filter((text) => text.includes("Symphony restarted"))).toEqual([]);
    expect(recoveredProjection.messages.flatMap((message) => message.parts)
      .map((part) => typeof part.text === "string" ? part.text : "")
      .filter((text) => text === "Durable worker continued while the daemon was gone.")).toHaveLength(1);
    expect(events.filter((event) => event.type === "supervisor.process.reserved")).toHaveLength(1);
    expect(events.filter((event) => event.type === "supervisor.host.adopted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.output.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.run.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent.interrupted")).toHaveLength(0);
    expect(events.filter((event) => event.type === "supervisor.orphan.detected")).toHaveLength(0);
    expect(events.filter((event) => event.type === "agent.recovery.continued")).toHaveLength(0);

    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(workerPid, 0)).not.toThrow();
    process.kill(secondDaemon.daemonPid, "SIGTERM");
    await waitForExit(secondDaemon.child);

    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(workerPid, 0)).not.toThrow();
    const thirdDaemon = await startDaemonProcess(configPath);
    const followUp = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "durable-host-follow-up", content: "Continue in the retained native conversation.", attachments: [] }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Retained follow-up failed with ${response.status}: ${await response.text()}`);
      return await response.json() as { agentId: string };
    });
    expect(followUp.agentId).toBe(accepted.agentId);
    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/agents/${accepted.agentId}`);
      if (!response.ok) return "unavailable";
      return ((await response.json()) as { status: string }).status;
    }, { timeout: 10_000, interval: 100 }).toBe("completed");
    expect(readFileSync(join(root, ".fixture-native-dispatches"), "utf8").trim().split(/\r?\n/u)).toEqual([
      "fixture-turn-1",
      "fixture-turn-2",
    ]);
    expect(existsSync(join(root, ".fixture-forbidden-resume"))).toBe(false);
    const finalStore = createStore(dataDirectory);
    const finalLeases = finalStore.listWorkerProcessLeases({ agentId: accepted.agentId });
    const finalLease = finalStore.getWorkerProcessLease(leaseId);
    finalStore.close();
    expect(finalLeases).toHaveLength(1);
    expect(finalLease?.transport).toMatchObject({
      kind: "worker-host",
      hostIdentity: { pid: hostPid },
      workerIdentity: { pid: workerPid },
    });
    process.kill(thirdDaemon.daemonPid, "SIGTERM");
    await waitForExit(thirdDaemon.child);
  }, 30_000);
});
