import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type SymphonyStore } from "../../packages/storage/src/index.js";
import { compileObjectiveControlPlan, WorkflowCompiler, type WorkflowDefinition } from "../../packages/workflow/src/index.js";

const repositoryRoot = resolve(".");
const daemonRunner = resolve("tests/fixtures/process-crash-daemon.ts");
const codexFixture = resolve("tests/fixtures/process-crash-native.mjs");
const cursorSdkFixture = resolve("tests/fixtures/cursor-sdk-fixture.mjs");
const cursorCliFixture = resolve("tests/fixtures/cursor-durable-cli.mjs");
const tsx = resolve("node_modules/.bin/tsx");
const daemonSecret = "7c".repeat(32);
const cursorApiKey = "process-crash-cursor-fixture-key";
const temporary: string[] = [];
const ownedDataDirectories = new Set<string>();
const daemons = new Set<ChildProcess>();
const ownedPids = new Set<number>();

afterEach(async () => {
  for (const daemon of daemons) {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
  }
  await Promise.all([...daemons].map((daemon) => waitForExit(daemon)));
  // Recover any lease identities even if an assertion failed between native
  // process launch and the test's normal PID capture. Every identity here is
  // read from one of this test's isolated SQLite directories.
  for (const dataDirectory of ownedDataDirectories) {
    try {
      const store = storeAt(dataDirectory);
      for (const lease of store.listWorkerProcessLeases()) {
        if (lease.transport.kind !== "worker-host") continue;
        if (lease.transport.hostIdentity?.pid) ownedPids.add(lease.transport.hostIdentity.pid);
        if (lease.transport.workerIdentity?.pid) ownedPids.add(lease.transport.workerIdentity.pid);
      }
      store.close();
    } catch { /* a failed daemon may not have initialized SQLite */ }
  }
  // Every signal target is a PID captured from a child readiness/lease record;
  // never broadcast a signal to a process group or to an inferred PID.
  for (const pid of ownedPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
  }
  ownedPids.clear();
  ownedDataDirectories.clear();
  daemons.clear();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate process-crash test port."));
      server.close(() => resolvePort(address.port));
    });
  });
}

function lines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split(/\r?\n/u).filter(Boolean);
}

function sseProjectedEvents(events: Array<{ cursor: number; type: string; payload: unknown }>): Array<{ cursor: number; type: string; payload: unknown }> {
  const latestChatUpdate = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "chat.message.updated" || typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) continue;
    const payload = event.payload as Record<string, unknown>;
    const message = typeof payload.message === "object" && payload.message !== null && !Array.isArray(payload.message)
      ? payload.message as Record<string, unknown>
      : null;
    const messageId = typeof payload.messageId === "string" ? payload.messageId : typeof message?.id === "string" ? message.id : null;
    if (messageId) latestChatUpdate.set(messageId, event.cursor);
  }
  return events.filter((event) => {
    if (event.type !== "chat.message.updated" || typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return true;
    const payload = event.payload as Record<string, unknown>;
    const message = typeof payload.message === "object" && payload.message !== null && !Array.isArray(payload.message)
      ? payload.message as Record<string, unknown>
      : null;
    const messageId = typeof payload.messageId === "string" ? payload.messageId : typeof message?.id === "string" ? message.id : null;
    return messageId ? latestChatUpdate.get(messageId) === event.cursor : true;
  });
}

function storeAt(dataDirectory: string): SymphonyStore {
  return createStore(dataDirectory);
}

function writeConfig(
  root: string,
  dataDirectory: string,
  port: number,
  overrides: Record<string, unknown> = {},
): string {
  const configPath = join(root, "process-crash.config.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    dataDirectory,
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 500 },
    conductor: { harness: "codex", model: "fixture" },
    agents: {
      maxDepth: null,
      maxConcurrent: 4,
      defaultPermissions: "full-access",
      startupTimeoutMs: 8_000,
      recoveryTimeoutMs: 8_000,
      recoveryConcurrency: 2,
      cancellationAcknowledgementTimeoutMs: 250,
      cancellationTerminationGraceMs: 250,
    },
    workerHosts: { enabled: true, maxSpoolBytes: 8_388_608, maxSpoolFrames: 10_000 },
    harnesses: {
      codex: { enabled: true, process: { command: process.execPath, args: [codexFixture] } },
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
    ...overrides,
  }));
  return configPath;
}

type StartedDaemon = { child: ChildProcess; pid: number };

async function startDaemonProcess(configPath: string, extraEnvironment: Record<string, string> = {}): Promise<StartedDaemon> {
  const child = spawn(tsx, ["--tsconfig", resolve("tsconfig.json"), daemonRunner, configPath, repositoryRoot], {
    cwd: repositoryRoot,
    env: { ...process.env, SYMPHONY_DAEMON_SECRET: daemonSecret, ...extraEnvironment },
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
      reject(new Error(`Process-crash daemon did not become ready. ${stderr}`));
    }, 10_000);
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/u)) {
        if (!line.includes('"type":"ready"')) continue;
        try {
          const ready = JSON.parse(line) as { type?: string; pid?: number };
          if (ready.type !== "ready" || !ready.pid) continue;
          if (settled) return;
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
      reject(new Error(`Process-crash daemon exited before readiness (code=${String(code)}, signal=${String(signal)}). ${stderr}`));
    });
  });
  ownedPids.add(pid);
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

async function json(base: string, path: string, init: RequestInit = {}): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { response, body };
}

async function killDaemon(daemon: StartedDaemon): Promise<void> {
  ownedPids.delete(daemon.pid);
  process.kill(daemon.pid, "SIGKILL");
  await waitForExit(daemon.child);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
}

type SseReader = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  initial: Uint8Array;
};

async function firstSseFrame(base: string, after = 0): Promise<SseReader> {
  const response = await fetch(`${base}/v1/events?after=${after}`);
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Process-crash event stream did not expose a reader.");
  const first = await reader.read();
  expect(first.done).toBe(false);
  return { reader, initial: first.value ?? new Uint8Array() };
}

async function readSseThrough(
  stream: SseReader,
  stop: (event: Record<string, any>) => boolean,
  timeout = 10_000,
): Promise<Record<string, any>[]> {
  const decoder = new TextDecoder();
  const events: Record<string, any>[] = [];
  let buffer = decoder.decode(stream.initial, { stream: true });
  const reader = stream.reader;
  const consumeFrames = (): boolean => {
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split(/\r?\n/u).find((line) => line.startsWith("data: "))?.slice(6);
      if (!data) continue;
      const event = JSON.parse(data) as Record<string, any>;
      events.push(event);
      if (stop(event)) return true;
    }
    return false;
  };
  if (consumeFrames()) return events;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      sleep(remaining).then(() => ({ timeout: true } as const)),
    ]);
    if ("timeout" in result) throw new Error("Timed out waiting for process-crash SSE replay.");
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    if (consumeFrames()) return events;
  }
  throw new Error("Timed out waiting for process-crash SSE replay.");
}

function crashWorkflow(root: string): WorkflowDefinition {
  return {
    id: "process-crash-control-workflow",
    name: "Process crash control acceptance",
    mission: { statement: "Rehydrate durable timer and signal control after a daemon process crash.", keyResults: ["Control waits are restored exactly once."] },
    workspace: { path: root, dirtyPolicy: "local-only" },
    inputSchema: { type: "object", additionalProperties: true },
    output: "steps",
    steps: [{
      id: "control-sequence",
      type: "sequence",
      steps: [
        { id: "timer-gate", type: "timer", durationMs: 450, expiresAfterMs: 2_000 },
        { id: "signal-gate", type: "signal", signalKey: "process-crash.ready", expiresAfterMs: 4_000, payloadSchema: { status: "string" } },
      ],
    }],
    triggers: [{ id: "manual", type: "manual" }],
  };
}

function objectiveBody(workflow: ReturnType<WorkflowCompiler["compile"]>, plan: ReturnType<typeof compileObjectiveControlPlan>, root: string, runId: string): Record<string, unknown> {
  return {
    runId,
    objectiveId: `${runId}-objective`,
    workflowId: workflow.definition.id,
    workflowRevision: workflow.revision,
    workflowHash: workflow.hash,
    workspace: { path: root, dirtyPolicy: "local-only" },
    policy: { budget: {} },
    spec: {
      id: `${runId}-objective`,
      statement: "Rehydrate timer and signal controls after a real process crash.",
      criteria: [],
      approvalPolicy: { mode: "never" },
      maxReplans: 0,
    },
    context: { seed: Number.parseInt(process.env.SYMPHONY_PROCESS_CRASH_SEED ?? "1", 10) || 1 },
    controlPlan: plan,
  };
}

function suspension(dataDirectory: string, runId: string, nodeId: string): any {
  const store = storeAt(dataDirectory);
  try {
    return store.listObjectiveControlSuspensions(runId).find((entry) => entry.nodeId === nodeId) ?? null;
  } finally {
    store.close();
  }
}

describe("process-boundary durability acceptance", () => {
  it("keeps native work authoritative after SSE disconnect and daemon SIGKILL, with exact cursor replay", async () => {
    const seed = Number.parseInt(process.env.SYMPHONY_PROCESS_CRASH_SEED ?? "1", 10) || 1;
    const root = mkdtempSync(join(tmpdir(), `symphony-process-crash-native-${seed}-`));
    temporary.push(root);
    const dataDirectory = join(root, "sqlite");
    ownedDataDirectories.add(dataDirectory);
    const port = await availablePort();
    const configPath = writeConfig(root, dataDirectory, port);
    const first = await startDaemonProcess(configPath, { SYMPHONY_PROCESS_CRASH_SEED: String(seed) });
    const base = `http://127.0.0.1:${port}`;
    let reader: SseReader | undefined;
    try {
      await waitForHealth(base);
      reader = await firstSseFrame(base);
      const thread = await json(base, "/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `process-crash-thread-${seed}` },
        body: JSON.stringify({ title: "Process crash authority", workspacePath: root }),
      });
      expect(thread.response.status).toBe(201);
      const accepted = await json(base, `/v1/threads/${thread.body.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: `process-crash-turn-${seed}`, content: "Continue across a daemon process crash.", attachments: [] }),
      });
      expect(accepted.response.status).toBe(202);
      const agentId = accepted.body.agentId as string;
      const beforeStore = storeAt(dataDirectory);
      let lease: ReturnType<typeof beforeStore.getWorkerProcessLease> = null;
      try {
        await waitFor(() => {
          lease = beforeStore.listWorkerProcessLeases({ agentId, states: ["running"] })[0] ?? null;
          expect(lease?.transport.kind).toBe("worker-host");
          expect(lease?.nativeSessionId).toEqual(expect.any(String));
          expect(lease?.nativeRunId).toEqual(expect.any(String));
        });
        const baselineCursor = beforeStore.latestCursor();
        if (!lease || lease.transport.kind !== "worker-host") throw new Error("Native worker-host lease did not materialize.");
        const hostPid = lease.transport.hostIdentity?.pid;
        const workerPid = lease.transport.workerIdentity?.pid;
        if (!hostPid || !workerPid) throw new Error("Native process identities were not captured.");
        ownedPids.add(hostPid);
        ownedPids.add(workerPid);
        expect(lease.nativeSessionId).toEqual(expect.any(String));
        expect(lease.nativeRunId).toEqual(expect.any(String));
        await reader.reader.cancel();
        reader = undefined;

        await killDaemon(first);
        expect(() => process.kill(hostPid, 0)).not.toThrow();
        expect(() => process.kill(workerPid, 0)).not.toThrow();
        // The native child finishes while no daemon or browser/SSE client is
        // present; its worker-host spool is the only continuity authority.
        await sleep(1_500 + (seed % 5) * 80);
        expect(lines(join(root, ".process-crash-dispatches"))).toHaveLength(1);

        const second = await startDaemonProcess(configPath, { SYMPHONY_PROCESS_CRASH_SEED: String(seed) });
        await waitForHealth(base);
        await waitFor(async () => {
          const response = await fetch(`${base}/v1/agents/${agentId}`);
          expect(response.status).toBe(200);
          expect((await response.json() as { status: string }).status).toBe("completed");
        });

        const afterStore = storeAt(dataDirectory);
        let highWater = 0;
        try {
          const adopted = afterStore.getWorkerProcessLease(lease.id);
          expect(adopted?.daemonOwnerId).not.toBe(lease.daemonOwnerId);
          expect(adopted?.nativeSessionId).toBe(lease.nativeSessionId);
          expect(adopted?.transport).toMatchObject({ kind: "worker-host", hostIdentity: { pid: hostPid }, workerIdentity: { pid: workerPid } });
          const events = afterStore.eventsAfter(0, { agentId, limit: 10_000 });
          expect(events.filter((event) => event.type === "driver.output.completed")).toHaveLength(1);
          expect(events.filter((event) => event.type === "driver.run.completed")).toHaveLength(1);
          expect(events.filter((event) => event.type === "agent.interrupted")).toHaveLength(0);
          expect(lines(join(root, ".process-crash-forbidden-resumes"))).toHaveLength(0);
          highWater = afterStore.latestCursor();
          const replayExpected = sseProjectedEvents(afterStore.eventsAfter(baselineCursor, { limit: 10_000 }).filter((event) => event.cursor <= highWater));
          expect(replayExpected.length).toBeGreaterThan(0);
          const replayReader = await firstSseFrame(base, baselineCursor);
          try {
            const replayed = await readSseThrough(replayReader, (event) => event.type === "driver.run.completed");
            const replayHighWater = replayed.at(-1)?.cursor ?? 0;
            const expectedThroughTerminal = replayExpected.filter((event) => event.cursor <= replayHighWater);
            expect(replayed.map((event) => event.cursor)).toEqual(expectedThroughTerminal.map((event) => event.cursor));
            expect(replayed.map((event) => event.id)).toEqual(expectedThroughTerminal.map((event) => event.id));
            expect(new Set(replayed.map((event) => event.cursor)).size).toBe(replayed.length);
          } finally {
            await replayReader.reader.cancel();
          }
        } finally {
          afterStore.close();
        }
        ownedPids.delete(second.pid);
        process.kill(second.pid, "SIGTERM");
        await waitForExit(second.child);
      } finally {
        beforeStore.close();
      }
    } finally {
      if (reader) await reader.reader.cancel();
    }
  }, 35_000);

  it("rehydrates a timer and signal frontier across daemon processes and fences replayed delivery", async () => {
    const seed = Number.parseInt(process.env.SYMPHONY_PROCESS_CRASH_SEED ?? "1", 10) || 1;
    const root = mkdtempSync(join(tmpdir(), `symphony-process-crash-control-${seed}-`));
    temporary.push(root);
    const dataDirectory = join(root, "sqlite");
    ownedDataDirectories.add(dataDirectory);
    const workflowsDirectory = join(root, "workflows");
    const port = await availablePort();
    const definition = crashWorkflow(root);
    const compiled = new WorkflowCompiler().compile(definition, 1);
    const plan = compileObjectiveControlPlan(compiled);
    mkdirSync(workflowsDirectory, { recursive: true });
    const configPath = writeConfig(root, dataDirectory, port, { "workflows": { directory: workflowsDirectory, triggersEnabled: false, approvalExpiryScanMs: 100 } });
    // File-backed registration makes the same workflow revision available to
    // every replacement daemon without an in-memory test hook.
    writeFileSync(join(workflowsDirectory, "process-crash-control.json"), JSON.stringify(definition));
    const first = await startDaemonProcess(configPath, { SYMPHONY_PROCESS_CRASH_SEED: String(seed) });
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(base);
      const created = await json(base, "/v1/objectives", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `process-crash-objective-${seed}` },
        body: JSON.stringify(objectiveBody(compiled, plan, root, `process-crash-run-${seed}`)),
      });
      expect(created.response.status, JSON.stringify(created.body)).toBe(201);
      const runId = `process-crash-run-${seed}`;
      await waitFor(() => expect(suspension(dataDirectory, runId, "timer-gate")?.status).toBe("waiting"));
      const timerBefore = suspension(dataDirectory, runId, "timer-gate");
      expect(timerBefore?.attemptId).toEqual(expect.any(String));
      const beforeStore = storeAt(dataDirectory);
      const baselineCursor = beforeStore.latestCursor();
      beforeStore.close();
      await killDaemon(first);

      // The replacement must observe the persisted wait and schedule the due
      // callback from SQLite; no client stream is involved in this transition.
      const second = await startDaemonProcess(configPath, { SYMPHONY_PROCESS_CRASH_SEED: String(seed) });
      await waitForHealth(base);
      await waitFor(() => expect(suspension(dataDirectory, runId, "timer-gate")?.status).toBe("delivered"), 12_000);
      await waitFor(() => expect(suspension(dataDirectory, runId, "signal-gate")?.status).toBe("waiting"), 12_000);
      const signalWait = suspension(dataDirectory, runId, "signal-gate");
      if (!signalWait) throw new Error("Signal suspension did not rehydrate.");
      expect(signalWait.subscriptionKey).toEqual(expect.any(String));
      expect(signalWait.attemptId).toEqual(expect.any(String));

      const delivery = {
        signalKey: "process-crash.ready",
        subscriptionKey: signalWait.subscriptionKey,
        attemptId: signalWait.attemptId,
        deliveryId: `process-crash-delivery-${seed}`,
        payload: { status: "ready" },
      };
      const delivered = await json(base, `/v1/objectives/${runId}/signals`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `process-crash-signal-${seed}` },
        body: JSON.stringify(delivery),
      });
      expect(delivered.response.status).toBe(200);
      expect(delivered.body).toMatchObject({ status: "delivered", deliveryId: delivery.deliveryId });
      const replay = await json(base, `/v1/objectives/${runId}/signals`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `process-crash-signal-retry-${seed}` },
        body: JSON.stringify(delivery),
      });
      expect(replay.response.status).toBe(200);
      expect(replay.body).toMatchObject({ status: "replayed", deliveryId: delivery.deliveryId });
      await waitFor(() => {
        const current = storeAt(dataDirectory);
        try { expect(current.getObjectiveRun(runId)?.state).toBe("succeeded"); } finally { current.close(); }
      }, 12_000);

      const finalStore = storeAt(dataDirectory);
      try {
        const events = finalStore.eventsAfter(0, { runId, limit: 10_000 });
        expect(events.filter((event) => event.type === "objective.control.timer.due")).toHaveLength(1);
        expect(events.filter((event) => event.type === "objective.control.signal.subscribed")).toHaveLength(1);
        expect(events.filter((event) => event.type === "objective.control.signal.delivered")).toHaveLength(1);
        expect(finalStore.listObjectiveControlSuspensions(runId).filter((entry) => entry.status === "delivered")).toHaveLength(2);
        expect(finalStore.latestCursor()).toBeGreaterThan(baselineCursor);
      } finally {
        finalStore.close();
      }
      ownedPids.delete(second.pid);
      process.kill(second.pid, "SIGTERM");
      await waitForExit(second.child);
    } finally {
      // Cleanup owns the exact replacement PID if an assertion failed before
      // the graceful shutdown above.
    }
  }, 35_000);

  it("reconciles an accepted Cursor follow-up exactly once across daemon processes", async () => {
    const seed = Number.parseInt(process.env.SYMPHONY_PROCESS_CRASH_SEED ?? "1", 10) || 1;
    const root = mkdtempSync(join(tmpdir(), `symphony-process-crash-cursor-${seed}-`));
    temporary.push(root);
    const dataDirectory = join(root, "sqlite");
    ownedDataDirectories.add(dataDirectory);
    const port = await availablePort();
    const configPath = writeConfig(root, dataDirectory, port, {
      conductor: { harness: "cursor", model: "fixture-model" },
      harnesses: {
        codex: { enabled: false },
        claude: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        acp: [],
        cursor: { enabled: true, process: { command: process.execPath, args: [cursorCliFixture] }, autoCreatePR: false },
      },
    });
    const cursorEnvironment = {
      SYMPHONY_CURSOR_HOST_SDK_MODULE: cursorSdkFixture,
      SYMPHONY_CURSOR_FIXTURE_ROOT: root,
      SYMPHONY_CURSOR_FIXTURE_DELAY_MS: "350",
      CURSOR_API_KEY: cursorApiKey,
    };
    const first = await startDaemonProcess(configPath, cursorEnvironment);
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(base);
      const thread = await json(base, "/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `process-crash-cursor-thread-${seed}` },
        body: JSON.stringify({ title: "Cursor process crash", workspacePath: root }),
      });
      const firstTurn = await json(base, `/v1/threads/${thread.body.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: `process-crash-cursor-initial-${seed}`, content: "Complete the initial native turn.", attachments: [] }),
      });
      expect(firstTurn.response.status).toBe(202);
      const agentId = firstTurn.body.agentId as string;
      await waitFor(async () => {
        const response = await fetch(`${base}/v1/agents/${agentId}`);
        expect((await response.json() as { status: string }).status).toBe("completed");
      });
      const store = storeAt(dataDirectory);
      let lease: ReturnType<typeof store.getWorkerProcessLease> = null;
      try {
        lease = store.listWorkerProcessLeases({ agentId })[0] ?? null;
        if (!lease || lease.transport.kind !== "worker-host") throw new Error("Cursor worker-host lease did not persist.");
        const hostPid = lease.transport.hostIdentity?.pid;
        const sdkPid = lease.transport.workerIdentity?.pid;
        if (!hostPid || !sdkPid) throw new Error("Cursor process identities were not captured.");
        ownedPids.add(hostPid);
        ownedPids.add(sdkPid);
        const initialDispatches = lines(join(root, ".fixture-cursor-dispatches"));
        expect(initialDispatches).toHaveLength(1);

        // Cursor's SDK accepts the follow-up before the fixture intentionally
        // blocks. Kill the daemon while the accepted side effect is only in
        // the retained host spool, then let that native run settle.
        const acceptedFollowUp = fetch(`${base}/v1/threads/${thread.body.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId: `process-crash-cursor-followup-${seed}`, content: "Continue after the process crash.", attachments: [] }),
        });
        await waitFor(() => expect(lines(join(root, ".fixture-cursor-dispatches"))).toHaveLength(2));
        await killDaemon(first);
        expect(() => process.kill(hostPid, 0)).not.toThrow();
        expect(() => process.kill(sdkPid, 0)).not.toThrow();
        writeFileSync(join(root, ".fixture-cursor-release-followup"), "release\n");
        await sleep(900);
        await acceptedFollowUp.catch(() => undefined);

        const second = await startDaemonProcess(configPath, cursorEnvironment);
        await waitForHealth(base);
        await waitFor(async () => {
          const response = await fetch(`${base}/v1/agents/${agentId}`);
          expect((await response.json() as { status: string }).status).toBe("completed");
        });
        const recovered = storeAt(dataDirectory);
        try {
          const adopted = recovered.getWorkerProcessLease(lease.id);
          expect(adopted?.transport).toMatchObject({ kind: "worker-host", hostIdentity: { pid: hostPid }, workerIdentity: { pid: sdkPid } });
          expect(lines(join(root, ".fixture-cursor-dispatches"))).toHaveLength(2);
          const events = recovered.eventsAfter(0, { agentId, limit: 10_000 });
          expect(events.filter((event) => event.type === "driver.output.completed")).toHaveLength(2);
          expect(events.filter((event) => event.type === "driver.run.completed")).toHaveLength(2);
          expect(events.filter((event) => event.type === "agent.interrupted")).toHaveLength(0);
        } finally {
          recovered.close();
        }
        ownedPids.delete(second.pid);
        process.kill(second.pid, "SIGTERM");
        await waitForExit(second.child);
      } finally {
        store.close();
      }
    } finally {
      // Exact process cleanup is centralized in afterEach.
    }
  }, 40_000);

  it("fails closed when a provider side effect is still unproven at daemon SIGKILL", async () => {
    const seed = Number.parseInt(process.env.SYMPHONY_PROCESS_CRASH_SEED ?? "1", 10) || 1;
    const root = mkdtempSync(join(tmpdir(), `symphony-process-crash-unproven-${seed}-`));
    temporary.push(root);
    const dataDirectory = join(root, "sqlite");
    ownedDataDirectories.add(dataDirectory);
    const port = await availablePort();
    const configPath = writeConfig(root, dataDirectory, port, {
      conductor: { harness: "cursor", model: "fixture-model" },
      harnesses: {
        codex: { enabled: false },
        claude: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        acp: [],
        cursor: { enabled: true, process: { command: process.execPath, args: [cursorCliFixture] }, autoCreatePR: false },
      },
    });
    const cursorEnvironment = {
      SYMPHONY_CURSOR_HOST_SDK_MODULE: cursorSdkFixture,
      SYMPHONY_CURSOR_FIXTURE_ROOT: root,
      SYMPHONY_CURSOR_FIXTURE_DELAY_MS: "350",
      SYMPHONY_CURSOR_FIXTURE_BLOCK_FOLLOWUP_BEFORE_ACCEPT: "1",
      CURSOR_API_KEY: cursorApiKey,
    };
    const first = await startDaemonProcess(configPath, cursorEnvironment);
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(base);
      const thread = await json(base, "/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `process-crash-unproven-thread-${seed}` },
        body: JSON.stringify({ title: "Unproven side effect", workspacePath: root }),
      });
      const initial = await json(base, `/v1/threads/${thread.body.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: `process-crash-unproven-initial-${seed}`, content: "Complete the initial turn.", attachments: [] }),
      });
      expect(initial.response.status).toBe(202);
      const agentId = initial.body.agentId as string;
      await waitFor(async () => {
        const response = await fetch(`${base}/v1/agents/${agentId}`);
        expect((await response.json() as { status: string }).status).toBe("completed");
      });
      const pending = fetch(`${base}/v1/threads/${thread.body.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: `process-crash-unproven-followup-${seed}`, content: "This side effect must not be replayed blindly.", attachments: [] }),
      });
      await waitFor(() => expect(lines(join(root, ".fixture-cursor-followup-entered"))).toHaveLength(1));
      await killDaemon(first);
      await pending.catch(() => undefined);

      const second = await startDaemonProcess(configPath, cursorEnvironment);
      await waitForHealth(base);
      await waitFor(async () => {
        const response = await fetch(`${base}/v1/agents/${agentId}`);
        expect((await response.json() as { status: string }).status).toBe("interrupted");
      });
      const diagnosticLogs = await json(base, `/v1/agents/${agentId}/logs?limit=100`);
      expect(diagnosticLogs.response.status).toBe(200);
      expect(diagnosticLogs.body.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "agent.interrupted", level: "warn" }),
      ]));
      const store = storeAt(dataDirectory);
      try {
        const agent = store.getAgent(agentId);
        expect(agent?.error).toMatch(/cannot prove whether the pending follow-up was accepted/u);
        expect(store.getMetadata<Record<string, unknown>>(`agent-follow-up:${agentId}`)).toMatchObject({ state: "outcome-unknown" });
        // The provider boundary was entered once, but acceptance was never
        // proven; recovery must not dispatch a second follow-up.
        expect(lines(join(root, ".fixture-cursor-dispatches"))).toHaveLength(1);
        expect(lines(join(root, ".fixture-cursor-followup-entered"))).toHaveLength(1);
        const events = store.eventsAfter(0, { agentId, limit: 10_000 });
        expect(events.filter((event) => event.type === "agent.interrupted")).toHaveLength(1);
      } finally {
        store.close();
      }
      ownedPids.delete(second.pid);
      process.kill(second.pid, "SIGTERM");
      await waitForExit(second.child);
    } finally {
      // Exact child PIDs and retained worker processes are cleaned by afterEach.
    }
  }, 40_000);

  it("rehydrates a queued follow-up from SQLite across daemon SIGKILL", async () => {
    const seed = Number.parseInt(process.env.SYMPHONY_PROCESS_CRASH_SEED ?? "1", 10) || 1;
    const root = mkdtempSync(join(tmpdir(), `symphony-process-crash-queued-${seed}-`));
    temporary.push(root);
    const dataDirectory = join(root, "sqlite");
    ownedDataDirectories.add(dataDirectory);
    const port = await availablePort();
    const configPath = writeConfig(root, dataDirectory, port, { agents: { maxConcurrent: 1 } });
    const queueEnvironment = {
      SYMPHONY_PROCESS_CRASH_QUEUE_FIXTURE: "1",
      SYMPHONY_PROCESS_CRASH_QUEUE_ROOT: root,
    };
    const first = await startDaemonProcess(configPath, queueEnvironment);
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(base);
      const created = await json(base, "/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `process-crash-queued-agent-${seed}` },
        body: JSON.stringify({
          id: `process-crash-queued-agent-${seed}`,
          workflowId: `process-crash-queued-workflow-${seed}`,
          runId: `process-crash-queued-run-${seed}`,
          parentAgentId: null,
          depth: 0,
          mission: { id: `process-crash-queued-${seed}`, revision: 1, hash: "process-crash-queued-hash", statement: "Persist a follow-up through a daemon crash.", keyResults: [] },
          objective: "Hold the process-crash queue fixture open.",
          harness: "codex",
          model: "fixture",
          permissions: "full-access",
          outputSchema: {},
          workspace: { path: root, dirtyPolicy: "local-only" },
        }),
      });
      expect(created.response.status).toBe(202);
      const agentId = created.body.id as string;
      await waitFor(() => expect(lines(join(root, ".process-crash-queue-starts"))).toContain(agentId));
      const followUp = await json(base, `/v1/agents/${agentId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `process-crash-queued-followup-${seed}` },
        body: JSON.stringify({ content: "Queue this follow-up durably." }),
      });
      expect(followUp.response.status, JSON.stringify(followUp.body)).toBe(202);
      const store = storeAt(dataDirectory);
      try {
        await waitFor(() => expect(store.getMetadata<Record<string, unknown>>(`agent-follow-up:${agentId}`)).toMatchObject({ state: "queued" }));
        expect(lines(join(root, ".process-crash-queue-followups"))).toHaveLength(0);
        await killDaemon(first);
        const second = await startDaemonProcess(configPath, queueEnvironment);
        await waitForHealth(base);
        await waitFor(async () => {
          const response = await fetch(`${base}/v1/agents/${agentId}`);
          expect((await response.json() as { status: string }).status).toBe("completed");
        });
        const recovered = storeAt(dataDirectory);
        try {
          expect(lines(join(root, ".process-crash-queue-starts"))).toHaveLength(1);
          expect(lines(join(root, ".process-crash-queue-resumes"))).toContain(agentId);
          expect(lines(join(root, ".process-crash-queue-followups"))).toHaveLength(1);
          const events = recovered.eventsAfter(0, { agentId, limit: 10_000 });
          expect(events.filter((event) => event.type === "driver.output.completed")).toHaveLength(1);
          expect(events.filter((event) => event.type === "driver.run.completed")).toHaveLength(1);
          expect(events.filter((event) => event.type === "agent.interrupted")).toHaveLength(0);
        } finally {
          recovered.close();
        }
        ownedPids.delete(second.pid);
        process.kill(second.pid, "SIGTERM");
        await waitForExit(second.child);
      } finally {
        store.close();
      }
    } finally {
      // Exact child PIDs are cleaned by afterEach.
    }
  }, 35_000);
});
