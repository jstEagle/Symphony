import type { DriverReport } from "./contracts";

export const DRIVER_UPDATE_OUTBOX_STORAGE_KEY = "symphony.driver-update-outbox.v1";

export type DriverUpdateResult = {
  report: DriverReport;
  output: string;
  recovered?: boolean;
};

export type PendingDriverUpdate = {
  version: 1;
  driver: string;
  idempotencyKey: string;
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
};

type ReadableStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "length" | "key">>;
type WritableStorage = ReadableStorage & Pick<Storage, "setItem"> & Partial<Pick<Storage, "removeItem">>;

export function ensurePendingDriverUpdate(
  driver: string,
  storage: WritableStorage | null = browserStorage(),
): PendingDriverUpdate {
  const existing = readPendingDriverUpdates(storage).find((entry) => entry.driver === driver);
  if (existing) return existing;
  const pending: PendingDriverUpdate = {
    version: 1,
    driver,
    idempotencyKey: `driver-update:${driver}:${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
  };
  writePendingDriverUpdate(pending, storage);
  return readPendingDriverUpdates(storage).find((entry) => entry.driver === driver) ?? pending;
}

export function readPendingDriverUpdates(
  storage: ReadableStorage | null = browserStorage(),
): PendingDriverUpdate[] {
  if (!storage || typeof storage.length !== "number" || typeof storage.key !== "function") return [];
  const pending: PendingDriverUpdate[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(`${DRIVER_UPDATE_OUTBOX_STORAGE_KEY}:`)) continue;
    try {
      const value = JSON.parse(storage.getItem(key) ?? "null") as unknown;
      if (isPendingDriverUpdate(value)) pending.push(value);
    } catch {
      // One malformed harness update must not hide other pending updates.
    }
  }
  return pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function writePendingDriverUpdate(
  pending: PendingDriverUpdate,
  storage: WritableStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(pendingDriverUpdateStorageKey(pending.driver), JSON.stringify(pending));
  } catch {
    // Browser storage is a retry aid. The durable daemon receipt remains authoritative.
  }
}

export function deletePendingDriverUpdate(
  pending: Pick<PendingDriverUpdate, "driver" | "idempotencyKey">,
  storage: WritableStorage | null = browserStorage(),
): void {
  if (!storage?.removeItem) return;
  try {
    const key = pendingDriverUpdateStorageKey(pending.driver);
    const current = JSON.parse(storage.getItem(key) ?? "null") as unknown;
    if (isPendingDriverUpdate(current) && current.idempotencyKey === pending.idempotencyKey) {
      storage.removeItem(key);
    }
  } catch {
    // A later reconciliation pass can remove the stale entry.
  }
}

export function markPendingDriverUpdateAttempt(
  pending: PendingDriverUpdate,
  error: unknown,
  attemptedAt = new Date().toISOString(),
): PendingDriverUpdate {
  return {
    ...pending,
    attempts: pending.attempts + 1,
    lastAttemptAt: attemptedAt,
    lastError: error instanceof Error ? error.message : String(error),
  };
}

export type PendingDriverUpdateReconciliation =
  | { status: "acknowledged"; result: DriverUpdateResult }
  | { status: "retry"; error: unknown }
  | { status: "rejected"; error: unknown };

export async function reconcilePendingDriverUpdate(
  pending: PendingDriverUpdate,
  dependencies: {
    update: (driver: string, idempotencyKey: string) => Promise<DriverUpdateResult>;
    isRetryableError: (error: unknown) => boolean;
  },
): Promise<PendingDriverUpdateReconciliation> {
  try {
    return {
      status: "acknowledged",
      result: await dependencies.update(pending.driver, pending.idempotencyKey),
    };
  } catch (error) {
    return dependencies.isRetryableError(error)
      ? { status: "retry", error }
      : { status: "rejected", error };
  }
}

function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function pendingDriverUpdateStorageKey(driver: string): string {
  return `${DRIVER_UPDATE_OUTBOX_STORAGE_KEY}:${encodeURIComponent(driver)}`;
}

function isPendingDriverUpdate(value: unknown): value is PendingDriverUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PendingDriverUpdate>;
  return candidate.version === 1
    && typeof candidate.driver === "string"
    && candidate.driver.length > 0
    && typeof candidate.idempotencyKey === "string"
    && candidate.idempotencyKey.length >= 8
    && typeof candidate.createdAt === "string"
    && Number.isInteger(candidate.attempts)
    && Number(candidate.attempts) >= 0
    && (candidate.lastAttemptAt === null || typeof candidate.lastAttemptAt === "string")
    && (candidate.lastError === null || typeof candidate.lastError === "string");
}
