"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "symphony.window-layout.v1";
const HEARTBEAT_MS = 1_000;
const ACTIVE_WINDOW_MS = 4_000;

export type SymphonyWindowRecord = {
  windowId: string;
  kind: "main" | "agent";
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

export function useSymphonyWindowRegistry({
  windowId,
  kind,
  agentId,
  conversationId,
  title,
}: Pick<SymphonyWindowRecord, "windowId" | "kind"> & {
  agentId?: string;
  conversationId?: string;
  title?: string;
}) {
  const [windows, setWindows] = useState<SymphonyWindowRecord[]>([]);

  const report = useCallback((open = true) => {
    if (typeof window === "undefined") return;
    const current = readRegistry();
    const previous = current.find((item) => item.windowId === windowId);
    const record: SymphonyWindowRecord = {
      windowId,
      kind,
      ...(agentId ? { agentId } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(title ? { title } : {}),
      openedAt: previous?.openedAt ?? Date.now(),
      left: window.screenX,
      top: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
      focused: document.hasFocus(),
      open,
      updatedAt: Date.now(),
    };
    const next = [...current.filter((item) => item.windowId !== windowId), record];
    writeRegistry(next);
    setWindows((current) => registrySignature(current) === registrySignature(next) ? current : next);
  }, [agentId, conversationId, kind, title, windowId]);

  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        const next = readRegistry();
        setWindows((current) => registrySignature(current) === registrySignature(next) ? current : next);
      }
    };
    const update = () => report(true);
    window.addEventListener("storage", receive);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    window.addEventListener("resize", update);
    report(true);
    const heartbeat = window.setInterval(update, HEARTBEAT_MS);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("storage", receive);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      window.removeEventListener("resize", update);
      report(false);
    };
  }, [report]);

  return windows.filter((item) => item.open && Date.now() - item.updatedAt < ACTIVE_WINDOW_MS);
}

export function openAgentWindow(agentId: string, conversationId?: string): void {
  if (typeof window === "undefined") return;
  const windowId = `agent:${agentId}`;
  const prior = readRegistry().find((item) => item.windowId === windowId || item.agentId === agentId);
  const openCount = readRegistry().filter((item) => item.open && item.kind === "agent").length;
  const width = prior?.width ?? Math.min(960, Math.max(680, window.outerWidth - 180));
  const height = prior?.height ?? Math.min(940, Math.max(620, window.outerHeight - 120));
  const left = prior?.left ?? window.screenX + 44 + (openCount % 5) * 28;
  const top = prior?.top ?? window.screenY + 44 + (openCount % 5) * 28;
  const url = new URL(window.location.href);
  url.searchParams.set("agent", agentId);
  url.searchParams.set("window", windowId);
  if (conversationId) url.searchParams.set("conversation", conversationId);
  const popup = window.open(
    "",
    agentWindowName(agentId),
    `popup=yes,width=${Math.round(width)},height=${Math.round(height)},left=${Math.round(left)},top=${Math.round(top)}`,
  );
  if (!popup) return;
  try {
    const current = new URL(popup.location.href);
    if (current.href === "about:blank" || current.searchParams.get("agent") !== agentId) {
      popup.location.replace(url.toString());
    }
  } catch {
    popup.location.replace(url.toString());
  }
  popup.focus();
}

export function agentWindowName(agentId: string): string {
  return `symphony-agent-${agentId.replace(/[^a-z0-9_-]/giu, "-")}`;
}

function readRegistry(): SymphonyWindowRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(isWindowRecord);
  } catch {
    return [];
  }
}

function writeRegistry(records: SymphonyWindowRecord[]): void {
  const trimmed = records
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 100);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
}

function isWindowRecord(value: unknown): value is SymphonyWindowRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<SymphonyWindowRecord>;
  if (typeof record.openedAt !== "number") record.openedAt = record.updatedAt;
  return typeof record.windowId === "string"
    && (record.kind === "main" || record.kind === "agent")
    && typeof record.left === "number"
    && typeof record.top === "number"
    && typeof record.width === "number"
    && typeof record.height === "number"
    && typeof record.focused === "boolean"
    && typeof record.open === "boolean"
    && typeof record.openedAt === "number"
    && typeof record.updatedAt === "number";
}

function registrySignature(records: SymphonyWindowRecord[]): string {
  const now = Date.now();
  return records
    .filter((item) => item.open && now - item.updatedAt < ACTIVE_WINDOW_MS)
    .sort((left, right) => left.windowId.localeCompare(right.windowId))
    .map((item) => [item.windowId, item.left, item.top, item.width, item.height, item.focused, item.title].join(":"))
    .join("|");
}
