"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const WINDOW_REGISTRY_PREFIX = "symphony.window-registry.v2.";
export const WINDOW_ID_STORAGE_KEY = "symphony.window-id.v1";
export const WINDOW_REGISTRY_CHANNEL = "symphony.window-registry.v2";
export const WINDOW_HEARTBEAT_MS = 1_000;
export const WINDOW_LIVENESS_MS = 4_000;

export type SymphonyWindowKind = "main" | "agent";

export type SymphonyWindowRecord = {
  windowId: string;
  kind: SymphonyWindowKind;
  agentId?: string;
  conversationId?: string;
  title?: string;
  openedAt: number;
  left: number;
  top: number;
  width: number;
  height: number;
  focused: boolean;
  open: boolean;
  updatedAt: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem" | "key">> & { length?: number };
type WindowRegistryOptions = Pick<SymphonyWindowRecord, "windowId" | "kind"> & {
  agentId?: string;
  conversationId?: string;
  title?: string;
};

/**
 * sessionStorage is scoped to a browser tab/window and survives a reload. It
 * therefore gives a page a stable identity without making two tabs compete
 * for a localStorage key. The fallback is only used when browser storage is
 * unavailable (for example, during SSR or in privacy-restricted contexts).
 */
export function getOrCreateWindowId(kind: SymphonyWindowKind = "main", storage?: StorageLike): string {
  if (typeof window === "undefined" && !storage) return `${kind}:server`;
  const target = storage ?? browserSessionStorage();
  const key = `${WINDOW_ID_STORAGE_KEY}.${kind}`;
  if (target) {
    try {
      const existing = target.getItem(key);
      if (existing?.startsWith(`${kind}:`)) return existing;
      const created = `${kind}:${randomId()}`;
      target.setItem(key, created);
      return created;
    } catch {
      // Continue with an ephemeral identity below.
    }
  }
  return `${kind}:${randomId()}`;
}

export function windowRegistryStorageKey(windowId: string): string {
  return `${WINDOW_REGISTRY_PREFIX}${encodeURIComponent(windowId)}`;
}

export function readWindowRecords(storage?: StorageLike): SymphonyWindowRecord[] {
  const target = storage ?? browserLocalStorage();
  if (!target || typeof target.length !== "number" || typeof target.key !== "function") return [];
  const records: SymphonyWindowRecord[] = [];
  for (let index = 0; index < target.length; index += 1) {
    const key = target.key(index);
    if (!key?.startsWith(WINDOW_REGISTRY_PREFIX)) continue;
    const record = parseWindowRecord(safeGet(target, key));
    if (record) records.push(record);
  }
  return dedupeRecords(records);
}

export function readWindowRecord(windowId: string, storage?: StorageLike): SymphonyWindowRecord | undefined {
  const target = storage ?? browserLocalStorage();
  if (!target) return undefined;
  return parseWindowRecord(safeGet(target, windowRegistryStorageKey(windowId)));
}

export function writeWindowRecord(record: SymphonyWindowRecord, storage?: StorageLike): boolean {
  const target = storage ?? browserLocalStorage();
  if (!target) return false;
  try {
    const existing = parseWindowRecord(target.getItem(windowRegistryStorageKey(record.windowId)));
    if (existing && existing.updatedAt > record.updatedAt) return false;
    target.setItem(windowRegistryStorageKey(record.windowId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function liveWindowRecords(
  records: readonly SymphonyWindowRecord[],
  now = Date.now(),
  livenessMs = WINDOW_LIVENESS_MS,
): SymphonyWindowRecord[] {
  return dedupeRecords(records)
    .filter((record) => record.open && now - record.updatedAt < livenessMs)
    .sort((left, right) => left.openedAt - right.openedAt || left.windowId.localeCompare(right.windowId));
}

export function workspaceWindowLabel(
  windowId: string,
  title: string | undefined,
  records: readonly SymphonyWindowRecord[],
  now = Date.now(),
): string {
  const baseTitle = title?.trim() || "Symphony";
  const matching = liveWindowRecords(records, now).filter((record) => record.kind === "main");
  const index = matching.findIndex((record) => record.windowId === windowId);
  return matching.length > 1 && index >= 0 ? `${baseTitle} (${index + 1})` : baseTitle;
}

/**
 * Register one browser window. Every identity owns its own localStorage key,
 * so concurrent read/modify/write cycles cannot erase another window. The
 * BroadcastChannel is an immediate hint; storage remains the source of truth
 * and is re-read on every hint/heartbeat so delivery order does not matter.
 */
export function useSymphonyWindowRegistry(options: WindowRegistryOptions): SymphonyWindowRecord[] {
  const latest = useRef(options);
  latest.current = options;
  const [records, setRecords] = useState<SymphonyWindowRecord[]>(() => readWindowRecords());

  const refresh = useCallback(() => {
    const next = readWindowRecords();
    setRecords((current) => recordsSignature(current) === recordsSignature(next) ? current : next);
  }, []);

  const report = useCallback((open = true) => {
    if (typeof window === "undefined") return;
    const current = latest.current;
    const previous = readWindowRecord(current.windowId);
    const now = Date.now();
    const record: SymphonyWindowRecord = {
      windowId: current.windowId,
      kind: current.kind,
      ...(current.agentId ? { agentId: current.agentId } : {}),
      ...(current.conversationId ? { conversationId: current.conversationId } : {}),
      ...(current.title ? { title: current.title } : {}),
      openedAt: previous?.openedAt ?? now,
      left: window.screenX,
      top: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
      focused: document.hasFocus(),
      open,
      updatedAt: now,
    };
    if (!writeWindowRecord(record)) return;
    setRecords((currentRecords) => {
      const next = dedupeRecords([...currentRecords.filter((item) => item.windowId !== record.windowId), record]);
      return recordsSignature(currentRecords) === recordsSignature(next) ? currentRecords : next;
    });
    broadcast(record);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const receive = () => refresh();
    const update = () => report(true);
    const channel = openChannel();
    window.addEventListener("storage", receive);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    window.addEventListener("resize", update);
    channel?.addEventListener("message", receive);
    report(true);
    const heartbeat = window.setInterval(() => {
      report(true);
      refresh();
    }, WINDOW_HEARTBEAT_MS);
    const close = () => report(false);
    window.addEventListener("pagehide", close);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("storage", receive);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("pagehide", close);
      channel?.removeEventListener("message", receive);
      channel?.close();
      report(false);
    };
  }, [refresh, report]);

  useEffect(() => {
    report(true);
  }, [options.agentId, options.conversationId, options.kind, options.title, options.windowId, report]);

  return liveWindowRecords(records);
}

function parseWindowRecord(value: string | null): SymphonyWindowRecord | undefined {
  if (!value) return undefined;
  try {
    const candidate = JSON.parse(value) as Partial<SymphonyWindowRecord>;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    if (typeof candidate.windowId !== "string" || (candidate.kind !== "main" && candidate.kind !== "agent")) return undefined;
    if (!["openedAt", "left", "top", "width", "height", "updatedAt"].every((key) => typeof candidate[key as keyof SymphonyWindowRecord] === "number")) return undefined;
    if (typeof candidate.focused !== "boolean" || typeof candidate.open !== "boolean") return undefined;
    return candidate as SymphonyWindowRecord;
  } catch {
    return undefined;
  }
}

function dedupeRecords(records: readonly SymphonyWindowRecord[]): SymphonyWindowRecord[] {
  const byId = new Map<string, SymphonyWindowRecord>();
  for (const record of records) {
    const previous = byId.get(record.windowId);
    if (!previous || record.updatedAt >= previous.updatedAt) byId.set(record.windowId, record);
  }
  return [...byId.values()];
}

function recordsSignature(records: readonly SymphonyWindowRecord[]): string {
  return [...records]
    .sort((left, right) => left.windowId.localeCompare(right.windowId))
    .map((record) => JSON.stringify(record))
    .join("|");
}

function safeGet(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Fall through to the non-cryptographic uniqueness fallback.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function browserLocalStorage(): StorageLike | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function browserSessionStorage(): StorageLike | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function openChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  try {
    return new BroadcastChannel(WINDOW_REGISTRY_CHANNEL);
  } catch {
    return undefined;
  }
}

function broadcast(record: SymphonyWindowRecord): void {
  const channel = openChannel();
  if (!channel) return;
  try {
    channel.postMessage(record);
  } finally {
    channel.close();
  }
}
