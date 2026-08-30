import { describe, expect, it, vi } from "vitest";
import {
  deletePendingDriverUpdate,
  ensurePendingDriverUpdate,
  markPendingDriverUpdateAttempt,
  readPendingDriverUpdates,
  reconcilePendingDriverUpdate,
  writePendingDriverUpdate,
} from "../apps/web/src/lib/symphony/driver-update-outbox.js";

describe("driver update browser outbox", () => {
  it("reuses one cross-window key until acknowledgement and protects a newer entry from stale deletion", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "update-request-1" });
    const storage = new MemoryStorage();
    const firstWindow = ensurePendingDriverUpdate("codex", storage);
    const secondWindow = ensurePendingDriverUpdate("codex", storage);
    expect(secondWindow.idempotencyKey).toBe(firstWindow.idempotencyKey);

    writePendingDriverUpdate(markPendingDriverUpdateAttempt(firstWindow, new Error("connection lost")), storage);
    expect(readPendingDriverUpdates(storage)).toMatchObject([{
      driver: "codex",
      idempotencyKey: firstWindow.idempotencyKey,
      attempts: 1,
      lastError: "connection lost",
    }]);

    const update = vi.fn(async () => ({
      report: driverReport(),
      output: "updated",
    }));
    const reconciled = await reconcilePendingDriverUpdate(secondWindow, {
      update,
      isRetryableError: () => true,
    });
    expect(reconciled.status).toBe("acknowledged");
    expect(update).toHaveBeenCalledWith("codex", firstWindow.idempotencyKey);

    const replacement = { ...firstWindow, idempotencyKey: "driver-update:codex:newer" };
    writePendingDriverUpdate(replacement, storage);
    deletePendingDriverUpdate(firstWindow, storage);
    expect(readPendingDriverUpdates(storage)).toEqual([replacement]);
    deletePendingDriverUpdate(replacement, storage);
    expect(readPendingDriverUpdates(storage)).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("keeps retryable ambiguity but rejects a definitive conflict", async () => {
    const pending = {
      version: 1 as const,
      driver: "codex",
      idempotencyKey: "driver-update:codex:pending",
      createdAt: "2026-08-31T00:00:00.000Z",
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    };
    const ambiguous = await reconcilePendingDriverUpdate(pending, {
      update: async () => { throw new Error("outcome unknown"); },
      isRetryableError: () => true,
    });
    expect(ambiguous.status).toBe("retry");
    const rejected = await reconcilePendingDriverUpdate(pending, {
      update: async () => { throw new Error("another key owns the update"); },
      isRetryableError: () => false,
    });
    expect(rejected.status).toBe("rejected");
  });
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function driverReport() {
  return {
    driver: "codex" as const,
    available: true,
    authenticated: true,
    version: "1.1.0",
    capabilities: {
      streaming: true,
      resume: true,
      steer: true,
      passiveHistory: true,
      usage: true,
      mcp: true,
      local: true,
      cloud: false,
      readOnly: true,
    },
    detail: "Updated",
  };
}
