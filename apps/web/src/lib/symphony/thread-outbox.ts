import type { ChatThreadRecord } from "./contracts";
import type { ChatThreadCreateInput } from "./runtime-client";

export const THREAD_CREATE_OUTBOX_STORAGE_KEY = "symphony.thread-create-outbox.v1";

export type PendingThreadCreate = {
  version: 1;
  idempotencyKey: string;
  input: ChatThreadCreateInput;
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
};

type ReadableStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "length" | "key">>;
type WritableStorage = ReadableStorage & Pick<Storage, "setItem"> & Partial<Pick<Storage, "removeItem">>;

export function createPendingThreadCreate(input: ChatThreadCreateInput, options: {
  idempotencyKey?: string;
  createdAt?: string;
} = {}): PendingThreadCreate {
  return {
    version: 1,
    idempotencyKey: options.idempotencyKey ?? `thread-create:${crypto.randomUUID()}`,
    input,
    createdAt: options.createdAt ?? new Date().toISOString(),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
  };
}

export function readPendingThreadCreates(
  storage: ReadableStorage | null = browserStorage(),
): PendingThreadCreate[] {
  if (!storage || typeof storage.length !== "number" || typeof storage.key !== "function") return [];
  const pending: PendingThreadCreate[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(`${THREAD_CREATE_OUTBOX_STORAGE_KEY}:`)) continue;
    try {
      const value = JSON.parse(storage.getItem(key) ?? "null") as unknown;
      if (isPendingThreadCreate(value)) pending.push(value);
    } catch {
      // One corrupt browser entry must not hide unrelated pending creations.
    }
  }
  return pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function writePendingThreadCreate(
  pending: PendingThreadCreate,
  storage: WritableStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    const key = pendingThreadCreateStorageKey(pending.idempotencyKey);
    const previous = storage.getItem(key);
    if (previous) {
      const existing = JSON.parse(previous) as unknown;
      if (isPendingThreadCreate(existing) && threadCreatePayload(existing) !== threadCreatePayload(pending)) {
        throw new Error(`Thread creation key ${pending.idempotencyKey} is already bound to another payload.`);
      }
    }
    storage.setItem(key, JSON.stringify(pending));
  } catch (error) {
    if (error instanceof Error && error.message.includes("is already bound")) throw error;
    // A blocked or full browser store must not prevent the daemon request.
  }
}

export function deletePendingThreadCreate(
  idempotencyKey: string,
  storage: WritableStorage | null = browserStorage(),
): void {
  if (!storage?.removeItem) return;
  try {
    storage.removeItem(pendingThreadCreateStorageKey(idempotencyKey));
  } catch {
    // A later reconciliation pass can remove a stale browser entry.
  }
}

export function markPendingThreadCreateAttempt(
  pending: PendingThreadCreate,
  error: unknown,
  attemptedAt = new Date().toISOString(),
): PendingThreadCreate {
  return {
    ...pending,
    attempts: pending.attempts + 1,
    lastAttemptAt: attemptedAt,
    lastError: error instanceof Error ? error.message : String(error),
  };
}

export type PendingThreadCreateReconciliation =
  | { status: "acknowledged"; thread: ChatThreadRecord }
  | { status: "retry"; error: unknown }
  | { status: "rejected"; error: unknown };

/** Retry with the exact request identity; the daemon resolves whether creation already committed. */
export async function reconcilePendingThreadCreate(
  pending: PendingThreadCreate,
  dependencies: {
    create: (input: ChatThreadCreateInput, idempotencyKey: string) => Promise<ChatThreadRecord>;
    isRetryableError: (error: unknown) => boolean;
  },
): Promise<PendingThreadCreateReconciliation> {
  try {
    const thread = await dependencies.create(pending.input, pending.idempotencyKey);
    return { status: "acknowledged", thread };
  } catch (error) {
    return dependencies.isRetryableError(error)
      ? { status: "retry", error }
      : { status: "rejected", error };
  }
}

function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function pendingThreadCreateStorageKey(idempotencyKey: string): string {
  return `${THREAD_CREATE_OUTBOX_STORAGE_KEY}:${encodeURIComponent(idempotencyKey)}`;
}

function threadCreatePayload(pending: PendingThreadCreate): string {
  return JSON.stringify(pending.input);
}

function isPendingThreadCreate(value: unknown): value is PendingThreadCreate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PendingThreadCreate>;
  return candidate.version === 1
    && typeof candidate.idempotencyKey === "string"
    && candidate.idempotencyKey.length >= 8
    && isThreadCreateInput(candidate.input)
    && typeof candidate.createdAt === "string"
    && Number.isInteger(candidate.attempts)
    && Number(candidate.attempts) >= 0
    && (candidate.lastAttemptAt === null || typeof candidate.lastAttemptAt === "string")
    && (candidate.lastError === null || typeof candidate.lastError === "string");
}

function isThreadCreateInput(value: unknown): value is ChatThreadCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as ChatThreadCreateInput;
  return (candidate.title === undefined || typeof candidate.title === "string")
    && (candidate.projectId === undefined || typeof candidate.projectId === "string")
    && (candidate.groupId === undefined || candidate.groupId === null || typeof candidate.groupId === "string")
    && (candidate.workspacePath === undefined || typeof candidate.workspacePath === "string")
    && (candidate.mission === undefined || (
      typeof candidate.mission === "object"
      && candidate.mission !== null
      && typeof candidate.mission.statement === "string"
      && (candidate.mission.keyResults === undefined
        || (Array.isArray(candidate.mission.keyResults) && candidate.mission.keyResults.every((item) => typeof item === "string")))
    ));
}
