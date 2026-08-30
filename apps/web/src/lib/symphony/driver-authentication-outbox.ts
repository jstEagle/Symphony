import type { DriverAuthenticationResult } from "./contracts";

export const DRIVER_AUTHENTICATION_OUTBOX_STORAGE_KEY = "symphony.driver-authentication-outbox.v1";

export type PendingDriverAuthentication = {
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

export function ensurePendingDriverAuthentication(
  driver: string,
  storage: WritableStorage | null = browserStorage(),
): PendingDriverAuthentication {
  const existing = readPendingDriverAuthentications(storage).find((entry) => entry.driver === driver);
  if (existing) return existing;
  const pending: PendingDriverAuthentication = {
    version: 1,
    driver,
    idempotencyKey: `driver-authenticate:${driver}:${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
  };
  writePendingDriverAuthentication(pending, storage);
  return readPendingDriverAuthentications(storage).find((entry) => entry.driver === driver) ?? pending;
}

export function readPendingDriverAuthentications(
  storage: ReadableStorage | null = browserStorage(),
): PendingDriverAuthentication[] {
  if (!storage || typeof storage.length !== "number" || typeof storage.key !== "function") return [];
  const pending: PendingDriverAuthentication[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(`${DRIVER_AUTHENTICATION_OUTBOX_STORAGE_KEY}:`)) continue;
    try {
      const value = JSON.parse(storage.getItem(key) ?? "null") as unknown;
      if (isPendingDriverAuthentication(value)) pending.push(value);
    } catch {
      // One malformed authentication entry must not hide other pending work.
    }
  }
  return pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function writePendingDriverAuthentication(
  pending: PendingDriverAuthentication,
  storage: WritableStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(pendingDriverAuthenticationStorageKey(pending.driver), JSON.stringify(pending));
  } catch {
    // Browser storage is a retry aid. The daemon's durable receipt is authoritative.
  }
}

export function deletePendingDriverAuthentication(
  pending: Pick<PendingDriverAuthentication, "driver" | "idempotencyKey">,
  storage: WritableStorage | null = browserStorage(),
): void {
  if (!storage?.removeItem) return;
  try {
    const key = pendingDriverAuthenticationStorageKey(pending.driver);
    const current = JSON.parse(storage.getItem(key) ?? "null") as unknown;
    if (isPendingDriverAuthentication(current) && current.idempotencyKey === pending.idempotencyKey) {
      storage.removeItem(key);
    }
  } catch {
    // A later reconciliation pass can remove the stale entry.
  }
}

export function markPendingDriverAuthenticationAttempt(
  pending: PendingDriverAuthentication,
  error: unknown,
  attemptedAt = new Date().toISOString(),
): PendingDriverAuthentication {
  return {
    ...pending,
    attempts: pending.attempts + 1,
    lastAttemptAt: attemptedAt,
    lastError: error instanceof Error ? error.message : String(error),
  };
}

export type PendingDriverAuthenticationReconciliation =
  | { status: "acknowledged"; result: DriverAuthenticationResult }
  | { status: "retry"; error: unknown }
  | { status: "rejected"; error: unknown };

export async function reconcilePendingDriverAuthentication(
  pending: PendingDriverAuthentication,
  dependencies: {
    authenticate: (driver: string, idempotencyKey: string) => Promise<DriverAuthenticationResult>;
    isRetryableError: (error: unknown) => boolean;
  },
): Promise<PendingDriverAuthenticationReconciliation> {
  try {
    return {
      status: "acknowledged",
      result: await dependencies.authenticate(pending.driver, pending.idempotencyKey),
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

function pendingDriverAuthenticationStorageKey(driver: string): string {
  return `${DRIVER_AUTHENTICATION_OUTBOX_STORAGE_KEY}:${encodeURIComponent(driver)}`;
}

function isPendingDriverAuthentication(value: unknown): value is PendingDriverAuthentication {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PendingDriverAuthentication>;
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
