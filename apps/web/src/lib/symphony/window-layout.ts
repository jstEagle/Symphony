"use client";

import { readWindowRecords } from "@/lib/symphony/window-registry";

/** Open (or focus) a reusable agent window, retaining its last geometry. */
export function openAgentWindow(agentId: string, conversationId?: string): void {
  if (typeof window === "undefined") return;
  const windowId = `agent:${agentId}`;
  const records = readWindowRecords();
  const prior = records.find((item) => item.windowId === windowId || item.agentId === agentId);
  const openCount = records.filter((item) => item.open && item.kind === "agent").length;
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
