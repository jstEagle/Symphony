import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../packages/storage/src/index.js";

const repositoryRoot = resolve(".");
const daemonRunner = resolve("tests/fixtures/daemon-process.ts");
const fixtureSdk = resolve("tests/fixtures/cursor-sdk-fixture.mjs");
const fixtureCli = resolve("tests/fixtures/cursor-durable-cli.mjs");
const tsx = resolve("node_modules/.bin/tsx");
const daemonSecret = "8e".repeat(32);
const controlledCursorKey = "controlled-cursor-sdk-fixture-key";
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
      // Retained worker host already exited.
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

async function startDaemonProcess(
  configPath: string,
  root: string,
  followUpBlock: "after-accept" | "before-accept" = "after-accept",
): Promise<{ child: ChildProcess; daemonPid: number }> {
  const child = spawn(tsx, ["--tsconfig", resolve("tsconfig.json"), daemonRunner, configPath, repositoryRoot], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SYMPHONY_DAEMON_SECRET: daemonSecret,
      SYMPHONY_CURSOR_HOST_SDK_MODULE: fixtureSdk,
      SYMPHONY_CURSOR_FIXTURE_ROOT: root,
      SYMPHONY_CURSOR_FIXTURE_DELAY_MS: "1600",
      ...(followUpBlock === "after-accept"
        ? { SYMPHONY_CURSOR_FIXTURE_BLOCK_FOLLOWUP_AFTER_ACCEPT: "1" }
        : { SYMPHONY_CURSOR_FIXTURE_BLOCK_FOLLOWUP_BEFORE_ACCEPT: "1" }),
      CURSOR_API_KEY: controlledCursorKey,
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
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split(/\r?\n/u).filter(Boolean);
}

describe("daemon Cursor worker-host durability", () => {
  it("keeps an active SDK host alive across a graceful daemon restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-cursor-graceful-restart-"));
    temporary.push(root);
    const dataDirectory = join(root, "data");
    const configPath = join(root, "symphony.config.json");
    const port = await availablePort();
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      dataDirectory,
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 3_000 },
      conductor: { harness: "cursor", model: "fixture-model" },
      agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access", startupTimeoutMs: 8_000, recoveryTimeoutMs: 8_000 },
      workerHosts: { enabled: true, maxSpoolBytes: 8_388_608, maxSpoolFrames: 10_000 },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, opencode: { enabled: false }, pi: { enabled: false },
        cursor: { enabled: true, process: { command: process.execPath, args: [fixtureCli] }, autoCreatePR: false },
        acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      uiUtilities: { provider: "deterministic", chatTitles: false },
      plugins: { watch: false },
    }));

    const firstDaemon = await startDaemonProcess(configPath, root);
    const base = `http://127.0.0.1:${port}`;
    const thread = await fetch(`${base}/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "test-thread-cursor-restart" },
      body: JSON.stringify({ title: "Cursor graceful restart durability", workspacePath: root }),
    }).then((response) => response.json()) as { id: string };
    const accepted = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "cursor-graceful-restart-turn", content: "Complete across a graceful daemon restart.", attachments: [] }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Cursor fixture turn was rejected: ${response.status} ${await response.text()}`);
      return await response.json() as { agentId: string };
    });

    let initialLease: ReturnType<ReturnType<typeof createStore>["getWorkerProcessLease"]> = null;
    await expect.poll(() => {
      const store = createStore(dataDirectory);
      try {
        const lease = store.listWorkerProcessLeases({ agentId: accepted.agentId, states: ["running"] })[0] ?? null;
        if (
          lease?.transport.kind === "worker-host"
          && lease.nativeRunId === "fixture-cursor-run-1"
          && lease.adapterState
          && typeof lease.adapterState === "object"
          && !Array.isArray(lease.adapterState)
          && lease.adapterState.running === true
        ) initialLease = lease;
        return Boolean(initialLease);
      } finally {
        store.close();
      }
    }, { timeout: 8_000, interval: 40 }).toBe(true);
    if (!initialLease || initialLease.transport.kind !== "worker-host") throw new Error("Hosted Cursor lease was not established.");
    const hostPid = initialLease.transport.hostIdentity?.pid;
    const sdkHostPid = initialLease.transport.workerIdentity?.pid;
    if (!hostPid || !sdkHostPid) throw new Error("Cursor worker host and SDK host identities were not captured.");
    ownedProcessGroups.add(hostPid);

    process.kill(firstDaemon.daemonPid, "SIGTERM");
    await waitForExit(firstDaemon.child);
    ownedDaemonPids.delete(firstDaemon.daemonPid);
    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(sdkHostPid, 0)).not.toThrow();

    const secondDaemon = await startDaemonProcess(configPath, root);
    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/agents/${accepted.agentId}`);
      return response.ok ? ((await response.json()) as { status: string }).status : "unavailable";
    }, { timeout: 12_000, interval: 100 }).toBe("completed");

    const store = createStore(dataDirectory);
    const adopted = store.getWorkerProcessLease(initialLease.id);
    const events = store.eventsAfter(0, { agentId: accepted.agentId, limit: 10_000 });
    store.close();
    expect(adopted?.transport).toMatchObject({
      kind: "worker-host",
      hostIdentity: { pid: hostPid },
      workerIdentity: { pid: sdkHostPid },
    });
    expect(lines(join(root, ".fixture-cursor-dispatches"))).toHaveLength(1);
    expect(events.filter((event) => event.type === "supervisor.host.adopted")).toHaveLength(1);
    expect(events.filter((event) => ["agent.interrupted", "agent.failed"].includes(event.type))).toHaveLength(0);

    process.kill(secondDaemon.daemonPid, "SIGTERM");
    await waitForExit(secondDaemon.child);
    ownedDaemonPids.delete(secondDaemon.daemonPid);
  }, 30_000);

  it("adopts the same SDK host and replays one terminal result without redispatching", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-cursor-durability-"));
    temporary.push(root);
    const dataDirectory = join(root, "data");
    const configPath = join(root, "symphony.config.json");
    const port = await availablePort();
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      dataDirectory,
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 3_000 },
      conductor: { harness: "cursor", model: "fixture-model" },
      agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access", startupTimeoutMs: 8_000, recoveryTimeoutMs: 8_000 },
      workerHosts: { enabled: true, maxSpoolBytes: 8_388_608, maxSpoolFrames: 10_000 },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, opencode: { enabled: false }, pi: { enabled: false },
        cursor: { enabled: true, process: { command: process.execPath, args: [fixtureCli] }, autoCreatePR: false },
        acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      uiUtilities: { provider: "deterministic", chatTitles: false },
      plugins: { watch: false },
    }));

    const firstDaemon = await startDaemonProcess(configPath, root);
    const base = `http://127.0.0.1:${port}`;
    const thread = await fetch(`${base}/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "test-thread-cursor-crash" },
      body: JSON.stringify({ title: "Cursor daemon crash durability", workspacePath: root }),
    }).then((response) => response.json()) as { id: string };
    const accepted = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "durable-cursor-turn", content: "Complete across a daemon crash.", attachments: [] }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Cursor fixture turn was rejected: ${response.status} ${await response.text()}`);
      return await response.json() as { agentId: string };
    });

    let initialLease: ReturnType<ReturnType<typeof createStore>["getWorkerProcessLease"]> = null;
    await expect.poll(() => {
      const store = createStore(dataDirectory);
      try {
        const lease = store.listWorkerProcessLeases({ agentId: accepted.agentId, states: ["running"] })[0] ?? null;
        if (
          lease?.transport.kind === "worker-host"
          && lease.nativeSessionId === `symphony-${accepted.agentId}`
          && lease.nativeRunId === "fixture-cursor-run-1"
          && lease.activeTurnId === "fixture-cursor-run-1"
          && lease.adapterState
          && typeof lease.adapterState === "object"
          && !Array.isArray(lease.adapterState)
          && lease.adapterState.generation === 1
          && lines(join(root, ".fixture-cursor-dispatches")).length === 1
        ) initialLease = lease;
        return Boolean(initialLease);
      } finally {
        store.close();
      }
    }, { timeout: 8_000, interval: 40 }).toBe(true);
    if (!initialLease || initialLease.transport.kind !== "worker-host") throw new Error("Hosted Cursor lease was not established.");
    const leaseId = initialLease.id;
    const firstOwner = initialLease.daemonOwnerId;
    const hostPid = initialLease.transport.hostIdentity?.pid;
    const sdkHostPid = initialLease.transport.workerIdentity?.pid;
    if (!hostPid || !sdkHostPid) throw new Error("Cursor worker host and SDK host identities were not captured.");
    ownedProcessGroups.add(hostPid);

    process.kill(firstDaemon.daemonPid, "SIGKILL");
    await waitForExit(firstDaemon.child);
    ownedDaemonPids.delete(firstDaemon.daemonPid);
    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(sdkHostPid, 0)).not.toThrow();

    // Cursor finishes with no daemon attached. The terminal result remains in
    // the worker-host spool and must be projected once by the replacement.
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(sdkHostPid, 0)).not.toThrow();
    expect(lines(join(root, ".fixture-cursor-dispatches"))).toHaveLength(1);

    const secondDaemon = await startDaemonProcess(configPath, root);
    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/agents/${accepted.agentId}`);
      if (!response.ok) return "unavailable";
      return ((await response.json()) as { status: string }).status;
    }, { timeout: 12_000, interval: 100 }).toBe("completed");

    await expect.poll(() => {
      const store = createStore(dataDirectory);
      try {
        const lease = store.getWorkerProcessLease(leaseId);
        return lease?.transport.kind === "worker-host"
          && lease.transport.producedOutputSeq === lease.transport.processedOutputSeq
          && lease.transport.processedOutputSeq === lease.transport.ackedOutputSeq;
      } finally {
        store.close();
      }
    }, { timeout: 8_000, interval: 50 }).toBe(true);

    await expect.poll(() => {
      const current = createStore(dataDirectory);
      try {
        const state = current.getWorkerProcessLease(leaseId)?.adapterState;
        return state && typeof state === "object" && !Array.isArray(state)
          ? `${String(state.running)}:${String(state.settled)}`
          : "missing";
      } finally {
        current.close();
      }
    }, { timeout: 4_000, interval: 50 }).toBe("false:true");

    const store = createStore(dataDirectory);
    const adopted = store.getWorkerProcessLease(leaseId);
    const leases = store.listWorkerProcessLeases({ agentId: accepted.agentId });
    const events = store.eventsAfter(0, { agentId: accepted.agentId, limit: 10_000 });
    store.close();
    expect(adopted?.daemonOwnerId).not.toBe(firstOwner);
    expect(adopted?.nativeSessionId).toBe(initialLease.nativeSessionId);
    expect(adopted?.nativeRunId).toBe(initialLease.nativeRunId);
    expect(adopted?.adapterState).toMatchObject({
      sessionId: initialLease.nativeSessionId,
      runId: initialLease.nativeRunId,
      generation: 1,
      running: false,
      settled: true,
    });
    expect(adopted?.transport).toMatchObject({
      kind: "worker-host",
      hostIdentity: { pid: hostPid },
      workerIdentity: { pid: sdkHostPid },
    });
    expect(leases).toHaveLength(1);
    expect(lines(join(root, ".fixture-cursor-dispatches"))).toHaveLength(1);
    expect(lines(join(root, ".fixture-cursor-agents"))).toHaveLength(1);
    const fixtureAgent = JSON.parse(lines(join(root, ".fixture-cursor-agents"))[0] as string) as Record<string, unknown>;
    expect(fixtureAgent).toMatchObject({ optionsApiKey: controlledCursorKey, environmentApiKey: null });
    expect(events.filter((event) => event.type === "supervisor.process.reserved")).toHaveLength(1);
    expect(events.filter((event) => event.type === "supervisor.host.adopted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.output.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.run.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.session.started")).toHaveLength(1);
    expect(events.filter((event) => ["agent.interrupted", "agent.failed"].includes(event.type))).toHaveLength(0);
    if (adopted?.transport.kind !== "worker-host") throw new Error("Adopted Cursor lease lost its retained transport.");
    expect(adopted.transport.producedOutputSeq).toBe(adopted.transport.processedOutputSeq);
    expect(adopted.transport.processedOutputSeq).toBe(adopted.transport.ackedOutputSeq);

    const followUp = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "durable-cursor-follow-up", content: "Continue in the same retained Cursor session.", attachments: [] }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Cursor retained follow-up failed: ${response.status} ${await response.text()}`);
      return await response.json() as { agentId: string };
    });
    expect(followUp.agentId).toBe(accepted.agentId);
    await expect.poll(() => lines(join(root, ".fixture-cursor-followup-accepted")), { timeout: 8_000, interval: 40 })
      .toEqual(["fixture-cursor-run-2"]);
    await expect.poll(() => {
      const current = createStore(dataDirectory);
      try {
        const value = current.getMetadata<Record<string, unknown>>(`agent-follow-up:${accepted.agentId}`);
        return value?.state;
      } finally {
        current.close();
      }
    }, { timeout: 8_000, interval: 40 }).toBe("dispatching");

    // The provider has accepted run 2, but its host deliberately withholds the
    // response. Killing this controller exercises the narrow crash window
    // where only the retained host can prove that native work exists.
    process.kill(secondDaemon.daemonPid, "SIGKILL");
    await waitForExit(secondDaemon.child);
    ownedDaemonPids.delete(secondDaemon.daemonPid);
    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(sdkHostPid, 0)).not.toThrow();
    writeFileSync(join(root, ".fixture-cursor-release-followup"), "release\n");
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    expect(lines(join(root, ".fixture-cursor-dispatches"))).toHaveLength(2);

    const thirdDaemon = await startDaemonProcess(configPath, root);
    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/agents/${accepted.agentId}`);
      if (!response.ok) return "unavailable";
      const agent = await response.json() as { status: string; nativeSessionId: string | null; nativeRunId: string | null };
      return `${agent.status}:${String(agent.nativeSessionId)}:${String(agent.nativeRunId)}`;
    }, { timeout: 12_000, interval: 100 }).toBe(`completed:${String(initialLease.nativeSessionId)}:fixture-cursor-run-2`);

    await expect.poll(() => {
      const current = createStore(dataDirectory);
      try {
        const currentLease = current.getWorkerProcessLease(leaseId);
        return currentLease?.transport.kind === "worker-host"
          && currentLease.transport.producedOutputSeq === currentLease.transport.processedOutputSeq
          && currentLease.transport.processedOutputSeq === currentLease.transport.ackedOutputSeq;
      } finally {
        current.close();
      }
    }, { timeout: 8_000, interval: 50 }).toBe(true);

    const finalStore = createStore(dataDirectory);
    const finalLease = finalStore.getWorkerProcessLease(leaseId);
    const finalEvents = finalStore.eventsAfter(0, { agentId: accepted.agentId, limit: 10_000 });
    const finalFollowUp = finalStore.getMetadata<Record<string, unknown>>(`agent-follow-up:${accepted.agentId}`);
    finalStore.close();
    expect(finalLease?.nativeSessionId).toBe(initialLease.nativeSessionId);
    expect(finalLease?.nativeRunId).toBe("fixture-cursor-run-2");
    expect(finalLease?.adapterState).toMatchObject({
      sessionId: initialLease.nativeSessionId,
      runId: "fixture-cursor-run-2",
      generation: 2,
      running: false,
      settled: true,
      promptDispatch: {
        state: "accepted",
        runId: "fixture-cursor-run-2",
        generation: 2,
      },
    });
    expect(finalLease?.transport).toMatchObject({
      kind: "worker-host",
      hostIdentity: { pid: hostPid },
      workerIdentity: { pid: sdkHostPid },
    });
    expect(lines(join(root, ".fixture-cursor-dispatches"))).toHaveLength(2);
    expect(finalEvents.filter((event) => event.type === "driver.output.completed")).toHaveLength(2);
    expect(finalEvents.filter((event) => event.type === "driver.run.completed")).toHaveLength(2);
    expect(finalEvents.filter((event) => ["agent.interrupted", "agent.failed"].includes(event.type))).toHaveLength(0);
    expect(finalFollowUp?.state).toBe("settled");
    expect(finalFollowUp?.outcome).toBe("completed");

    process.kill(thirdDaemon.daemonPid, "SIGTERM");
    await waitForExit(thirdDaemon.child);
    ownedDaemonPids.delete(thirdDaemon.daemonPid);
  }, 30_000);

  it("fails closed without redispatch when the daemon dies before a follow-up is accepted", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-cursor-preaccept-"));
    temporary.push(root);
    const dataDirectory = join(root, "data");
    const configPath = join(root, "symphony.config.json");
    const port = await availablePort();
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      dataDirectory,
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 3_000 },
      conductor: { harness: "cursor", model: "fixture-model" },
      agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access", startupTimeoutMs: 8_000, recoveryTimeoutMs: 8_000 },
      workerHosts: { enabled: true, maxSpoolBytes: 8_388_608, maxSpoolFrames: 10_000 },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, opencode: { enabled: false }, pi: { enabled: false },
        cursor: { enabled: true, process: { command: process.execPath, args: [fixtureCli] }, autoCreatePR: false },
        acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      uiUtilities: { provider: "deterministic", chatTitles: false },
      plugins: { watch: false },
    }));

    const firstDaemon = await startDaemonProcess(configPath, root, "before-accept");
    const base = `http://127.0.0.1:${port}`;
    const thread = await fetch(`${base}/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "test-thread-cursor-preaccept" },
      body: JSON.stringify({ title: "Cursor pre-accept crash", workspacePath: root }),
    }).then((response) => response.json()) as { id: string };
    const accepted = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "cursor-preaccept-initial", content: "Complete the initial turn.", attachments: [] }),
    }).then((response) => response.json()) as { agentId: string };

    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/agents/${accepted.agentId}`);
      return response.ok ? ((await response.json()) as { status: string }).status : "unavailable";
    }, { timeout: 8_000, interval: 80 }).toBe("completed");

    const initialStore = createStore(dataDirectory);
    const initialLease = initialStore.listWorkerProcessLeases({ agentId: accepted.agentId, states: ["running"] })[0];
    initialStore.close();
    if (!initialLease || initialLease.transport.kind !== "worker-host") throw new Error("Cursor retained host was not available for the pre-accept crash.");
    const hostPid = initialLease.transport.hostIdentity?.pid;
    const sdkHostPid = initialLease.transport.workerIdentity?.pid;
    if (!hostPid || !sdkHostPid) throw new Error("Cursor retained process identities were not captured.");
    ownedProcessGroups.add(hostPid);

    await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "cursor-preaccept-followup", content: "This turn must not be duplicated.", attachments: [] }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Cursor pre-accept follow-up failed: ${response.status} ${await response.text()}`);
    });
    await expect.poll(() => lines(join(root, ".fixture-cursor-followup-entered")).length, { timeout: 8_000, interval: 40 }).toBe(1);
    await expect.poll(() => {
      const current = createStore(dataDirectory);
      try {
        const lease = current.getWorkerProcessLease(initialLease.id);
        const adapter = lease?.adapterState;
        const followUp = current.getMetadata<Record<string, unknown>>(`agent-follow-up:${accepted.agentId}`);
        return Boolean(
          followUp?.state === "dispatching"
          && adapter
          && typeof adapter === "object"
          && !Array.isArray(adapter)
          && (adapter.promptDispatch as Record<string, unknown> | undefined)?.state === "dispatching",
        );
      } finally {
        current.close();
      }
    }, { timeout: 8_000, interval: 40 }).toBe(true);

    process.kill(firstDaemon.daemonPid, "SIGKILL");
    await waitForExit(firstDaemon.child);
    ownedDaemonPids.delete(firstDaemon.daemonPid);
    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(sdkHostPid, 0)).not.toThrow();

    const secondDaemon = await startDaemonProcess(configPath, root, "before-accept");
    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/agents/${accepted.agentId}`);
      return response.ok ? ((await response.json()) as { status: string }).status : "unavailable";
    }, { timeout: 12_000, interval: 100 }).toBe("interrupted");

    const finalStore = createStore(dataDirectory);
    const finalAgent = finalStore.getAgent(accepted.agentId);
    const finalFollowUp = finalStore.getMetadata<Record<string, unknown>>(`agent-follow-up:${accepted.agentId}`);
    finalStore.close();
    expect(finalAgent?.error).toContain("cannot prove whether the pending follow-up was accepted");
    expect(finalFollowUp).toMatchObject({ state: "outcome-unknown" });
    expect(lines(join(root, ".fixture-cursor-dispatches"))).toHaveLength(1);
    expect(lines(join(root, ".fixture-cursor-followup-entered"))).toHaveLength(1);

    process.kill(secondDaemon.daemonPid, "SIGTERM");
    await waitForExit(secondDaemon.child);
    ownedDaemonPids.delete(secondDaemon.daemonPid);
  }, 30_000);
});
