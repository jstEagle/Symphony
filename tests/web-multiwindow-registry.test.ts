import { describe, expect, it } from "vitest";
import {
  WINDOW_ID_STORAGE_KEY,
  liveWindowRecords,
  getOrCreateWindowId,
  readWindowRecords,
  windowRegistryStorageKey,
  workspaceWindowLabel,
  writeWindowRecord,
  type SymphonyWindowRecord,
} from "../apps/web/src/lib/symphony/window-registry.js";
import { readWorkspaceTab, writeWorkspaceTab } from "../apps/web/src/lib/symphony/workspace-tabs.js";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
    values,
  };
}

function record(windowId: string, openedAt: number, updatedAt = openedAt, extra: Partial<SymphonyWindowRecord> = {}): SymphonyWindowRecord {
  return {
    windowId,
    kind: "main",
    openedAt,
    left: 10,
    top: 20,
    width: 900,
    height: 700,
    focused: true,
    open: true,
    updatedAt,
    ...extra,
  };
}

describe("Symphony browser window registry", () => {
  it("reuses a tab identity across reloads while assigning distinct identities to concurrent tabs", () => {
    const firstTab = storage();
    const secondTab = storage();
    const first = getOrCreateWindowId("main", firstTab);
    expect(getOrCreateWindowId("main", firstTab)).toBe(first);
    expect(first).toMatch(/^main:/u);
    expect(firstTab.values.has(`${WINDOW_ID_STORAGE_KEY}.main`)).toBe(true);
    expect(getOrCreateWindowId("main", secondTab)).not.toBe(first);
  });

  it("keeps concurrent registrations and gives deterministic one-based labels", () => {
    const target = storage();
    writeWindowRecord(record("main:z", 100, 1_000, { title: "Chat" }), target);
    writeWindowRecord(record("main:a", 100, 1_000, { title: "Chat" }), target);
    writeWindowRecord(record("main:b", 200, 1_000, { title: "Another chat" }), target);
    const records = readWindowRecords(target);
    expect(records).toHaveLength(3);
    expect(workspaceWindowLabel("main:a", "Chat", records, 1_000)).toBe("Chat (1)");
    expect(workspaceWindowLabel("main:z", "Chat", records, 1_000)).toBe("Chat (2)");
    expect(workspaceWindowLabel("main:b", "Chat", records, 1_000)).toBe("Chat (3)");
  });

  it("expires crashed windows by heartbeat age and does not suffix a unique live title", () => {
    const now = 10_000;
    const records = [
      record("main:live", 1, now - 999, { title: "Chat" }),
      record("main:crashed", 2, now - 4_001, { title: "Chat" }),
    ];
    expect(liveWindowRecords(records, now).map((item) => item.windowId)).toEqual(["main:live"]);
    expect(workspaceWindowLabel("main:live", "Chat", records, now)).toBe("Chat");
  });

  it("persists geometry and identity-owned state without a shared-array lost update", () => {
    const target = storage();
    const first = record("agent:one", 1, 5, { kind: "agent", agentId: "one", left: 120, top: 140, width: 800, height: 640 });
    const second = record("main:two", 2, 6, { title: "Other" });
    writeWindowRecord(first, target);
    writeWindowRecord(second, target);
    expect(readWindowRecords(target)).toEqual(expect.arrayContaining([first, second]));
    expect(target.values.has(windowRegistryStorageKey(first.windowId))).toBe(true);
    expect(readWindowRecords(target).find((item) => item.windowId === first.windowId)).toMatchObject({
      left: 120,
      top: 140,
      width: 800,
      height: 640,
    });
  });

  it("keeps workspace tabs identity-owned while migrating the legacy default", () => {
    const target = storage({ "symphony.ui.workspaceTab": JSON.stringify("Trace") });
    expect(readWorkspaceTab(target, "main:one")).toBe("Trace");
    writeWorkspaceTab("ControlRoom", target, "main:one");
    writeWorkspaceTab("Studio", target, "main:two");
    expect(readWorkspaceTab(target, "main:one")).toBe("ControlRoom");
    expect(readWorkspaceTab(target, "main:two")).toBe("Studio");
  });

  it("does not let a delayed stale heartbeat overwrite newer state", () => {
    const target = storage();
    const current = record("main:one", 1, 20, { title: "Current" });
    const stale = record("main:one", 1, 10, { title: "Stale" });
    expect(writeWindowRecord(current, target)).toBe(true);
    expect(writeWindowRecord(stale, target)).toBe(false);
    expect(readWindowRecords(target).find((item) => item.windowId === "main:one")?.title).toBe("Current");
  });
});
