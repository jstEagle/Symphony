import { describe, expect, it, vi } from "vitest";
import {
  deletePendingDriverAuthentication,
  ensurePendingDriverAuthentication,
  markPendingDriverAuthenticationAttempt,
  readPendingDriverAuthentications,
  reconcilePendingDriverAuthentication,
  writePendingDriverAuthentication,
} from "../apps/web/src/lib/symphony/driver-authentication-outbox.js";

describe("driver authentication browser outbox", () => {
  it("reuses one cross-window key until acknowledgement and protects a newer entry from stale deletion", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "authentication-request-1" });
    const storage = new MemoryStorage();
    const firstWindow = ensurePendingDriverAuthentication("cursor", storage);
    const secondWindow = ensurePendingDriverAuthentication("cursor", storage);
    expect(secondWindow.idempotencyKey).toBe(firstWindow.idempotencyKey);

    writePendingDriverAuthentication(
      markPendingDriverAuthenticationAttempt(firstWindow, new Error("connection lost")),
      storage,
    );
    expect(readPendingDriverAuthentications(storage)).toMatchObject([{
      driver: "cursor",
      idempotencyKey: firstWindow.idempotencyKey,
      attempts: 1,
      lastError: "connection lost",
    }]);

    const authenticate = vi.fn(async () => ({ authenticated: true, detail: "Authenticated" }));
    const reconciled = await reconcilePendingDriverAuthentication(secondWindow, {
      authenticate,
      isRetryableError: () => true,
    });
    expect(reconciled.status).toBe("acknowledged");
    expect(authenticate).toHaveBeenCalledWith("cursor", firstWindow.idempotencyKey);

    const replacement = { ...firstWindow, idempotencyKey: "driver-authenticate:cursor:newer" };
    writePendingDriverAuthentication(replacement, storage);
    deletePendingDriverAuthentication(firstWindow, storage);
    expect(readPendingDriverAuthentications(storage)).toEqual([replacement]);
    deletePendingDriverAuthentication(replacement, storage);
    expect(readPendingDriverAuthentications(storage)).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("keeps retryable ambiguity but removes a definitive rejection", async () => {
    const pending = {
      version: 1 as const,
      driver: "cursor",
      idempotencyKey: "driver-authenticate:cursor:pending",
      createdAt: "2026-08-31T00:00:00.000Z",
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    };
    const ambiguous = await reconcilePendingDriverAuthentication(pending, {
      authenticate: async () => { throw new Error("outcome unknown"); },
      isRetryableError: () => true,
    });
    expect(ambiguous.status).toBe("retry");
    const rejected = await reconcilePendingDriverAuthentication(pending, {
      authenticate: async () => { throw new Error("another key owns authentication"); },
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
