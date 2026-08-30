import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../packages/storage/src/index.js";

const repositoryRoot = resolve(".");
const daemonRunner = resolve("tests/fixtures/daemon-process.ts");
const fixtureCli = resolve("tests/fixtures/claude-durable-cli.mjs");
const tsx = resolve("node_modules/.bin/tsx");
const daemonSecret = "c".repeat(64);
const providerSecret = "sk-p-fixture-provider-secret-123456789";
const oauthSecret = "claude-oauth-fixture-secret-123456789";
const awsSecret = "aws-fixture-secret-access-key-123456789";
const genericPassword = "fixture-database-password-123456789";
const pgPassword = "p";
const databaseUrl = "postgresql://fixture:db@127.0.0.1:5432/example";
const redisAuth = "r#";
const githubPat = "g$";
const embeddedConnectionUrl = "amqp://fixture:mq@127.0.0.1:5672/example";
const providerLeakFragments = [
  providerSecret,
  providerSecret.replace(pgPassword, "[REDACTED]"),
  oauthSecret,
  awsSecret,
  genericPassword,
  databaseUrl,
  redisAuth,
  githubPat,
  embeddedConnectionUrl,
  "fixture pg credential=p",
  "fixture pg credential concatenated=xpx",
];
const temporary: string[] = [];
const ownedProcessGroups = new Set<number>();
const ownedDaemonPids = new Set<number>();
const daemons = new Set<ChildProcess>();

afterEach(() => {
  for (const daemonPid of ownedDaemonPids) {
    try { process.kill(daemonPid, "SIGKILL"); } catch { /* exact daemon already exited */ }
  }
  ownedDaemonPids.clear();
  for (const daemon of daemons) if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
  daemons.clear();
  for (const processGroup of ownedProcessGroups) {
    try {
      if (process.platform === "win32") process.kill(processGroup, "SIGKILL");
      else process.kill(-processGroup, "SIGKILL");
    } catch { /* retained host already exited */ }
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
    env: {
      ...process.env,
      DEBUG_CLAUDE_AGENT_SDK: "1",
      SYMPHONY_DAEMON_SECRET: daemonSecret,
      // Intentionally insert the one-character credential before the longer
      // overlapping provider key. Redaction must not depend on env order.
      PGPASSWORD: pgPassword,
      ANTHROPIC_API_KEY: providerSecret,
      CLAUDE_CODE_OAUTH_TOKEN: oauthSecret,
      AWS_SECRET_ACCESS_KEY: awsSecret,
      FIXTURE_DATABASE_PASSWORD: genericPassword,
      DATABASE_URL: databaseUrl,
      REDISCLI_AUTH: redisAuth,
      GITHUB_PAT: githubPat,
      FIXTURE_CONNECTION_URL: embeddedConnectionUrl,
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

describe("daemon Claude worker-host durability", () => {
  it("reattaches one SDK host, replays one terminal result, and resumes the same Claude session", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-claude-durability-"));
    temporary.push(root);
    const dataDirectory = join(root, "data");
    const configPath = join(root, "symphony.config.json");
    const port = await availablePort();
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      dataDirectory,
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 3_000 },
      conductor: { harness: "claude", model: "auto" },
      agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access", startupTimeoutMs: 8_000, recoveryTimeoutMs: 8_000 },
      workerHosts: { enabled: true, maxSpoolBytes: 8_388_608, maxSpoolFrames: 10_000 },
      harnesses: {
        codex: { enabled: false }, cursor: { enabled: false }, opencode: { enabled: false }, pi: { enabled: false },
        claude: { enabled: true, process: { command: process.execPath, args: [fixtureCli, "--fixture-root", root, "--block-initial-acceptance", "--emit-sensitive-stderr"] } },
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
      headers: { "content-type": "application/json", "idempotency-key": "test-thread-claude-crash" },
      body: JSON.stringify({ title: "Claude daemon crash durability", workspacePath: root }),
    }).then((response) => response.json()) as { id: string };
    const accepted = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "durable-claude-turn", content: "Complete across a daemon crash.", attachments: [] }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Claude fixture turn was rejected: ${response.status} ${await response.text()}`);
      return await response.json() as { agentId: string };
    });

    let initialLease: ReturnType<ReturnType<typeof createStore>["getWorkerProcessLease"]> = null;
    await expect.poll(() => {
      const store = createStore(dataDirectory);
      try {
        const lease = store.listWorkerProcessLeases({ agentId: accepted.agentId, states: ["running"] })[0] ?? null;
        if (
          lease?.transport.kind === "worker-host"
          && lease.nativeSessionId === `claude-pending:${accepted.agentId}`
          && lease.nativeRunId === lease.nativeSessionId
          && lease.activeTurnId === lease.nativeSessionId
          && lease.adapterState
          && typeof lease.adapterState === "object"
          && !Array.isArray(lease.adapterState)
          && lease.adapterState.initialDispatch
          && typeof lease.adapterState.initialDispatch === "object"
          && !Array.isArray(lease.adapterState.initialDispatch)
          && lease.adapterState.initialDispatch.state === "dispatching"
          && lines(join(root, ".fixture-claude-native-dispatches")).length === 1
        ) initialLease = lease;
        return Boolean(initialLease);
      } finally { store.close(); }
    }, { timeout: 8_000, interval: 40 }).toBe(true);
    if (!initialLease || initialLease.transport.kind !== "worker-host") throw new Error("Hosted Claude lease was not established.");
    const leaseId = initialLease.id;
    const firstOwner = initialLease.daemonOwnerId;
    const hostPid = initialLease.transport.hostIdentity?.pid;
    const sdkHostPid = initialLease.transport.workerIdentity?.pid;
    if (!hostPid || !sdkHostPid) throw new Error("Claude worker host and SDK host identities were not captured.");
    ownedProcessGroups.add(hostPid);
    expect(lines(join(root, ".fixture-claude-native-dispatches"))).toEqual(["fixture-claude-turn-1"]);
    const nativePid = Number(lines(join(root, ".fixture-claude-native-launches"))[0]);
    expect(nativePid).toBeGreaterThan(0);
    const nativeArgv = lines(join(root, ".fixture-claude-native-argv")).join("\n");
    const liveNativeCommand = execFileSync("ps", ["-ww", "-p", String(nativePid), "-o", "command="], { encoding: "utf8" });
    expect(`${nativeArgv}\n${liveNativeCommand}`).not.toContain(daemonSecret);
    expect(`${nativeArgv}\n${liveNativeCommand}`).not.toContain(createHmac("sha256", daemonSecret).update(accepted.agentId).digest("hex"));
    expect(`${nativeArgv}\n${liveNativeCommand}`).not.toContain(providerSecret);
    for (const fragment of providerLeakFragments) expect(`${nativeArgv}\n${liveNativeCommand}`).not.toContain(fragment);
    expect(nativeArgv).toContain("--emit-sensitive-stderr");
    expect(lines(join(root, ".fixture-claude-debug-env"))).toEqual(["<unset>"]);
    expect(lines(join(root, ".fixture-claude-token-env"))).toEqual(["present"]);

    process.kill(firstDaemon.daemonPid, "SIGKILL");
    await waitForExit(firstDaemon.child);
    ownedDaemonPids.delete(firstDaemon.daemonPid);
    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(sdkHostPid, 0)).not.toThrow();
    writeFileSync(join(root, ".fixture-claude-release-initial-acceptance"), "release\n");

    // The Claude CLI turn finishes while no daemon owns the SDK host. Its SDK
    // messages remain in the authenticated worker-host spool.
    await new Promise((resolveWait) => setTimeout(resolveWait, 3_700));
    expect(() => process.kill(sdkHostPid, 0)).not.toThrow();
    expect(lines(join(root, ".fixture-claude-native-dispatches"))).toEqual(["fixture-claude-turn-1"]);
    const agentToken = createHmac("sha256", daemonSecret).update(accepted.agentId).digest("hex");
    const detachedSpool = readFileSync(initialLease.transport.spoolPath, "utf8");
    expect(detachedSpool.length).toBeGreaterThan(0);
    expect(detachedSpool).not.toContain(daemonSecret);
    expect(detachedSpool).not.toContain(agentToken);
    expect(detachedSpool).not.toContain(providerSecret);
    for (const fragment of providerLeakFragments) expect(detachedSpool).not.toContain(fragment);

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
    expect(adopted?.nativeSessionId).toBe("fixture-claude-session");
    expect(adopted?.transport).toMatchObject({
      kind: "worker-host",
      hostIdentity: { pid: hostPid },
      workerIdentity: { pid: sdkHostPid },
    });
    expect(adopted?.adapterState).toMatchObject({ sessionId: "fixture-claude-session", running: false, settled: true });
    expect(leases).toHaveLength(1);
    expect(lines(join(root, ".fixture-claude-native-launches"))).toHaveLength(1);
    expect(lines(join(root, ".fixture-claude-native-dispatches"))).toEqual(["fixture-claude-turn-1"]);
    expect(events.filter((event) => event.type === "supervisor.process.reserved")).toHaveLength(1);
    expect(events.filter((event) => event.type === "supervisor.host.adopted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.output.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.run.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.session.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.tool.updated")).toHaveLength(2);
    expect(events.filter((event) => ["agent.interrupted", "agent.failed"].includes(event.type))).toHaveLength(0);

    const serializedLeaseAndEvents = JSON.stringify({ adopted, events });
    expect(serializedLeaseAndEvents).not.toContain(daemonSecret);
    expect(serializedLeaseAndEvents).not.toContain(agentToken);
    expect(serializedLeaseAndEvents).not.toContain(providerSecret);
    for (const fragment of providerLeakFragments) expect(serializedLeaseAndEvents).not.toContain(fragment);
    expect(serializedLeaseAndEvents).toContain("[REDACTED]");
    const spool = readFileSync((adopted?.transport as { spoolPath: string }).spoolPath, "utf8");
    expect(spool).not.toContain(daemonSecret);
    expect(spool).not.toContain(agentToken);
    expect(spool).not.toContain(providerSecret);
    for (const fragment of providerLeakFragments) expect(spool).not.toContain(fragment);

    const followUp = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "durable-claude-follow-up", content: "Continue in the same Claude session.", attachments: [] }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Claude retained follow-up failed: ${response.status} ${await response.text()}`);
      return await response.json() as { agentId: string };
    });
    expect(followUp.agentId).toBe(accepted.agentId);
    await expect.poll(() => lines(join(root, ".fixture-claude-native-dispatches")).length, { timeout: 8_000, interval: 100 }).toBe(2);
    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/agents/${accepted.agentId}`);
      if (!response.ok) return "unavailable";
      return ((await response.json()) as { status: string }).status;
    }, { timeout: 8_000, interval: 40 }).toBe("running");
    const steering = await fetch(`${base}/v1/agents/${accepted.agentId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "claude-steering-fixture-1" },
      body: JSON.stringify({ content: "Queue this while the retained Claude turn is active." }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Claude in-flight steering failed: ${response.status} ${await response.text()}`);
      return await response.json() as { queued: boolean };
    });
    expect(steering.queued).toBe(true);
    await expect.poll(() => lines(join(root, ".fixture-claude-native-dispatches")).length, { timeout: 8_000, interval: 100 }).toBe(3);
    const betweenTurns = createStore(dataDirectory);
    const betweenTurnEvents = betweenTurns.eventsAfter(0, { agentId: accepted.agentId, limit: 10_000 });
    betweenTurns.close();
    expect(betweenTurnEvents.filter((event) => event.type === "driver.run.completed")).toHaveLength(1);
    await expect.poll(() => {
      const current = createStore(dataDirectory);
      try {
        return current.eventsAfter(0, { agentId: accepted.agentId, limit: 10_000 }).filter((event) => event.type === "driver.run.completed").length;
      } finally { current.close(); }
    }, { timeout: 8_000, interval: 100 }).toBe(2);
    expect(lines(join(root, ".fixture-claude-native-dispatches"))).toEqual(["fixture-claude-turn-1", "fixture-claude-turn-2", "fixture-claude-turn-3"]);
    expect(lines(join(root, ".fixture-claude-native-launches"))).toHaveLength(1);
    expect(lines(join(root, ".fixture-claude-native-sessions"))).toEqual(["fixture-claude-session"]);

    const finalStore = createStore(dataDirectory);
    const finalLease = finalStore.getWorkerProcessLease(leaseId);
    finalStore.close();
    expect(finalLease?.transport).toMatchObject({ kind: "worker-host", hostIdentity: { pid: hostPid }, workerIdentity: { pid: sdkHostPid } });

    process.kill(secondDaemon.daemonPid, "SIGTERM");
    await waitForExit(secondDaemon.child);
    ownedDaemonPids.delete(secondDaemon.daemonPid);
  }, 45_000);

  it("orders in-flight input and cancels without dispatching queued work", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-claude-cancel-"));
    temporary.push(root);
    const dataDirectory = join(root, "data");
    const configPath = join(root, "symphony.config.json");
    const port = await availablePort();
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      dataDirectory,
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 3_000 },
      conductor: { harness: "claude", model: "auto" },
      agents: {
        maxDepth: null,
        maxConcurrent: null,
        defaultPermissions: "full-access",
        startupTimeoutMs: 8_000,
        recoveryTimeoutMs: 8_000,
        cancellationAcknowledgementTimeoutMs: 5_000,
        cancellationTerminationGraceMs: 5_000,
      },
      workerHosts: { enabled: true, maxSpoolBytes: 8_388_608, maxSpoolFrames: 10_000 },
      harnesses: {
        codex: { enabled: false }, cursor: { enabled: false }, opencode: { enabled: false }, pi: { enabled: false },
        claude: { enabled: true, process: { command: process.execPath, args: [fixtureCli, "--fixture-root", root, "--emit-sensitive-stderr"] } },
        acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      uiUtilities: { provider: "deterministic", chatTitles: false },
      plugins: { watch: false },
    }));

    const daemon = await startDaemonProcess(configPath);
    const base = `http://127.0.0.1:${port}`;
    const thread = await fetch(`${base}/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "test-thread-claude-cancel" },
      body: JSON.stringify({ title: "Claude cancellation", workspacePath: root }),
    }).then((response) => response.json()) as { id: string };
    const accepted = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "cancel-claude-turn", content: "Remain active until cancelled.", attachments: [] }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Claude cancellation fixture was rejected: ${response.status} ${await response.text()}`);
      return await response.json() as { agentId: string };
    });

    await expect.poll(() => lines(join(root, ".fixture-claude-native-dispatches")).length, { timeout: 8_000, interval: 50 }).toBe(1);
    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/agents/${accepted.agentId}`);
      return response.ok ? ((await response.json()) as { status: string }).status : "unavailable";
    }, { timeout: 8_000, interval: 50 }).toBe("running");
    const initialStore = createStore(dataDirectory);
    const lease = initialStore.listWorkerProcessLeases({ agentId: accepted.agentId })[0];
    initialStore.close();
    if (!lease || lease.transport.kind !== "worker-host" || !lease.transport.hostIdentity?.pid) {
      throw new Error("Claude cancellation fixture did not establish a hosted lease.");
    }
    ownedProcessGroups.add(lease.transport.hostIdentity.pid);

    const queued = await fetch(`${base}/v1/agents/${accepted.agentId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "claude-queued-cancel-fixture-1" },
      body: JSON.stringify({ content: "This queued prompt must never reach Claude after cancellation." }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Claude queued cancellation input failed: ${response.status} ${await response.text()}`);
      return await response.json() as { queued: boolean };
    });
    expect(queued.queued).toBe(true);

    const cancel = await fetch(`${base}/v1/agents/${accepted.agentId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "claude-cancel-fixture-1" },
      body: "{}",
    });
    expect(cancel.status).toBe(204);
    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/agents/${accepted.agentId}`);
      if (!response.ok) return "unavailable";
      return ((await response.json()) as { status: string }).status;
    }, { timeout: 8_000, interval: 100 }).toBe("cancelled");

    await new Promise((resolveWait) => setTimeout(resolveWait, 3_500));
    expect(lines(join(root, ".fixture-claude-native-dispatches"))).toEqual(["fixture-claude-turn-1"]);
    expect(lines(join(root, ".fixture-claude-native-launches"))).toHaveLength(1);
    expect(lines(join(root, ".fixture-claude-debug-env"))).toEqual(["<unset>"]);

    const finalStore = createStore(dataDirectory);
    const events = finalStore.eventsAfter(0, { agentId: accepted.agentId, limit: 10_000 });
    const finalLease = finalStore.listWorkerProcessLeases({ agentId: accepted.agentId })[0] ?? null;
    finalStore.close();
    expect(events.filter((event) => event.type === "driver.session.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.run.cancelled")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.run.completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "agent.cancelled")).toHaveLength(1);
    const agentToken = createHmac("sha256", daemonSecret).update(accepted.agentId).digest("hex");
    const persisted = JSON.stringify({ finalLease, events });
    expect(persisted).not.toContain(daemonSecret);
    expect(persisted).not.toContain(agentToken);
    expect(persisted).not.toContain(providerSecret);
    for (const fragment of providerLeakFragments) expect(persisted).not.toContain(fragment);
    if (finalLease?.transport.kind === "worker-host" && existsSync(finalLease.transport.spoolPath)) {
      const spool = readFileSync(finalLease.transport.spoolPath, "utf8");
      expect(spool).not.toContain(daemonSecret);
      expect(spool).not.toContain(agentToken);
      expect(spool).not.toContain(providerSecret);
      for (const fragment of providerLeakFragments) expect(spool).not.toContain(fragment);
    }

    process.kill(daemon.daemonPid, "SIGTERM");
    await waitForExit(daemon.child);
    ownedDaemonPids.delete(daemon.daemonPid);
  }, 25_000);

  it("fails closed when Claude never acknowledges interrupt and termination is unproved", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-claude-hung-cancel-"));
    temporary.push(root);
    const dataDirectory = join(root, "data");
    const configPath = join(root, "symphony.config.json");
    const port = await availablePort();
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      dataDirectory,
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 3_000 },
      conductor: { harness: "claude", model: "auto" },
      agents: {
        maxDepth: null,
        maxConcurrent: null,
        defaultPermissions: "full-access",
        startupTimeoutMs: 8_000,
        recoveryTimeoutMs: 8_000,
        cancellationAcknowledgementTimeoutMs: 1_500,
        cancellationTerminationGraceMs: 1_500,
      },
      workerHosts: { enabled: true, maxSpoolBytes: 8_388_608, maxSpoolFrames: 10_000 },
      harnesses: {
        codex: { enabled: false }, cursor: { enabled: false }, opencode: { enabled: false }, pi: { enabled: false },
        claude: { enabled: true, process: { command: process.execPath, args: [fixtureCli, "--fixture-root", root, "--hang-interrupt", "--emit-sensitive-stderr"] } },
        acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      uiUtilities: { provider: "deterministic", chatTitles: false },
      plugins: { watch: false },
    }));

    const daemon = await startDaemonProcess(configPath);
    const base = `http://127.0.0.1:${port}`;
    const thread = await fetch(`${base}/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "test-thread-claude-hung-cancel" },
      body: JSON.stringify({ title: "Claude hung cancellation", workspacePath: root }),
    }).then((response) => response.json()) as { id: string };
    const accepted = await fetch(`${base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "hung-cancel-claude-turn", content: "Remain active and ignore interrupt.", attachments: [] }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Claude hung-cancel fixture was rejected: ${response.status} ${await response.text()}`);
      return await response.json() as { agentId: string };
    });
    await expect.poll(() => lines(join(root, ".fixture-claude-native-dispatches")).length, { timeout: 8_000, interval: 50 }).toBe(1);
    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/agents/${accepted.agentId}`);
      return response.ok ? ((await response.json()) as { status: string }).status : "unavailable";
    }, { timeout: 8_000, interval: 50 }).toBe("running");
    const initialStore = createStore(dataDirectory);
    const lease = initialStore.listWorkerProcessLeases({ agentId: accepted.agentId })[0];
    initialStore.close();
    if (!lease || lease.transport.kind !== "worker-host" || !lease.transport.hostIdentity?.pid) throw new Error("Hung-cancel hosted lease was not established.");
    ownedProcessGroups.add(lease.transport.hostIdentity.pid);

    const queued = await fetch(`${base}/v1/agents/${accepted.agentId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "claude-hung-cancel-steer" },
      body: JSON.stringify({ content: "This pending prompt must be discarded." }),
    });
    expect(queued.status).toBe(202);
    const cancelStartedAt = Date.now();
    const cancel = await fetch(`${base}/v1/agents/${accepted.agentId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "claude-hung-cancel" },
      body: "{}",
    });
    expect(cancel.status).toBe(204);
    expect(Date.now() - cancelStartedAt).toBeLessThan(7_000);
    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/agents/${accepted.agentId}`);
      return response.ok ? ((await response.json()) as { status: string }).status : "unavailable";
    }, { timeout: 8_000, interval: 100 }).toBe("interrupted");
    await new Promise((resolveWait) => setTimeout(resolveWait, 800));
    expect(lines(join(root, ".fixture-claude-native-dispatches"))).toEqual(["fixture-claude-turn-1"]);

    const finalStore = createStore(dataDirectory);
    const events = finalStore.eventsAfter(0, { agentId: accepted.agentId, limit: 10_000 });
    const finalLease = finalStore.listWorkerProcessLeases({ agentId: accepted.agentId })[0] ?? null;
    finalStore.close();
    expect(events.filter((event) => event.type === "driver.run.cancelled")).toHaveLength(0);
    expect(events.filter((event) => event.type === "agent.cancelled")).toHaveLength(0);
    expect(events.filter((event) => event.type === "agent.cancel.escalated")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent.interrupted")).toHaveLength(1);
    const agentToken = createHmac("sha256", daemonSecret).update(accepted.agentId).digest("hex");
    const persisted = JSON.stringify({ finalLease, events });
    expect(persisted).not.toContain(daemonSecret);
    expect(persisted).not.toContain(agentToken);
    expect(persisted).not.toContain(providerSecret);
    for (const fragment of providerLeakFragments) expect(persisted).not.toContain(fragment);

    process.kill(daemon.daemonPid, "SIGTERM");
    await waitForExit(daemon.child);
    ownedDaemonPids.delete(daemon.daemonPid);
  }, 25_000);
});
