import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cursor } from "../packages/drivers/node_modules/@cursor/sdk/dist/esm/index.js";
import { loadConfig, SecretStore, writeDefaultConfig } from "../packages/config/src/index.js";
import { CursorDriver, cursorEffectiveModelsEqual } from "../packages/drivers/src/cursor.js";
import { AgentWorkOrderSchema, type DriverEvent, type DriverStartRequest } from "../packages/protocol/src/index.js";

const temporary: string[] = [];
const originalFixtureModule = process.env.SYMPHONY_CURSOR_HOST_SDK_MODULE;
const originalFixtureRoot = process.env.SYMPHONY_CURSOR_FIXTURE_ROOT;
const originalFixtureDelay = process.env.SYMPHONY_CURSOR_FIXTURE_DELAY_MS;
const originalFixtureEmitApiKeyStderr = process.env.SYMPHONY_CURSOR_FIXTURE_EMIT_API_KEY_STDERR;
const originalFixtureBlockFollowUpBeforeAccept = process.env.SYMPHONY_CURSOR_FIXTURE_BLOCK_FOLLOWUP_BEFORE_ACCEPT;
const originalCursorApiKey = process.env.CURSOR_API_KEY;
const children = new Set<ChildProcess>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  children.clear();
  if (originalFixtureModule === undefined) delete process.env.SYMPHONY_CURSOR_HOST_SDK_MODULE;
  else process.env.SYMPHONY_CURSOR_HOST_SDK_MODULE = originalFixtureModule;
  if (originalFixtureRoot === undefined) delete process.env.SYMPHONY_CURSOR_FIXTURE_ROOT;
  else process.env.SYMPHONY_CURSOR_FIXTURE_ROOT = originalFixtureRoot;
  if (originalFixtureDelay === undefined) delete process.env.SYMPHONY_CURSOR_FIXTURE_DELAY_MS;
  else process.env.SYMPHONY_CURSOR_FIXTURE_DELAY_MS = originalFixtureDelay;
  if (originalFixtureEmitApiKeyStderr === undefined) delete process.env.SYMPHONY_CURSOR_FIXTURE_EMIT_API_KEY_STDERR;
  else process.env.SYMPHONY_CURSOR_FIXTURE_EMIT_API_KEY_STDERR = originalFixtureEmitApiKeyStderr;
  if (originalFixtureBlockFollowUpBeforeAccept === undefined) delete process.env.SYMPHONY_CURSOR_FIXTURE_BLOCK_FOLLOWUP_BEFORE_ACCEPT;
  else process.env.SYMPHONY_CURSOR_FIXTURE_BLOCK_FOLLOWUP_BEFORE_ACCEPT = originalFixtureBlockFollowUpBeforeAccept;
  if (originalCursorApiKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = originalCursorApiKey;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function lines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split(/\r?\n/u).filter(Boolean);
}

function request(root: string, agentId: string): DriverStartRequest {
  return {
    agentId,
    resolvedModel: "fixture-model",
    workOrder: AgentWorkOrderSchema.parse({
      id: `order-${agentId}`,
      workflowId: `workflow-${agentId}`,
      runId: `run-${agentId}`,
      parentAgentId: null,
      depth: 0,
      mission: { id: `workflow-${agentId}`, revision: 1, hash: "12345678", statement: "Verify durable Cursor turn fencing.", keyResults: [] },
      objective: "Complete the fixture turn.",
      harness: "cursor",
      model: "fixture-model",
      permissions: "full-access",
      outputSchema: {},
      workspace: { path: root, dirtyPolicy: "local-only" },
      inputs: [],
      metadata: {},
    }),
    coordination: {
      daemonUrl: "http://127.0.0.1:1",
      token: "fixture-cursor-agent-token-that-must-not-leak",
      mcpCommand: process.execPath,
      mcpArgs: ["-e", "process.exit(0)"],
      canCreate: false,
      maxDepth: null,
    },
  };
}

describe("Cursor SDK host turn boundary", () => {
  it("compares the complete effective model tuple, including auto mode and parameters", () => {
    expect(cursorEffectiveModelsEqual(
      { mode: "auto", id: null, params: [] },
      { mode: "auto", id: null, params: [] },
    )).toBe(true);
    expect(cursorEffectiveModelsEqual(
      { mode: "auto", id: null, params: [] },
      { mode: "explicit", id: null, params: [] },
    )).toBe(false);
    expect(cursorEffectiveModelsEqual(
      { mode: "resolved-auto", id: "fixture-model", params: [{ id: "reasoning", value: "high" }] },
      { mode: "resolved-auto", id: "fixture-model", params: [{ id: "reasoning", value: "low" }] },
    )).toBe(false);
  });

  it("does not expose the CLI model catalog when the Cursor SDK is unauthenticated", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cursor-model-environment-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.harnesses.cursor.process = {
      command: process.execPath,
      args: [resolve("tests/fixtures/cursor-durable-cli.mjs")],
    };
    const driver = new CursorDriver(
      loaded.config.harnesses.cursor,
      new SecretStore("dev.symphony.cursor-model-environment-test", {
        platform: "linux",
        environment: {},
        nativeBackend: null,
      }),
    );
    process.env.SYMPHONY_CURSOR_FIXTURE_ROOT = root;
    process.env.CURSOR_API_KEY = "ambient-cursor-key-that-must-not-reach-local-discovery";
    vi.spyOn(Cursor.auth, "status").mockResolvedValue({ status: "logged-out" });
    const models = vi.spyOn(Cursor.models, "list");

    await expect(driver.doctor()).resolves.toMatchObject({
      available: true,
      authenticated: false,
      detail: expect.stringContaining("CLI is signed in"),
    });
    await expect(driver.listModels()).resolves.toEqual([]);
    expect(models).not.toHaveBeenCalled();
    expect(lines(join(root, ".fixture-cursor-model-environment"))).toEqual([]);
    await driver.dispose();
  });

  it("uses a verified Cursor SDK login as runtime and catalog authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cursor-sdk-login-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.harnesses.cursor.process = {
      command: process.execPath,
      args: [resolve("tests/fixtures/cursor-durable-cli.mjs")],
    };
    const driver = new CursorDriver(
      loaded.config.harnesses.cursor,
      new SecretStore("dev.symphony.cursor-sdk-login-test", { platform: "linux", environment: {}, nativeBackend: null }),
    );
    vi.spyOn(Cursor.auth, "status").mockResolvedValue({
      status: "logged-in",
      backendUrl: "https://api.cursor.com",
      email: "sdk@example.invalid",
    });
    vi.spyOn(Cursor.models, "list").mockResolvedValue([{
      id: "sdk-model",
      displayName: "SDK model",
      description: "Runtime-verified Cursor SDK model",
      aliases: [],
      parameters: [],
      variants: [],
    }]);

    await expect(driver.doctor()).resolves.toMatchObject({ authenticated: true, detail: expect.stringContaining("sdk@example.invalid") });
    await expect(driver.listModels()).resolves.toMatchObject([{ id: "sdk-model", harness: "cursor" }]);
    await driver.dispose();
  });

  it("uses Cursor's documented SDK login without returning the minted key", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cursor-sdk-auth-action-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const driver = new CursorDriver(
      loaded.config.harnesses.cursor,
      new SecretStore("dev.symphony.cursor-sdk-auth-action-test", { platform: "linux", environment: {}, nativeBackend: null }),
    );
    vi.spyOn(Cursor.auth, "status").mockResolvedValue({ status: "logged-out" });
    const login = vi.spyOn(Cursor.auth, "login").mockImplementation(async (options) => {
      options?.onLoginUrl?.("https://cursor.com/login/sdk-fixture");
      return {
        apiKey: "minted-key-that-must-not-be-projected",
        email: "sdk@example.invalid",
        apiKeyExpiresAtMs: Date.now() + 60_000,
      };
    });

    const result = await driver.authenticate();
    expect(result).toEqual({
      authenticated: true,
      detail: "Cursor SDK authenticated as sdk@example.invalid.",
      loginUrl: "https://cursor.com/login/sdk-fixture",
    });
    expect(JSON.stringify(result)).not.toContain("minted-key-that-must-not-be-projected");
    expect(login).toHaveBeenCalledWith(expect.objectContaining({ apiKeyName: "Symphony local orchestration" }));
    await driver.dispose();
  });

  it("rejects missing SDK credentials before launching native work", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cursor-missing-sdk-auth-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const driver = new CursorDriver(
      loaded.config.harnesses.cursor,
      new SecretStore("dev.symphony.cursor-missing-sdk-auth-test", { platform: "linux", environment: {}, nativeBackend: null }),
    );
    vi.spyOn(Cursor.auth, "status").mockResolvedValue({ status: "logged-out" });

    await expect(driver.start(request(root, "cursor-missing-sdk-auth"), () => undefined, { signal: new AbortController().signal }))
      .rejects.toThrow("Cursor SDK authentication is required");
    expect(lines(join(root, ".fixture-cursor-agents"))).toEqual([]);
    await driver.dispose();
  });

  it("redacts a controlled cloud API key from split SDK stderr before the host boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cursor-host-stderr-secret-"));
    temporary.push(root);
    const cloudApiKey = "controlled-cloud-cursor-key-that-must-not-reach-the-spool";
    const child = spawn(resolve("node_modules/.bin/tsx"), [resolve("packages/drivers/src/cursor-host.ts")], {
      cwd: resolve("."),
      env: {
        ...process.env,
        SYMPHONY_CURSOR_HOST_SDK_MODULE: resolve("tests/fixtures/cursor-sdk-fixture.mjs"),
        SYMPHONY_CURSOR_FIXTURE_ROOT: root,
        SYMPHONY_CURSOR_FIXTURE_EMIT_API_KEY_STDERR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "cloud-secret-start",
      method: "session/start",
      params: {
        requestId: "cursor:initial-run:cloud-secret-agent",
        prompt: "Verify the stderr boundary.",
        options: {
          apiKey: cloudApiKey,
          cloud: { repos: [] },
          model: { id: "fixture-model" },
        },
        effectiveModel: { mode: "explicit", id: "fixture-model", params: [] },
      },
    })}\n`);

    await expect.poll(() => stdout.includes('"id":"cloud-secret-start"'), { timeout: 2_000, interval: 20 }).toBe(true);
    await expect.poll(() => stderr.includes("[REDACTED]"), { timeout: 2_000, interval: 20 }).toBe(true);
    expect(`${stdout}\n${stderr}`).not.toContain(cloudApiKey);
    expect(stderr).toContain("fixture Cursor SDK credential=x[REDACTED]x");
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    children.delete(child);
  }, 10_000);

  it("deduplicates a replayed initial request while provider acceptance is still in flight", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cursor-host-replay-"));
    temporary.push(root);
    const child = spawn(resolve("node_modules/.bin/tsx"), [resolve("packages/drivers/src/cursor-host.ts")], {
      cwd: resolve("."),
      env: {
        ...process.env,
        SYMPHONY_CURSOR_HOST_SDK_MODULE: resolve("tests/fixtures/cursor-sdk-fixture.mjs"),
        SYMPHONY_CURSOR_FIXTURE_ROOT: root,
        SYMPHONY_CURSOR_FIXTURE_BLOCK_INITIAL: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const params = {
      requestId: "cursor:initial-run:replay-agent",
      prompt: "Run exactly once.",
      options: { agentId: "symphony-replay-agent", model: { id: "fixture-model" }, local: { cwd: root } },
      effectiveModel: { mode: "explicit", id: "fixture-model", params: [] },
    };
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: "first", method: "session/start", params })}\n`);
    await expect.poll(() => lines(join(root, ".fixture-cursor-send-entered")).length, { timeout: 2_000, interval: 20 }).toBe(1);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: "replay", method: "session/start", params })}\n`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    expect(lines(join(root, ".fixture-cursor-send-entered"))).toHaveLength(1);
    writeFileSync(join(root, ".fixture-cursor-release-initial"), "release\n");
    await expect.poll(() => stdout.split(/\r?\n/u).filter((line) => line.includes('"result"') && (line.includes('"first"') || line.includes('"replay"'))).length, { timeout: 2_000, interval: 20 }).toBe(2);
    expect(lines(join(root, ".fixture-cursor-dispatches"))).toHaveLength(1);
    expect(stderr).toBe("");
    child.kill("SIGTERM");
    children.delete(child);
  }, 10_000);

  it("fences a running turn and passes a controlled local SDK key only through options", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cursor-host-boundary-"));
    temporary.push(root);
    writeDefaultConfig(root);
    process.env.SYMPHONY_CURSOR_HOST_SDK_MODULE = resolve("tests/fixtures/cursor-sdk-fixture.mjs");
    process.env.SYMPHONY_CURSOR_FIXTURE_ROOT = root;
    process.env.SYMPHONY_CURSOR_FIXTURE_DELAY_MS = "220";
    process.env.CURSOR_API_KEY = "stale-cursor-api-key-must-not-win";

    const loaded = loadConfig({ rootDirectory: root });
    const secrets = new SecretStore("dev.symphony.cursor-host-test", {
      platform: "linux",
      environment: { CURSOR_API_KEY: "stale-cursor-api-key-must-not-win" },
      nativeBackend: null,
    });
    const driver = new CursorDriver(loaded.config.harnesses.cursor, secrets);
    const events: DriverEvent[] = [];
    const controller = new AbortController();
    const initial = await driver.start(request(root, "cursor-boundary-agent"), (event) => events.push(event), { signal: controller.signal });
    expect(initial.nativeSessionId).toBe("symphony-cursor-boundary-agent");
    expect(initial.nativeRunId).toBe("fixture-cursor-run-1");

    const followUp = driver.sendMessage(initial, "This must start only after run one is acknowledged.");
    await expect.poll(() => lines(join(root, ".fixture-cursor-dispatches")).length, { timeout: 2_000, interval: 20 }).toBe(2);
    const delivery = await followUp;
    expect(delivery).toMatchObject({ queued: true, session: { nativeRunId: "fixture-cursor-run-2", state: "running" } });
    expect(events.filter((event) => event.kind === "run.completed")).toHaveLength(0);

    await expect.poll(() => events.filter((event) => event.kind === "run.completed").length, { timeout: 2_000, interval: 20 }).toBe(1);
    const dispatches = lines(join(root, ".fixture-cursor-dispatches")).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(dispatches.map((dispatch) => dispatch.runId)).toEqual(["fixture-cursor-run-1", "fixture-cursor-run-2"]);
    expect(dispatches.map((dispatch) => dispatch.model)).toEqual([{ id: "fixture-model" }, { id: "fixture-model" }]);
    expect(dispatches[0]?.idempotencyKey).toBe("cursor:initial-run:cursor-boundary-agent");
    expect(dispatches[1]?.idempotencyKey).toMatch(/^cursor:prompt:cursor-boundary-agent:/u);

    const agents = lines(join(root, ".fixture-cursor-agents")).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ optionsApiKey: "stale-cursor-api-key-must-not-win", environmentApiKey: null, model: { id: "fixture-model" } });

    if (!delivery.session) throw new Error("Cursor follow-up did not return its session checkpoint.");
    await driver.forceTerminate(delivery.session);
    await driver.dispose();
  }, 10_000);

  it("reports cancellation only after the native run confirms it", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cursor-host-cancel-"));
    temporary.push(root);
    writeDefaultConfig(root);
    process.env.SYMPHONY_CURSOR_HOST_SDK_MODULE = resolve("tests/fixtures/cursor-sdk-fixture.mjs");
    process.env.SYMPHONY_CURSOR_FIXTURE_ROOT = root;
    process.env.SYMPHONY_CURSOR_FIXTURE_DELAY_MS = "2_000".replace("_", "");

    const loaded = loadConfig({ rootDirectory: root });
    const driver = new CursorDriver(
      loaded.config.harnesses.cursor,
      new SecretStore("dev.symphony.cursor-host-cancel-test", {
        platform: "linux",
        environment: { CURSOR_API_KEY: "cursor-cancel-fixture-key" },
        nativeBackend: null,
      }),
    );
    const events: DriverEvent[] = [];
    const controller = new AbortController();
    const session = await driver.start(request(root, "cursor-cancel-agent"), (event) => events.push(event), { signal: controller.signal });
    await driver.cancel(session);
    await expect.poll(() => events.some((event) => event.kind === "run.cancelled"), { timeout: 2_000, interval: 20 }).toBe(true);
    expect(events.some((event) => event.kind === "run.completed")).toBe(false);
    await driver.forceTerminate(session);
    await driver.dispose();
  }, 10_000);

  it("cancels queued work at the terminal ACK boundary without dispatching it", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cursor-host-queued-cancel-"));
    temporary.push(root);
    const child = spawn(resolve("node_modules/.bin/tsx"), [resolve("packages/drivers/src/cursor-host.ts")], {
      cwd: resolve("."),
      env: {
        ...process.env,
        SYMPHONY_CURSOR_HOST_SDK_MODULE: resolve("tests/fixtures/cursor-sdk-fixture.mjs"),
        SYMPHONY_CURSOR_FIXTURE_ROOT: root,
        SYMPHONY_CURSOR_FIXTURE_DELAY_MS: "180",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const effectiveModel = { mode: "explicit", id: "fixture-model", params: [] };
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "queued-cancel-start",
      method: "session/start",
      params: {
        requestId: "cursor:initial-run:queued-cancel-agent",
        prompt: "Finish before the queued cancellation boundary.",
        options: { agentId: "symphony-queued-cancel-agent", model: { id: "fixture-model" }, local: { cwd: root } },
        effectiveModel,
      },
    })}\n`);
    await expect.poll(() => stdout.includes('"id":"queued-cancel-start"'), { timeout: 2_000, interval: 20 }).toBe(true);
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "queued-cancel-prompt",
      method: "session/prompt",
      params: { requestId: "cursor:prompt:queued-cancel-agent:1", prompt: "This must never dispatch.", effectiveModel },
    })}\n`);
    await expect.poll(
      () => stdout.includes('"method":"cursor/result"') && stdout.includes('"queuedPrompts":1'),
      { timeout: 2_000, interval: 20 },
    ).toBe(true);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: "queued-cancel", method: "session/cancel", params: {} })}\n`);
    await expect.poll(
      () => stdout.includes('"method":"cursor/cancelled"') && stdout.includes('"id":"queued-cancel","result"'),
      { timeout: 2_000, interval: 20 },
    ).toBe(true);
    const cancelResponse = stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.id === "queued-cancel") as { result?: Record<string, unknown> } | undefined;
    expect(cancelResponse?.result).toMatchObject({ cancelled: true, terminalBoundary: true, queuedCancelled: 1 });
    expect(lines(join(root, ".fixture-cursor-dispatches"))).toHaveLength(1);
    expect(stderr).toBe("");
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    children.delete(child);
  }, 10_000);

  it("cancels the accepted run when result ACK is awaiting queued provider acceptance", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cursor-host-ack-dispatch-cancel-"));
    temporary.push(root);
    const child = spawn(resolve("node_modules/.bin/tsx"), [resolve("packages/drivers/src/cursor-host.ts")], {
      cwd: resolve("."),
      env: {
        ...process.env,
        SYMPHONY_CURSOR_HOST_SDK_MODULE: resolve("tests/fixtures/cursor-sdk-fixture.mjs"),
        SYMPHONY_CURSOR_FIXTURE_ROOT: root,
        SYMPHONY_CURSOR_FIXTURE_DELAY_MS: "300",
        SYMPHONY_CURSOR_FIXTURE_BLOCK_FOLLOWUP_BEFORE_ACCEPT: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const effectiveModel = { mode: "explicit", id: "fixture-model", params: [] };
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "ack-dispatch-cancel-start",
      method: "session/start",
      params: {
        requestId: "cursor:initial-run:ack-dispatch-cancel-agent",
        prompt: "Finish before the queued provider acceptance boundary.",
        options: { agentId: "symphony-ack-dispatch-cancel-agent", model: { id: "fixture-model" }, local: { cwd: root } },
        effectiveModel,
      },
    })}\n`);
    await expect.poll(() => stdout.includes('"id":"ack-dispatch-cancel-start"'), { timeout: 2_000, interval: 20 }).toBe(true);
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "ack-dispatch-cancel-prompt",
      method: "session/prompt",
      params: { requestId: "cursor:prompt:ack-dispatch-cancel-agent:1", prompt: "Cancel this transition.", effectiveModel },
    })}\n`);
    await expect.poll(
      () => stdout.includes('"method":"cursor/result"') && stdout.includes('"queuedPrompts":1'),
      { timeout: 2_000, interval: 20 },
    ).toBe(true);
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "ack-dispatch-cancel-ack",
      method: "session/result-ack",
      params: { runId: "fixture-cursor-run-1", generation: 1 },
    })}\n`);
    await expect.poll(() => existsSync(join(root, ".fixture-cursor-followup-entered")), { timeout: 2_000, interval: 20 }).toBe(true);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: "ack-dispatch-cancel", method: "session/cancel", params: {} })}\n`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    expect(stdout).not.toContain('"id":"ack-dispatch-cancel","result"');

    writeFileSync(join(root, ".fixture-cursor-release-followup-before-accept"), "release\n");
    await expect.poll(
      () => stdout.includes('"id":"ack-dispatch-cancel","result"') && stdout.includes('"status":"cancelled"'),
      { timeout: 2_000, interval: 20 },
    ).toBe(true);
    const frames = stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const cancelResponse = frames.find((line) => line.id === "ack-dispatch-cancel") as { result?: Record<string, unknown> } | undefined;
    expect(cancelResponse?.result).toMatchObject({
      runId: "fixture-cursor-run-2",
      generation: 2,
      cancelled: true,
      status: "cancelled",
      phase: "queued-dispatch-in-flight",
    });
    expect(frames.some((line) => line.method === "cursor/result"
      && (line.params as Record<string, unknown> | undefined)?.runId === "fixture-cursor-run-2"
      && ((line.params as Record<string, unknown>).result as Record<string, unknown> | undefined)?.status === "cancelled")).toBe(true);
    expect(lines(join(root, ".fixture-cursor-dispatches"))).toHaveLength(2);
    expect(stderr).toBe("");
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    children.delete(child);
  }, 10_000);

  it("keeps driver cancellation pending across result ACK and provider acceptance", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cursor-driver-ack-dispatch-cancel-"));
    temporary.push(root);
    writeDefaultConfig(root);
    process.env.SYMPHONY_CURSOR_HOST_SDK_MODULE = resolve("tests/fixtures/cursor-sdk-fixture.mjs");
    process.env.SYMPHONY_CURSOR_FIXTURE_ROOT = root;
    process.env.SYMPHONY_CURSOR_FIXTURE_DELAY_MS = "300";
    process.env.SYMPHONY_CURSOR_FIXTURE_BLOCK_FOLLOWUP_BEFORE_ACCEPT = "1";

    const loaded = loadConfig({ rootDirectory: root });
    const driver = new CursorDriver(
      loaded.config.harnesses.cursor,
      new SecretStore("dev.symphony.cursor-driver-ack-dispatch-cancel-test", {
        platform: "linux",
        environment: { CURSOR_API_KEY: "cursor-ack-dispatch-cancel-fixture-key" },
        nativeBackend: null,
      }),
    );
    const events: DriverEvent[] = [];
    const session = await driver.start(
      request(root, "cursor-driver-ack-dispatch-cancel-agent"),
      (event) => events.push(event),
      { signal: new AbortController().signal },
    );
    const delivery = driver.sendMessage(session, "Cancel this provider transition.");
    await expect.poll(() => existsSync(join(root, ".fixture-cursor-followup-entered")), { timeout: 2_000, interval: 20 }).toBe(true);
    let cancellationSettled = false;
    const cancellation = driver.cancel(session).finally(() => { cancellationSettled = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    expect(cancellationSettled).toBe(false);

    writeFileSync(join(root, ".fixture-cursor-release-followup-before-accept"), "release\n");
    await cancellation;
    const accepted = await delivery;
    await expect.poll(() => events.filter((event) => event.kind === "run.cancelled").length, { timeout: 2_000, interval: 20 }).toBe(1);
    expect(accepted.session?.nativeRunId).toBe("fixture-cursor-run-2");
    expect(events.filter((event) => event.kind === "run.completed")).toHaveLength(0);
    expect(lines(join(root, ".fixture-cursor-dispatches"))).toHaveLength(2);
    await driver.forceTerminate(accepted.session ?? session);
    await driver.dispose();
  }, 10_000);

  it("passes a cloud account key only through controlled options, never the host environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cursor-host-cloud-secret-"));
    temporary.push(root);
    writeDefaultConfig(root);
    process.env.SYMPHONY_CURSOR_HOST_SDK_MODULE = resolve("tests/fixtures/cursor-sdk-fixture.mjs");
    process.env.SYMPHONY_CURSOR_FIXTURE_ROOT = root;
    process.env.SYMPHONY_CURSOR_FIXTURE_DELAY_MS = "500";
    process.env.CURSOR_API_KEY = "controlled-cloud-cursor-key";

    const loaded = loadConfig({ rootDirectory: root });
    const secrets = new SecretStore("dev.symphony.cursor-host-cloud-secret-test", {
      platform: "linux",
      environment: { CURSOR_API_KEY: "controlled-cloud-cursor-key" },
      nativeBackend: null,
    });
    const driver = new CursorDriver(loaded.config.harnesses.cursor, secrets);
    const cloudRequest = request(root, "cursor-cloud-secret-agent");
    cloudRequest.workOrder.workspace.remoteRepository = "https://example.invalid/symphony-fixture.git";
    const session = await driver.start(cloudRequest, () => undefined, { signal: new AbortController().signal });

    const agents = lines(join(root, ".fixture-cursor-agents")).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ optionsApiKey: "controlled-cloud-cursor-key", environmentApiKey: null });

    await driver.forceTerminate(session);
    await driver.dispose();
  }, 10_000);
});
