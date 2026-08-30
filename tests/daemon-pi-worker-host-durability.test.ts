import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../packages/storage/src/index.js";

const repositoryRoot = resolve(".");
const daemonRunner = resolve("tests/fixtures/daemon-process.ts");
const fixtureRpc = resolve("tests/fixtures/pi-durable-rpc.mjs");
const tsx = resolve("node_modules/.bin/tsx");
const temporary: string[] = [];
const ownedProcessGroups = new Set<number>();
const ownedDaemonPids = new Set<number>();
const daemons = new Set<ChildProcess>();

afterEach(() => {
  for (const daemonPid of ownedDaemonPids) {
    try { process.kill(daemonPid, "SIGKILL"); } catch { /* exact daemon already exited */ }
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
      // Retained host already exited.
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

async function startDaemonProcess(configPath: string): Promise<{ child: ChildProcess; daemonPid: number }> {
  const child = spawn(tsx, ["--tsconfig", resolve("tsconfig.json"), daemonRunner, configPath, repositoryRoot], {
    cwd: repositoryRoot,
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

describe("daemon Pi worker-host durability", () => {
  it("reattaches the same Pi RPC process and replays its terminal turn exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-pi-durability-"));
    temporary.push(root);
    const dataDirectory = join(root, "data");
    const configPath = join(root, "symphony.config.json");
    const port = await availablePort();
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      dataDirectory,
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 3_000 },
      conductor: { harness: "pi", model: "fixture" },
      agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access", recoveryTimeoutMs: 8_000 },
      workerHosts: { enabled: true, maxSpoolBytes: 8_388_608, maxSpoolFrames: 10_000 },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false }, opencode: { enabled: false },
        pi: { enabled: true, process: { command: process.execPath, args: [fixtureRpc, "--fixture-root", root] } },
        acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      uiUtilities: { provider: "deterministic", chatTitles: false },
      plugins: { watch: false },
    }));

    const firstDaemon = await startDaemonProcess(configPath);
    const base = `http://127.0.0.1:${port}`;
    const thread = await fetch(`${base}/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "test-thread-pi-crash" },
      body: JSON.stringify({ title: "Pi daemon crash durability", workspacePath: root }),
    }).then((response) => response.json()) as { id: string };
    const accepted = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "durable-pi-turn", content: "Complete across a daemon crash.", attachments: [] }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Pi fixture turn was rejected: ${response.status} ${await response.text()}`);
      return await response.json() as { agentId: string };
    });

    let initialLease: ReturnType<ReturnType<typeof createStore>["getWorkerProcessLease"]> = null;
    await expect.poll(() => {
      const store = createStore(dataDirectory);
      try {
        const lease = store.listWorkerProcessLeases({ agentId: accepted.agentId, states: ["running"] })[0] ?? null;
        if (lease?.transport.kind === "worker-host" && lease.nativeSessionId) initialLease = lease;
        return Boolean(initialLease);
      } finally {
        store.close();
      }
    }, { timeout: 8_000, interval: 50 }).toBe(true);
    if (!initialLease || initialLease.transport.kind !== "worker-host") throw new Error("Hosted Pi lease was not established.");
    const leaseId = initialLease.id;
    const firstOwner = initialLease.daemonOwnerId;
    const hostPid = initialLease.transport.hostIdentity?.pid;
    const nativePid = initialLease.transport.workerIdentity?.pid;
    if (!hostPid || !nativePid) throw new Error("Pi host and RPC process identities were not captured.");
    ownedProcessGroups.add(hostPid);
    expect(lines(join(root, ".fixture-pi-launches"))).toEqual([String(nativePid)]);
    const nativeDispatchesPath = join(root, ".fixture-pi-native-dispatches");
    await expect.poll(
      () => existsSync(nativeDispatchesPath) ? lines(nativeDispatchesPath) : [],
      { timeout: 8_000, interval: 25 },
    ).toEqual(["fixture-pi-turn-1"]);

    process.kill(firstDaemon.daemonPid, "SIGKILL");
    await waitForExit(firstDaemon.child);
    ownedDaemonPids.delete(firstDaemon.daemonPid);
    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(nativePid, 0)).not.toThrow();

    // The entire terminal sequence lands in the authenticated host spool while
    // no daemon exists. Recovery must project it, never submit another prompt.
    await new Promise((resolveWait) => setTimeout(resolveWait, 4_300));
    expect(() => process.kill(nativePid, 0)).not.toThrow();

    const secondDaemon = await startDaemonProcess(configPath);
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
    expect(adopted?.daemonOwnerId).not.toBe(firstOwner);
    expect(adopted?.nativeSessionId).toBe(initialLease.nativeSessionId);
    expect(adopted?.transport).toMatchObject({
      kind: "worker-host",
      hostIdentity: { pid: hostPid },
      workerIdentity: { pid: nativePid },
    });
    expect(adopted?.adapterState).toMatchObject({ running: false, settled: true });
    expect(leases).toHaveLength(1);
    expect(lines(join(root, ".fixture-pi-launches"))).toEqual([String(nativePid)]);
    expect(lines(nativeDispatchesPath)).toEqual(["fixture-pi-turn-1"]);
    expect(existsSync(join(root, ".fixture-pi-forbidden-switch"))).toBe(false);
    expect(events.filter((event) => event.type === "supervisor.process.reserved")).toHaveLength(1);
    expect(events.filter((event) => event.type === "supervisor.host.adopted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.output.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.run.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent.recovery.continued")).toHaveLength(0);

    const followUp = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "durable-pi-follow-up", content: "Continue in the same Pi session.", attachments: [] }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Pi retained follow-up failed: ${response.status} ${await response.text()}`);
      return await response.json() as { agentId: string };
    });
    expect(followUp.agentId).toBe(accepted.agentId);
    await expect.poll(() => {
      const current = createStore(dataDirectory);
      try {
        return current.eventsAfter(0, { agentId: accepted.agentId, limit: 10_000 })
          .filter((event) => event.type === "driver.run.completed").length;
      } finally {
        current.close();
      }
    }, { timeout: 8_000, interval: 100 }).toBe(2);
    expect(lines(nativeDispatchesPath)).toEqual(["fixture-pi-turn-1", "fixture-pi-turn-2"]);
    const finalStore = createStore(dataDirectory);
    const finalLease = finalStore.getWorkerProcessLease(leaseId);
    finalStore.close();
    expect(finalLease?.transport).toMatchObject({
      kind: "worker-host",
      hostIdentity: { pid: hostPid },
      workerIdentity: { pid: nativePid },
    });
    expect(existsSync(join(root, ".fixture-pi-forbidden-switch"))).toBe(false);

    process.kill(secondDaemon.daemonPid, "SIGTERM");
    await waitForExit(secondDaemon.child);
    ownedDaemonPids.delete(secondDaemon.daemonPid);
  }, 30_000);
});
