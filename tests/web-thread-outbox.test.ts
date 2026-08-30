import { describe, expect, it, vi } from "vitest";
import {
  THREAD_CREATE_OUTBOX_STORAGE_KEY,
  createPendingThreadCreate,
  deletePendingThreadCreate,
  markPendingThreadCreateAttempt,
  readPendingThreadCreates,
  reconcilePendingThreadCreate,
  writePendingThreadCreate,
} from "../apps/web/src/lib/symphony/thread-outbox.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    values,
  };
}

const pending = createPendingThreadCreate(
  { title: "Durable chat", projectId: "project-1" },
  {
    idempotencyKey: "thread-create-client-1",
    createdAt: "2026-08-31T00:00:00.000Z",
  },
);

const thread = {
  id: "thread-1",
  title: "Durable chat",
  groupId: "project-1",
  conductorAgentId: null,
  mission: {},
  workspacePath: "/workspace",
  archived: false,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

describe("web durable thread creation outbox", () => {
  it("restores the exact request identity and payload after reload", () => {
    const storage = memoryStorage();
    writePendingThreadCreate(pending, storage);

    expect(readPendingThreadCreates(storage)).toEqual([pending]);
    expect([...storage.values.values()]).toContain(JSON.stringify(pending));

    deletePendingThreadCreate(pending.idempotencyKey, storage);
    expect(readPendingThreadCreates(storage)).toEqual([]);
  });

  it("does not allow one stored key to be rebound to another create payload", () => {
    const storage = memoryStorage();
    writePendingThreadCreate(pending, storage);
    expect(() => writePendingThreadCreate({
      ...pending,
      input: { title: "A different chat", projectId: "project-1" },
    }, storage)).toThrow("is already bound to another payload");
  });

  it("retries with the original key so an ambiguous response resolves to the daemon thread", async () => {
    const create = vi.fn(async () => thread);
    const result = await reconcilePendingThreadCreate(pending, {
      create,
      isRetryableError: () => true,
    });

    expect(result).toEqual({ status: "acknowledged", thread });
    expect(create).toHaveBeenCalledWith(pending.input, pending.idempotencyKey);
  });

  it("retains transport failures and rejects definitive API errors", async () => {
    const transportError = new TypeError("fetch failed");
    const retry = await reconcilePendingThreadCreate(pending, {
      create: vi.fn(async () => { throw transportError; }),
      isRetryableError: () => true,
    });
    expect(retry).toEqual({ status: "retry", error: transportError });
    expect(markPendingThreadCreateAttempt(pending, transportError, "2026-08-31T00:00:01.000Z")).toMatchObject({
      idempotencyKey: pending.idempotencyKey,
      input: pending.input,
      attempts: 1,
      lastAttemptAt: "2026-08-31T00:00:01.000Z",
      lastError: "fetch failed",
    });

    const rejection = Object.assign(new Error("Idempotency collision"), { status: 409 });
    const rejected = await reconcilePendingThreadCreate(pending, {
      create: vi.fn(async () => { throw rejection; }),
      isRetryableError: () => false,
    });
    expect(rejected).toEqual({ status: "rejected", error: rejection });
  });

  it("ignores corrupt entries without hiding valid pending creations", () => {
    const storage = memoryStorage();
    storage.setItem(`${THREAD_CREATE_OUTBOX_STORAGE_KEY}:broken`, "{");
    writePendingThreadCreate(pending, storage);
    expect(readPendingThreadCreates(storage)).toEqual([pending]);
  });
});
