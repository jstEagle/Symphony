import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonLineProcess } from "../packages/drivers/src/process.js";
import { WorkerProcessLeaseSchema, type DriverProcessSupervisor, type WorkerProcessLease } from "../packages/protocol/src/index.js";

const node = process.execPath;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("JsonLineProcess supervision", () => {
  it("reserves before spawn, attaches process identity, and releases only after confirmed exit", async () => {
    const sequence: string[] = [];
    const now = new Date().toISOString();
    let lease = WorkerProcessLeaseSchema.parse({
      id: "lease-json-line",
      daemonOwnerId: "daemon-json-line",
      agentId: "agent-json-line",
      attemptId: "attempt-json-line",
      driver: "codex",
      role: "adapter",
      command: node,
      args: [],
      cwd: null,
      workspacePath: "/tmp",
      permission: "read-only",
      adapterVersion: null,
      identity: null,
      nativeSessionId: null,
      nativeRunId: null,
      activeTurnId: null,
      lastEventCursor: null,
      state: "reserved",
      reservedAt: now,
      attachedAt: null,
      updatedAt: now,
      releasedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      revision: 0,
    });
    const replace = (patch: Partial<WorkerProcessLease>): WorkerProcessLease => {
      lease = WorkerProcessLeaseSchema.parse({ ...lease, ...patch, updatedAt: new Date().toISOString(), revision: lease.revision + 1 });
      return lease;
    };
    const supervisor: DriverProcessSupervisor = {
      reserveProcess: (spec) => {
        sequence.push("reserve");
        lease = WorkerProcessLeaseSchema.parse({ ...lease, ...spec });
        return lease;
      },
      attachProcess: (_id, identity) => {
        sequence.push("attach");
        return replace({ state: "running", identity, attachedAt: new Date().toISOString() });
      },
      updateProcess: (_id, patch) => replace(patch),
      releaseProcess: (_id, result) => {
        sequence.push("release");
        return replace({ state: "exited", releasedAt: new Date().toISOString(), ...result, error: result.error ?? null });
      },
    };
    const rpc = new JsonLineProcess(
      { command: node, args: ["-e", "setInterval(() => {}, 1000)"], processSupervisor: supervisor },
      () => undefined,
    );

    expect(sequence).toEqual(["reserve", "attach"]);
    expect(lease).toMatchObject({ state: "running", identity: { pid: rpc.process.pid } });
    await rpc.close("SIGKILL", 500);
    expect(sequence).toEqual(["reserve", "attach", "release"]);
    expect(lease.state).toBe("exited");
  });

  it("round-trips requests and closes cleanly", async () => {
    const rpc = new JsonLineProcess(
      {
        command: node,
        args: ["-e", `process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { for (const line of chunk.trim().split("\\n")) { const message = JSON.parse(line); process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + "\\n"); } });`],
      },
      () => undefined,
    );

    const checkpoints: unknown[] = [];
    await expect(rpc.requestWithId(
      "stable-direct-request",
      "ping",
      undefined,
      30_000,
      (value) => checkpoints.push(value),
    )).resolves.toEqual({ ok: true });
    expect(checkpoints).toEqual([{ ok: true }]);
    await rpc.close();
  });

  it("reports a spawn failure exactly once without an uncaught process error", async () => {
    const failures: Error[] = [];
    let resolveFailure!: () => void;
    const failed = new Promise<void>((resolve) => { resolveFailure = resolve; });
    const rpc = new JsonLineProcess(
      { command: `missing-symphony-adapter-${Date.now()}` },
      () => undefined,
      undefined,
      undefined,
      (error) => {
        failures.push(error);
        resolveFailure();
      },
    );

    await failed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rpc.close();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toMatch(/ENOENT|spawn/iu);
  });

  it("escalates from SIGTERM to SIGKILL for a stubborn owned process group", async () => {
    const rpc = new JsonLineProcess(
      {
        command: node,
        args: ["-e", `process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);`],
      },
      () => undefined,
    );
    const pid = rpc.process.pid;
    expect(pid).toBeTypeOf("number");

    await new Promise((resolve) => setTimeout(resolve, 30));
    await rpc.close("SIGTERM", 40);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(() => process.kill(pid as number, 0)).toThrow();
  });

  it("kills command grandchildren in the owned process group before they can continue user work", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-descendant-"));
    temporary.push(root);
    const marker = join(root, "descendant-still-running");
    const unrelatedMarker = join(root, "unrelated-still-running");
    const childScript = `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "alive"), 300);
      setInterval(() => {}, 1000);
    `;
    const parentScript = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { detached: true, stdio: "ignore" });
      setInterval(() => {}, 1000);
    `;
    const rpc = new JsonLineProcess(
      { command: node, args: ["-e", parentScript] },
      () => undefined,
    );
    const unrelated = spawn(node, ["-e", `
      const fs = require("node:fs");
      setTimeout(() => fs.writeFileSync(${JSON.stringify(unrelatedMarker)}, "alive"), 300);
    `], { detached: true, stdio: "ignore" });
    unrelated.unref();

    await new Promise((resolve) => setTimeout(resolve, 60));
    await rpc.close("SIGKILL", 500);
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(unrelatedMarker)).toBe(true);
  });

  it("bounds unterminated native output and terminates the adapter", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const unexpected: Error[] = [];
    let resolveProtocolError!: () => void;
    const protocolError = new Promise<void>((resolve) => { resolveProtocolError = resolve; });
    const rpc = new JsonLineProcess(
      {
        command: node,
        args: ["-e", `process.stdout.write("x".repeat(1024 * 1024 + 1)); setInterval(() => {}, 1_000);`],
      },
      (message) => {
        notifications.push(message);
        if (message.type === "protocol-error") resolveProtocolError();
      },
      undefined,
      undefined,
      (error) => unexpected.push(error),
    );

    await protocolError;
    await rpc.close("SIGKILL", 250);
    expect(notifications).toContainEqual(expect.objectContaining({
      type: "protocol-error",
      error: expect.stringContaining("larger than"),
    }));
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]?.message).toContain("larger than");
    expect(rpc.isReusable()).toBe(false);
  });
});
