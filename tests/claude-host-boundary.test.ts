import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, writeDefaultConfig } from "../packages/config/src/index.js";
import { ClaudeDriver } from "../packages/drivers/src/claude.js";
import { AgentWorkOrderSchema, type DriverEvent, type DriverSession, type DriverStartRequest } from "../packages/protocol/src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function lines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split(/\r?\n/u).filter(Boolean);
}

describe("Claude SDK host result boundary", () => {
  it("fences a prompt issued synchronously from terminal projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-claude-result-boundary-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const fixtureCli = resolve("tests/fixtures/claude-durable-cli.mjs");
    loaded.config.harnesses.claude.enabled = true;
    loaded.config.harnesses.claude.process = {
      command: process.execPath,
      args: [fixtureCli, "--fixture-root", root],
    };
    const driver = new ClaudeDriver(loaded.config.harnesses.claude);
    const workOrder = AgentWorkOrderSchema.parse({
      id: "claude-boundary-order",
      workflowId: "claude-boundary-workflow",
      runId: "claude-boundary-run",
      parentAgentId: null,
      depth: 0,
      mission: { id: "claude-boundary-workflow", revision: 1, hash: "12345678", statement: "Verify the result fence.", keyResults: [] },
      objective: "Complete one fixture turn.",
      harness: "claude",
      model: "auto",
      permissions: "full-access",
      outputSchema: {},
      workspace: { path: root, dirtyPolicy: "local-only" },
      inputs: [],
      metadata: {},
    });
    const request: DriverStartRequest = {
      agentId: "claude-boundary-agent",
      resolvedModel: "auto",
      workOrder,
      coordination: {
        daemonUrl: "http://127.0.0.1:1",
        token: "fixture-agent-token-that-is-long-enough",
        mcpCommand: process.execPath,
        mcpArgs: ["-e", "process.exit(0)"],
        canCreate: false,
        maxDepth: null,
      },
    };
    const controller = new AbortController();
    let session: DriverSession | null = null;
    let boundaryDelivery: ReturnType<ClaudeDriver["sendMessage"]> | null = null;
    const events: DriverEvent[] = [];
    session = await driver.start(request, (event) => {
      events.push(event);
      if (event.kind === "run.completed" && session) {
        boundaryDelivery = driver.sendMessage(session, "This belongs to the next durable turn.");
      }
    }, { signal: controller.signal });

    await expect.poll(() => boundaryDelivery !== null, { timeout: 8_000, interval: 20 }).toBe(true);
    if (!boundaryDelivery || !session) throw new Error("Claude terminal-boundary delivery was not captured.");
    const delivery = await boundaryDelivery;
    expect(delivery).toMatchObject({ queued: true, terminalBoundary: true });
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    expect(lines(join(root, ".fixture-claude-native-dispatches"))).toEqual(["fixture-claude-turn-1"]);
    expect(events.filter((event) => event.kind === "run.completed")).toHaveLength(1);

    await driver.forceTerminate(session);
    await driver.dispose();
  }, 15_000);
});
