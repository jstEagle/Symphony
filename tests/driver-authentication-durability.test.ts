import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { capabilities } from "../packages/drivers/src/common.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { nowIso } from "../packages/protocol/src/index.js";
import { TEST_DAEMON_SECRET } from "./setup.js";
import type {
  DriverAuthenticationResult,
  DriverDoctorResult,
  ModelDescriptor,
  ResolvedHarness,
  WorkerDriver,
} from "../packages/protocol/src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

class AuthenticationDriver implements WorkerDriver {
  readonly capabilities = capabilities();
  authenticationCalls = 0;

  constructor(
    readonly id: Extract<ResolvedHarness, "codex" | "cursor">,
    private readonly statePath: string,
    private readonly countPath: string,
    private readonly startedPath: string,
    private readonly options: { delay?: number; doctorDelay?: number; throwAfterMint?: boolean } = {},
  ) {}

  async doctor(): Promise<DriverDoctorResult> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, this.options.doctorDelay ?? 0));
    return {
      driver: this.id,
      available: true,
      authenticated: existsSync(this.statePath),
      version: "1.0.0",
      capabilities: this.capabilities,
      detail: existsSync(this.statePath) ? "Fixture authentication is verified." : "Fixture authentication is required.",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }

  async authenticate(): Promise<DriverAuthenticationResult> {
    this.authenticationCalls += 1;
    writeFileSync(this.countPath, String(readCount(this.countPath) + 1));
    writeFileSync(this.startedPath, nowIso());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, this.options.delay ?? 0));
    writeFileSync(this.statePath, "authenticated");
    if (this.options.throwAfterMint) throw new Error("provider response was lost after mint");
    return { authenticated: true, detail: "Fixture driver authenticated." };
  }

  async start(): Promise<never> {
    throw new Error("The authentication fixture does not start agents.");
  }
}

describe("durable driver authentication", () => {
  it("executes once across response loss and restart while fencing permissions, keys, and concurrency", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-driver-authentication-"));
    temporary.push(root);
    const statePath = join(root, "authenticated.txt");
    const countPath = join(root, "authentication-count.txt");
    const startedPath = join(root, "authentication-started.txt");
    const firstPort = await availablePort();
    writeConfig(root, firstPort);
    const registry = authenticationRegistry(statePath, countPath, startedPath, { delay: 700 });
    const firstDaemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: registry });
    const firstBase = `http://127.0.0.1:${firstPort}`;
    const key = "driver-authenticate:codex:durable-1";
    try {
      const missingKey = await fetch(`${firstBase}/v1/drivers/codex/authenticate`, { method: "POST" });
      expect(missingKey.status).toBe(400);

      const timestamp = nowIso();
      firstDaemon.store.saveAgent({
        id: "read-only-authenticator",
        logicalAgentId: "read-only-authenticator",
        workflowId: "chat:driver-authentication-test",
        runId: "chat-run:driver-authentication-test",
        parentAgentId: null,
        depth: 0,
        objective: "Attempt forbidden harness authentication.",
        missionHash: "driver-authentication-test",
        requestedHarness: "codex",
        requestedModel: "fixture",
        harness: "codex",
        model: "fixture",
        permissions: "read-only",
        status: "waiting",
        nativeSessionId: null,
        nativeRunId: null,
        workspacePath: root,
        output: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: null,
        finishedAt: null,
      });
      const forbidden = await fetch(`${firstBase}/v1/drivers/codex/authenticate`, {
        method: "POST",
        headers: {
          "idempotency-key": "driver-authenticate:forbidden",
          "x-symphony-agent-id": "read-only-authenticator",
          "x-symphony-agent-token": firstDaemon.agents.tokenFor("read-only-authenticator"),
        },
      });
      expect(forbidden.status).toBe(403);

      const controller = new AbortController();
      const lostResponse = fetch(`${firstBase}/v1/drivers/codex/authenticate`, {
        method: "POST",
        headers: { "idempotency-key": key },
        signal: controller.signal,
      }).catch((error: unknown) => error);
      await expect.poll(() => readCount(countPath)).toBe(1);

      const concurrentSameKey = await fetch(`${firstBase}/v1/drivers/codex/authenticate`, {
        method: "POST",
        headers: { "idempotency-key": key },
      });
      expect(concurrentSameKey.status).toBe(425);
      const concurrentOtherKey = await fetch(`${firstBase}/v1/drivers/codex/authenticate`, {
        method: "POST",
        headers: { "idempotency-key": "driver-authenticate:codex:durable-2" },
      });
      expect(concurrentOtherKey.status).toBe(409);
      expect(readCount(countPath)).toBe(1);

      controller.abort();
      await lostResponse;
      await expect.poll(() => firstDaemon.store.getCommandReceipt(key)?.state).toBe("settled");
      expect(readCount(countPath)).toBe(1);
      expect(firstDaemon.store.eventsAfter(0, { types: ["driver.authenticated"] })).toHaveLength(1);
    } finally {
      await firstDaemon.close();
    }

    const secondPort = await availablePort();
    writeConfig(root, secondPort);
    process.env.SYMPHONY_DAEMON_SECRET = TEST_DAEMON_SECRET;
    const secondDaemon = await startDaemon({
      rootDirectory: root,
      noPlugins: true,
      driverRegistry: authenticationRegistry(statePath, countPath, startedPath),
    });
    const secondBase = `http://127.0.0.1:${secondPort}`;
    try {
      const retry = await fetch(`${secondBase}/v1/drivers/codex/authenticate`, {
        method: "POST",
        headers: { "idempotency-key": key },
      });
      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toEqual({ authenticated: true, detail: "Fixture driver authenticated." });
      expect(readCount(countPath)).toBe(1);

      const collision = await fetch(`${secondBase}/v1/drivers/cursor/authenticate`, {
        method: "POST",
        headers: { "idempotency-key": key },
      });
      expect(collision.status).toBe(409);
      expect(readCount(countPath)).toBe(1);
      expect(secondDaemon.store.eventsAfter(0, { types: ["driver.authenticated"] })).toHaveLength(1);
    } finally {
      await secondDaemon.close();
    }
  });

  it("reconciles dispatching only from authenticated evidence without relaunching", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-driver-authentication-recovery-"));
    temporary.push(root);
    const statePath = join(root, "authenticated.txt");
    const countPath = join(root, "authentication-count.txt");
    const startedPath = join(root, "authentication-started.txt");
    const port = await availablePort();
    writeConfig(root, port);
    const key = "driver-authenticate:codex:ambiguous";
    const daemon = await startDaemon({
      rootDirectory: root,
      noPlugins: true,
      driverRegistry: authenticationRegistry(statePath, countPath, startedPath),
    });
    try {
      seedAuthenticationOperation(daemon, key, "dispatching");
      const base = `http://127.0.0.1:${port}`;
      const unknown = await fetch(`${base}/v1/drivers/codex/authenticate`, {
        method: "POST",
        headers: { "idempotency-key": key },
      });
      expect(unknown.status).toBe(425);
      expect(readCount(countPath)).toBe(0);

      writeFileSync(statePath, "authenticated outside Symphony");
      const recovered = await fetch(`${base}/v1/drivers/codex/authenticate`, {
        method: "POST",
        headers: { "idempotency-key": key },
      });
      expect(recovered.status).toBe(200);
      await expect(recovered.json()).resolves.toMatchObject({ authenticated: true });
      expect(readCount(countPath)).toBe(0);
      expect(daemon.store.getCommandReceipt(key)?.state).toBe("settled");
      expect(daemon.store.eventsAfter(0, { types: ["driver.authenticated"] })).toHaveLength(1);

      const retry = await fetch(`${base}/v1/drivers/codex/authenticate`, {
        method: "POST",
        headers: { "idempotency-key": key },
      });
      expect(retry.status).toBe(200);
      expect(readCount(countPath)).toBe(0);
      expect(daemon.store.eventsAfter(0, { types: ["driver.authenticated"] })).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  });

  it("resumes one preparing owner after restart and fences a concurrent same-key retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-driver-authentication-preparing-"));
    temporary.push(root);
    const statePath = join(root, "authenticated.txt");
    const countPath = join(root, "authentication-count.txt");
    const startedPath = join(root, "authentication-started.txt");
    const key = "driver-authenticate:codex:preparing-restart";

    const firstPort = await availablePort();
    writeConfig(root, firstPort);
    const firstDaemon = await startDaemon({
      rootDirectory: root,
      noPlugins: true,
      driverRegistry: authenticationRegistry(statePath, countPath, startedPath),
    });
    seedAuthenticationOperation(firstDaemon, key, "preparing");
    await firstDaemon.close();

    const secondPort = await availablePort();
    writeConfig(root, secondPort);
    process.env.SYMPHONY_DAEMON_SECRET = TEST_DAEMON_SECRET;
    const secondDaemon = await startDaemon({
      rootDirectory: root,
      noPlugins: true,
      driverRegistry: authenticationRegistry(statePath, countPath, startedPath, {
        doctorDelay: 150,
        delay: 300,
      }),
    });
    try {
      const url = `http://127.0.0.1:${secondPort}/v1/drivers/codex/authenticate`;
      const [left, right] = await Promise.all([
        fetch(url, { method: "POST", headers: { "idempotency-key": key } }),
        fetch(url, { method: "POST", headers: { "idempotency-key": key } }),
      ]);
      expect([left.status, right.status].sort()).toEqual([200, 425]);
      expect(readCount(countPath)).toBe(1);
      expect(secondDaemon.store.getCommandReceipt(key)?.state).toBe("settled");
      expect(secondDaemon.store.eventsAfter(0, { types: ["driver.authenticated"] })).toHaveLength(1);
    } finally {
      await secondDaemon.close();
    }
  });

  it("keeps a mint-then-throw outcome fail-closed for same and different keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-driver-authentication-mint-error-"));
    temporary.push(root);
    const statePath = join(root, "authenticated.txt");
    const countPath = join(root, "authentication-count.txt");
    const startedPath = join(root, "authentication-started.txt");
    const port = await availablePort();
    writeConfig(root, port);
    const key = "driver-authenticate:codex:mint-error";
    const daemon = await startDaemon({
      rootDirectory: root,
      noPlugins: true,
      driverRegistry: authenticationRegistry(statePath, countPath, startedPath, { throwAfterMint: true }),
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      const first = await fetch(`${base}/v1/drivers/codex/authenticate`, {
        method: "POST",
        headers: { "idempotency-key": key },
      });
      expect(first.status).toBe(425);
      expect(readCount(countPath)).toBe(1);
      expect(daemon.store.getCommandReceipt(key)?.state).toBe("dispatching");
      expect(daemon.store.getMetadata("driver-authentication-operation:codex"))
        .toMatchObject({ state: "dispatching", error: "provider response was lost after mint" });

      const fencedOtherKey = await fetch(`${base}/v1/drivers/codex/authenticate`, {
        method: "POST",
        headers: { "idempotency-key": "driver-authenticate:codex:mint-error-fenced" },
      });
      expect(fencedOtherKey.status).toBe(409);
      expect(readCount(countPath)).toBe(1);

      const retry = await fetch(`${base}/v1/drivers/codex/authenticate`, {
        method: "POST",
        headers: { "idempotency-key": key },
      });
      expect(retry.status).toBe(200);
      expect(readCount(countPath)).toBe(1);

      const otherKey = await fetch(`${base}/v1/drivers/codex/authenticate`, {
        method: "POST",
        headers: { "idempotency-key": "driver-authenticate:codex:mint-error-2" },
      });
      expect(otherKey.status).toBe(200);
      expect(readCount(countPath)).toBe(1);
      expect(daemon.store.eventsAfter(0, { types: ["driver.authentication.failed"] })).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  });
});

function authenticationRegistry(
  statePath: string,
  countPath: string,
  startedPath: string,
  options: { delay?: number; doctorDelay?: number; throwAfterMint?: boolean } = {},
): DriverRegistry {
  const registry = new DriverRegistry();
  registry.register(new AuthenticationDriver("codex", statePath, countPath, startedPath, options));
  registry.register(new AuthenticationDriver("cursor", statePath, countPath, startedPath, options));
  return registry;
}

function seedAuthenticationOperation(
  daemon: Awaited<ReturnType<typeof startDaemon>>,
  key: string,
  state: "preparing" | "dispatching",
): void {
  const createdAt = nowIso();
  const fingerprintKey = `command-fingerprint:${createHash("sha256").update(key).digest("hex")}`;
  const fingerprint = createHash("sha256").update(
    '{"actor":{"id":null,"type":"user"},"payload":{"driver":"codex"},"type":"driver.authenticate"}',
  ).digest("hex");
  daemon.store.durableTransaction(() => {
    daemon.store.setMetadata(fingerprintKey, fingerprint);
    expect(daemon.store.claimCommandReceipt({
      idempotencyKey: key,
      accepted: false,
      state: "dispatching",
      result: { commandType: "driver.authenticate", status: "outcome-unknown" },
      createdAt,
      updatedAt: createdAt,
    })).toBe(true);
    daemon.store.setMetadata("driver-authentication-operation:codex", {
      version: 1,
      driver: "codex",
      idempotencyKey: key,
      state,
      baselineAuthenticated: state === "dispatching" ? false : null,
      result: null,
      error: null,
      createdAt,
      updatedAt: createdAt,
    });
  });
}

function writeConfig(root: string, port: number): void {
  writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
    dataDirectory: ".symphony",
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
    conductor: { harness: "codex", model: "fixture" },
    agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access" },
    harnesses: {
      codex: { enabled: true }, claude: { enabled: false }, cursor: { enabled: true },
      opencode: { enabled: false }, pi: { enabled: false }, acp: [],
    },
    harnessUpdates: {
      checkIntervalMinutes: 10,
      harnesses: {
        codex: { command: process.execPath, args: ["--version"], latest: { source: "none" } },
        claude: { command: "claude", args: ["update"], latest: { source: "none" } },
        cursor: { command: process.execPath, args: ["--version"], latest: { source: "none" } },
        opencode: { command: "opencode", args: ["upgrade"], latest: { source: "none" } },
        pi: { command: "pi", args: ["--version"], latest: { source: "none" } },
      },
    },
    router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
    observer: { provider: "deterministic" },
    plugins: { watch: false },
  }));
}

function readCount(path: string): number {
  try {
    return Number(readFileSync(path, "utf8")) || 0;
  } catch {
    return 0;
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}
