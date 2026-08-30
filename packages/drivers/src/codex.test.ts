import { afterEach, describe, expect, it, vi } from "vitest";
import { DriverStartRequestSchema, type DriverEvent, type DriverSession } from "@symphony/protocol";
import { CodexDriver } from "./codex.js";

type NotificationHarness = {
  onNotification(message: Record<string, unknown>, consumer: (event: DriverEvent) => void): void;
};

type FakeRpc = {
  request: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  updateProcessLease: ReturnType<typeof vi.fn>;
};

type ActiveHarness = NotificationHarness & {
  active: Map<string, {
    rpc: FakeRpc;
    emit: (event: DriverEvent) => void;
    threadId: string;
    turnId: string | null;
    pendingUsage: null;
    fullAccess: boolean;
    outputSchema: null;
    activeTools: Set<string>;
    cancellation: null;
    pendingCancelled: null;
    finalOutputTurnId: string | null;
    idleTurnId: string | null;
    idleCompletion: { turnId: string; timer: NodeJS.Timeout; attempt: number } | null;
    lastSettledTurnId: string | null;
  }>;
};

const session: DriverSession = {
  driver: "codex",
  nativeSessionId: "thread-1",
  nativeRunId: "turn-1",
  state: "running",
  startedAt: new Date(0).toISOString(),
  metadata: {},
};

function cancellationHarness(): {
  driver: CodexDriver;
  subject: ActiveHarness;
  rpc: FakeRpc;
  events: DriverEvent[];
  consume: (event: DriverEvent) => void;
} {
  const driver = new CodexDriver({
    enabled: true,
    process: { command: "codex", args: ["app-server"] },
  });
  const subject = driver as unknown as ActiveHarness;
  const events: DriverEvent[] = [];
  const consume = (event: DriverEvent) => events.push(event);
  const rpc: FakeRpc = {
    request: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
    updateProcessLease: vi.fn(),
  };
  subject.active.set("thread-1", {
    rpc,
    emit: consume,
    threadId: "thread-1",
    turnId: "turn-1",
    pendingUsage: null,
    fullAccess: true,
    outputSchema: null,
    activeTools: new Set(),
    cancellation: null,
    pendingCancelled: null,
    finalOutputTurnId: null,
    idleTurnId: null,
    idleCompletion: null,
    lastSettledTurnId: null,
  });
  return { driver, subject, rpc, events, consume };
}

function notification(method: string, item?: Record<string, unknown>): Record<string, unknown> {
  return {
    method,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      ...(item ? { item } : {}),
    },
  };
}

function startRequest() {
  return DriverStartRequestSchema.parse({
    agentId: "agent-codex",
    workOrder: {
      workflowId: "workflow-codex",
      runId: "run-codex",
      depth: 1,
      mission: {
        id: "mission-codex",
        revision: 1,
        hash: "12345678",
        statement: "Exercise durable Codex recovery.",
      },
      objective: "Continue the retained native turn.",
      permissions: "read-only",
      outputSchema: {},
      workspace: { path: "/tmp/symphony-codex-test" },
    },
    resolvedModel: "auto",
    coordination: {
      daemonUrl: "http://127.0.0.1:3210",
      token: "test-token",
      mcpCommand: "symphony-mcp",
      mcpArgs: [],
      canCreate: false,
      maxDepth: 3,
    },
  });
}

function reconnectingDriver(retainedAdapterState: Record<string, unknown>): {
  driver: CodexDriver;
  rpc: {
    mode: "reconnected";
    activate: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    updateProcessLease: ReturnType<typeof vi.fn>;
    retainedAdapterState: ReturnType<typeof vi.fn>;
    isReusable: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
} {
  const driver = new CodexDriver({
    enabled: true,
    process: { command: "codex", args: ["app-server"] },
  });
  const rpc = {
    mode: "reconnected" as const,
    activate: vi.fn().mockResolvedValue(undefined),
    request: vi.fn().mockResolvedValue({}),
    command: vi.fn().mockResolvedValue({}),
    notify: vi.fn(),
    send: vi.fn(),
    updateProcessLease: vi.fn(),
    retainedAdapterState: vi.fn().mockReturnValue(retainedAdapterState),
    isReusable: vi.fn().mockReturnValue(true),
    detach: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  (driver as unknown as { spawn: ReturnType<typeof vi.fn> }).spawn = vi.fn().mockReturnValue(rpc);
  return { driver, rpc };
}

afterEach(() => {
  vi.useRealTimers();
});

function terminalKind(status: string): DriverEvent["kind"] | undefined {
  const events: DriverEvent[] = [];
  const driver = new CodexDriver({
    enabled: true,
    process: { command: "codex", args: ["app-server"] },
  });
  (driver as unknown as NotificationHarness).onNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status },
    },
  }, (event) => events.push(event));
  return events.at(-1)?.kind;
}

describe("Codex terminal projection", () => {
  it.each([
    ["completed", "run.completed"],
    ["interrupted", "run.cancelled"],
    ["cancelled", "run.cancelled"],
    ["failed", "run.failed"],
  ] as const)("maps %s turns to %s", (status, kind) => {
    expect(terminalKind(status)).toBe(kind);
  });

  it("waits for an active tool to become quiescent before confirming cancellation", async () => {
    const { driver, subject, rpc, events, consume } = cancellationHarness();
    subject.onNotification(notification("item/started", {
      id: "tool-1",
      type: "commandExecution",
      command: ["sleep", "30"],
      status: "inProgress",
    }), consume);

    const cancelling = driver.cancel(session);
    subject.onNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
    }, consume);
    await Promise.resolve();
    expect(events.some((event) => event.kind === "run.cancelled")).toBe(false);

    subject.onNotification(notification("item/completed", {
      id: "tool-1",
      type: "commandExecution",
      command: ["sleep", "30"],
      status: "completed",
      exitCode: 130,
    }), consume);
    await cancelling;

    expect(rpc.close).toHaveBeenCalledExactlyOnceWith();
    expect(subject.active.has("thread-1")).toBe(false);
    expect(events.find((event) => event.kind === "run.cancelled")?.payload).toMatchObject({
      toolCleanup: "quiescent",
    });
  });

  it("kills the owned Codex process tree before confirming cancellation when a tool stays active", async () => {
    vi.useFakeTimers();
    const { driver, subject, rpc, events, consume } = cancellationHarness();
    subject.onNotification(notification("item/started", {
      id: "tool-1",
      type: "commandExecution",
      command: ["sleep", "30"],
      status: "inProgress",
    }), consume);

    const cancelling = driver.cancel(session);
    subject.onNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
    }, consume);
    await Promise.resolve();
    expect(events.some((event) => event.kind === "run.cancelled")).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    await cancelling;

    expect(rpc.close).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(subject.active.has("thread-1")).toBe(false);
    expect(events.find((event) => event.kind === "run.cancelled")?.payload).toMatchObject({
      toolCleanup: "process-tree-terminated",
    });
  });

  it("settles from final output plus thread idle when app-server omits turn/completed", async () => {
    vi.useFakeTimers();
    const { subject, rpc, events, consume } = cancellationHarness();

    subject.onNotification(notification("item/completed", {
      id: "message-1",
      type: "agentMessage",
      phase: "final_answer",
      text: "done",
    }), consume);
    subject.onNotification({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
    }, consume);

    await vi.advanceTimersByTimeAsync(499);
    expect(events.some((event) => event.kind === "run.completed")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(events.filter((event) => event.kind === "run.completed")).toHaveLength(1);
    expect(events.find((event) => event.kind === "run.completed")?.payload).toMatchObject({
      terminalEvidence: "thread-idle-after-final-output",
      turnId: "turn-1",
    });
    expect(rpc.updateProcessLease).toHaveBeenCalledWith(expect.objectContaining({ activeTurnId: null }));
    expect(subject.active.get("thread-1")?.turnId).toBeNull();
  });

  it("prefers authoritative turn completion and suppresses the idle fallback", async () => {
    vi.useFakeTimers();
    const { subject, events, consume } = cancellationHarness();
    subject.onNotification(notification("item/completed", {
      id: "message-1",
      type: "agentMessage",
      phase: "final_answer",
      text: "done",
    }), consume);
    subject.onNotification({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
    }, consume);
    subject.onNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    }, consume);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.filter((event) => event.kind === "run.completed")).toHaveLength(1);
    expect(events.find((event) => event.kind === "run.completed")?.payload).not.toMatchObject({
      terminalEvidence: "thread-idle-after-final-output",
    });
  });

  it("gracefully retires a failed native session that cannot accept follow-up work", async () => {
    const { subject, rpc, events, consume } = cancellationHarness();
    subject.onNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed" } },
    }, consume);

    expect(events.filter((event) => event.kind === "run.failed")).toHaveLength(1);
    expect(subject.active.has("thread-1")).toBe(false);
    expect(rpc.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not treat idle without a final answer as completion", async () => {
    vi.useFakeTimers();
    const { subject, events, consume } = cancellationHarness();
    subject.onNotification({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
    }, consume);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.some((event) => event.kind === "run.completed")).toBe(false);
    expect(subject.active.get("thread-1")?.turnId).toBe("turn-1");
  });

  it("never lets the idle fallback win over an in-flight cancellation", async () => {
    vi.useFakeTimers();
    const { driver, subject, events, consume } = cancellationHarness();
    subject.onNotification(notification("item/completed", {
      id: "message-1",
      type: "agentMessage",
      phase: "final_answer",
      text: "partial final",
    }), consume);
    subject.onNotification({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
    }, consume);

    const cancelling = driver.cancel(session);
    subject.onNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
    }, consume);
    await cancelling;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(events.filter((event) => event.kind === "run.completed")).toHaveLength(0);
    expect(events.filter((event) => event.kind === "run.cancelled")).toHaveLength(1);
  });

  it("flushes usage once before idle-fallback completion", async () => {
    vi.useFakeTimers();
    const { subject, events, consume } = cancellationHarness();
    subject.onNotification(notification("item/completed", {
      id: "message-1",
      type: "agentMessage",
      phase: "final_answer",
      text: "done",
    }), consume);
    subject.onNotification({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
    }, consume);
    subject.onNotification({
      method: "thread/tokenUsage/updated",
      params: { threadId: "thread-1", tokenUsage: { last: { inputTokens: 10, outputTokens: 2 } } },
    }, consume);

    await vi.advanceTimersByTimeAsync(500);
    expect(events.map((event) => event.kind).filter((kind) => kind === "usage.recorded")).toHaveLength(1);
    expect(events.findIndex((event) => event.kind === "usage.recorded"))
      .toBeLessThan(events.findIndex((event) => event.kind === "run.completed"));
  });

  it("rehydrates pending cancellation without sending a duplicate interrupt", async () => {
    vi.useFakeTimers();
    const { driver, rpc } = reconnectingDriver({
      version: 1,
      turnId: "turn-1",
      activeToolIds: ["tool-1"],
      pendingUsage: null,
      finalOutputTurnId: null,
      idleTurnId: null,
      lastSettledTurnId: null,
      pendingCancellation: {
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
        turnId: "turn-1",
      },
      idleCompletionAttempt: null,
    });
    const events: DriverEvent[] = [];
    const recovered = await driver.resume(session, startRequest(), (event) => events.push(event));

    const cancelling = driver.cancel(recovered);
    expect(rpc.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await cancelling;

    expect(rpc.close).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(events.filter((event) => event.kind === "run.cancelled")).toHaveLength(1);
    expect(events.find((event) => event.kind === "run.cancelled")?.payload).toMatchObject({
      toolCleanup: "process-tree-terminated",
    });
  });

  it("rehydrates an interrupted idle-completion fallback", async () => {
    vi.useFakeTimers();
    const { driver, rpc } = reconnectingDriver({
      version: 1,
      turnId: "turn-1",
      activeToolIds: [],
      pendingUsage: null,
      finalOutputTurnId: "turn-1",
      idleTurnId: "turn-1",
      lastSettledTurnId: null,
      pendingCancellation: null,
      idleCompletionAttempt: 1,
    });
    const events: DriverEvent[] = [];
    const recovered = await driver.resume(session, startRequest(), (event) => events.push(event));

    await vi.advanceTimersByTimeAsync(499);
    expect(events.some((event) => event.kind === "run.completed")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(events.filter((event) => event.kind === "run.completed")).toHaveLength(1);
    expect(events.find((event) => event.kind === "run.completed")?.payload).toMatchObject({
      terminalEvidence: "thread-idle-after-final-output",
      turnId: "turn-1",
    });
    expect(rpc.updateProcessLease).toHaveBeenCalledWith(expect.objectContaining({ activeTurnId: null }));
    await driver.detach(recovered);
    expect(rpc.detach).toHaveBeenCalledTimes(1);
  });
});
