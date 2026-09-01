import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/symphony.config", () => ({
  symphonyConfig: {
    apiBasePath: "/v1",
    staleAfterMs: 1_000,
    reconnect: { minDelayMs: 5, maxDelayMs: 20 },
  },
}), { virtual: true });

import {
  fetchBootstrap,
  runtimeBootstrapRefetchInterval,
  subscribeToRuntime,
} from "../apps/web/src/lib/symphony/runtime-client.js";

const encoder = new TextEncoder();

function eventFrame(cursor: number): string {
  return `id: event-${cursor}\nevent: event\ndata: ${JSON.stringify({
    id: `event-${cursor}`,
    cursor,
    type: "agent.updated",
    workflowId: null,
    runId: null,
    agentId: null,
    occurredAt: "2026-08-30T00:00:00.000Z",
    payload: { cursor },
    provenance: { source: "daemon" },
  })}\n\n`;
}

function resetFrame(): string {
  return "event: reset\ndata: cursor no longer available\n\n";
}

function responseFor(frames: string[], onCancel: () => void = () => undefined) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => index < frames.length
          ? { value: encoder.encode(frames[index++]), done: false }
          : { value: undefined, done: true },
        cancel: async () => {
          onCancel();
        },
      }),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime SSE reconnect boundary", () => {
  it("keeps retrying an unavailable runtime bootstrap until a daemon reload succeeds", () => {
    expect(runtimeBootstrapRefetchInterval("runtime", { data: undefined, error: new Error("daemon restarting") })).toBe(3_000);
    expect(runtimeBootstrapRefetchInterval("runtime", { data: undefined })).toBe(3_000);
    expect(runtimeBootstrapRefetchInterval("runtime", { data: { runtimeEpoch: "epoch-1" }, error: new Error("stale request") })).toBe(3_000);
    expect(runtimeBootstrapRefetchInterval("runtime", { data: { runtimeEpoch: "epoch-1" }, error: null })).toBe(false);
    expect(runtimeBootstrapRefetchInterval("preview", { data: undefined, error: new Error("ignored") })).toBe(false);
  });

  it("applies only strictly newer cursors and resumes from the last applied cursor", async () => {
    const calls: string[] = [];
    const applied: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (calls.length === 1) {
        return responseFor([
          eventFrame(4),
          eventFrame(6),
          eventFrame(6),
          eventFrame(7),
        ]);
      }
      return responseFor([eventFrame(7), eventFrame(8)]);
    }));
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
    });

    let unsubscribe = () => undefined;
    unsubscribe = subscribeToRuntime(
      5,
      (event) => {
        applied.push(event.cursor);
        if (event.cursor === 8) unsubscribe();
      },
      vi.fn(),
      vi.fn(),
    );

    await vi.waitFor(() => expect(applied).toEqual([6, 7, 8]), { timeout: 1_000 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/v1/events?after=5&projection=ui");
    expect(calls[1]).toContain("/v1/events?after=7&projection=ui");
    unsubscribe();
  });

  it("builds an all-event stream URL for one agent transcript", async () => {
    const calls: string[] = [];
    const applied: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return responseFor([eventFrame(6)]);
    }));
    vi.stubGlobal("window", { setTimeout, clearTimeout });

    let unsubscribe = () => undefined;
    unsubscribe = subscribeToRuntime(
      5,
      (event) => {
        applied.push(event.cursor);
        unsubscribe();
      },
      vi.fn(),
      vi.fn(),
      { agentId: "agent-1", projection: "all" },
    );

    await vi.waitFor(() => expect(applied).toEqual([6]), { timeout: 1_000 });
    expect(calls[0]).toContain("/v1/events?after=5&agentId=agent-1");
    expect(calls[0]).not.toContain("projection=ui");
    unsubscribe();
  });

  it("does not deliver a late frame after the subscription has been stopped", async () => {
    let release: ((result: { value: Uint8Array; done: boolean }) => void) | undefined;
    const applied: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => new Promise<{ value: Uint8Array; done: boolean }>((resolve) => {
            release = resolve;
          }),
        }),
      },
    })));
    vi.stubGlobal("window", { setTimeout, clearTimeout });

    const unsubscribe = subscribeToRuntime(5, (event) => applied.push(event.cursor), vi.fn(), vi.fn());
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    unsubscribe();
    release?.({ value: encoder.encode(eventFrame(6)), done: false });
    await Promise.resolve();
    expect(applied).toEqual([]);
  });

  it("ignores malformed frames without losing the stream", async () => {
    const applied: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => responseFor([
      "event: event\ndata: {not-json}\n\n",
      eventFrame(6),
    ])));
    vi.stubGlobal("window", { setTimeout, clearTimeout });

    let unsubscribe = () => undefined;
    unsubscribe = subscribeToRuntime(5, (event) => {
      applied.push(event.cursor);
      unsubscribe();
    }, vi.fn(), vi.fn());

    await vi.waitFor(() => expect(applied).toEqual([6]), { timeout: 1_000 });
    unsubscribe();
  });

  it("reconnects after a reset frame even when the runtime epoch is unchanged", async () => {
    const calls: string[] = [];
    const applied: number[] = [];
    const onReset = vi.fn();
    let activeStreams = 0;
    let overlap = false;
    const cancel = vi.fn(() => {
      activeStreams -= 1;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length > 1 && activeStreams > 0) overlap = true;
      activeStreams += 1;
      return calls.length === 1
        ? responseFor([resetFrame()], cancel)
        : responseFor([eventFrame(6)], () => { activeStreams -= 1; });
    }));
    vi.stubGlobal("window", { setTimeout, clearTimeout });

    let unsubscribe = () => undefined;
    unsubscribe = subscribeToRuntime(
      5,
      (event) => {
        applied.push(event.cursor);
        unsubscribe();
      },
      onReset,
      vi.fn(),
    );

    await vi.waitFor(() => expect(applied).toEqual([6]), { timeout: 1_000 });
    expect(onReset).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(overlap).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/v1/events?after=5&projection=ui");
    expect(calls[1]).toContain("/v1/events?after=5&projection=ui");
    unsubscribe();
  });

  it("fails bootstrap when an authoritative thread query fails instead of projecting an empty cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/v1/threads") return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({
        cursor: 1,
        events: [],
        workflows: [],
        runs: [],
        agents: [],
        messages: [],
        projects: [],
        costs: {},
        runCosts: {},
        agentCosts: {},
        plugins: [],
        settings: {},
        daemon: { version: "test", startedAt: "epoch-1", noPlugins: true },
      }));
    }));

    await expect(fetchBootstrap("runtime")).rejects.toMatchObject({ status: 503 });
  });
});
