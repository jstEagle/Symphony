import { describe, expect, it, vi } from "vitest";
import {
  ObjectiveClient,
  UnknownMutationOutcomeError,
  parseObjectiveArgs,
  renderObjectiveHuman,
  runObjectiveCommand,
} from "../apps/cli/src/objective-cli.js";

describe("objective CLI", () => {
  it("parses composable read and mutation options without shell semantics", () => {
    expect(parseObjectiveArgs([
      "strategy-revise", "run-1", "--body-file", "plan.json", "--idempotency-key", "request-7", "--json", "--config", "local.json",
    ])).toEqual({
      action: "strategy-revise",
      positional: ["run-1"],
      options: {
        json: true,
        configPath: "local.json",
        bodyFile: "plan.json",
        idempotencyKey: "request-7",
        state: [],
        noReconnect: false,
      },
    });
  });

  it("uses daemon routes and preserves the caller's idempotency key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ status: "committed", mutation: { id: "m-1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ObjectiveClient({ baseUrl: "http://localhost:3210", fetchFn });

    await expect(client.mutate("/v1/objectives/run-1/strategy", { type: "insert-node" }, "stable-key")).resolves.toEqual({ status: "committed", mutation: { id: "m-1" } });
    expect(calls[0]?.url).toBe("http://localhost:3210/v1/objectives/run-1/strategy");
    expect(calls[0]?.init?.headers).toMatchObject({ "idempotency-key": "stable-key" });
    expect(calls[0]?.init?.body).toBe('{"type":"insert-node"}');
  });

  it("makes a lost mutation outcome explicit and tells the operator how to recover", async () => {
    const fetchFn = vi.fn(async () => { throw new TypeError("socket closed"); }) as unknown as typeof fetch;
    const client = new ObjectiveClient({ baseUrl: "http://localhost:3210", fetchFn });
    await expect(client.mutate("/v1/objectives/run-1/signals", {}, "retry-me")).rejects.toMatchObject({
      name: "UnknownMutationOutcomeError",
      idempotencyKey: "retry-me",
      message: expect.stringContaining("UNKNOWN"),
    });
  });

  it("classifies generic pre-response transport errors and keeps the retry key stable", async () => {
    let attempts = 0;
    const keys: string[] = [];
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(String((init?.headers as Record<string, string> | undefined)?.["idempotency-key"]));
      attempts += 1;
      if (attempts === 1) throw new Error("connection reset");
      return new Response(JSON.stringify({ status: "committed" }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ObjectiveClient({ baseUrl: "http://localhost:3210", fetchFn });

    let retryKey = "";
    try {
      await client.mutate("/v1/objectives/run-1/signals", {});
      throw new Error("expected the first mutation attempt to fail");
    } catch (error) {
      expect(error).toMatchObject({ name: "UnknownMutationOutcomeError" });
      retryKey = (error as { idempotencyKey: string }).idempotencyKey;
    }
    expect(retryKey).toMatch(/^cli:mutation:/u);
    await expect(client.mutate("/v1/objectives/run-1/signals", {}, retryKey)).resolves.toEqual({ status: "committed" });
    expect(keys).toEqual([retryKey, retryKey]);
  });

  it("follows objective events and resumes from the last durable cursor", async () => {
    const chunks = [": connected\n\n", "id: 12\nevent: objective.task.started\ndata: {\"taskId\":\"task-1\"}\n\n"];
    const fetchFn = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }), { status: 200 })) as unknown as typeof fetch;
    const client = new ObjectiveClient({ baseUrl: "http://localhost:3210", fetchFn });
    const events = [];
    for await (const event of client.follow("run-1", { after: 10, reconnect: false })) events.push(event);
    expect(events).toEqual([{ id: 12, event: "objective.task.started", data: { taskId: "task-1" } }]);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/v1/objectives/run-1/events?after=10");
  });

  it("renders objective output compactly for a terminal while --json remains lossless", async () => {
    const write = vi.fn();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ objectives: [{ objectiveId: "obj-1", state: "waiting", latestRunId: "run-1", statement: "Ship it" }] }), { status: 200 })) as unknown as typeof fetch;
    await runObjectiveCommand(["list"], new ObjectiveClient({ fetchFn }), write);
    expect(write).toHaveBeenCalledWith("obj-1\twaiting\trun-1\tShip it\n");
    expect(renderObjectiveHuman("frontier", { state: "waiting", summary: "waiting for signal", counts: { runnable: 0, running: 0, waitingAttention: 0, outcomeUnknown: 0 }, frontier: [] })).toContain("Frontier: waiting");
  });
});
