import { describe, expect, it } from "vitest";
import {
  STUDIO_MODE_STORAGE_KEY,
  STUDIO_MODES,
  WORKSPACE_TAB_STORAGE_KEY,
  WORKSPACE_TABS,
  normalizeStudioMode,
  normalizeWorkspaceTab,
  readStudioMode,
  readWorkspaceTab,
  writeStudioMode,
  writeWorkspaceTab,
} from "../apps/web/src/lib/symphony/workspace-tabs.js";

function storage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    value: () => value,
  };
}

describe("workspace tab naming", () => {
  it("uses Runline as the primary surface while retaining the other views", () => {
    expect(WORKSPACE_TABS).toEqual(["Chat", "Runline", "ControlRoom", "Studio", "Trace", "Graph", "Activity"]);
    expect(normalizeWorkspaceTab("Runline")).toBe("Runline");
    expect(normalizeWorkspaceTab("ControlRoom")).toBe("ControlRoom");
    expect(normalizeWorkspaceTab("Trace")).toBe("Trace");
    expect(normalizeWorkspaceTab("unknown")).toBe("Runline");
  });

  it("migrates both JSON and legacy raw Overview preferences", () => {
    expect(normalizeWorkspaceTab("Overview")).toBe("Runline");
    expect(readWorkspaceTab(storage(JSON.stringify("Overview")))).toBe("Runline");
    expect(readWorkspaceTab(storage("Overview"))).toBe("Runline");
  });

  it("writes the normalized tab without requiring browser storage", () => {
    const persisted = storage();
    writeWorkspaceTab("Runline", persisted);
    expect(persisted.value()).toBe(JSON.stringify("Runline"));
    expect(WORKSPACE_TAB_STORAGE_KEY).toBe("symphony.ui.workspaceTab");
  });

  it("persists only the Studio view preference used by deep links", () => {
    const persisted = storage();
    expect(STUDIO_MODES).toEqual(["workflows", "capabilities"]);
    expect(normalizeStudioMode("unknown")).toBe("workflows");
    writeStudioMode("capabilities", persisted);
    expect(readStudioMode(persisted)).toBe("capabilities");
    expect(STUDIO_MODE_STORAGE_KEY).toBe("symphony.ui.studioMode");
  });
});
