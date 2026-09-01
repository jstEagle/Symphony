export const WORKSPACE_TABS = ["Chat", "Runline", "ControlRoom", "Studio", "Trace", "Graph", "Activity"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export const STUDIO_MODES = ["workflows", "capabilities"] as const;
export type StudioMode = (typeof STUDIO_MODES)[number];

export const WORKSPACE_TAB_STORAGE_KEY = "symphony.ui.workspaceTab";
export const STUDIO_MODE_STORAGE_KEY = "symphony.ui.studioMode";

type WorkspaceTabStorage = Pick<Storage, "getItem" | "setItem">;

export function workspaceTabStorageKey(scope?: string): string {
  return scope ? `${WORKSPACE_TAB_STORAGE_KEY}.${encodeURIComponent(scope)}` : WORKSPACE_TAB_STORAGE_KEY;
}

/**
 * Normalize persisted workspace views at the boundary. Overview was the
 * original name for the run surface and remains a valid migration input.
 */
export function normalizeWorkspaceTab(value: unknown, fallback: WorkspaceTab = "Runline"): WorkspaceTab {
  if (value === "Overview") return "Runline";
  return WORKSPACE_TABS.includes(value as WorkspaceTab) ? value as WorkspaceTab : fallback;
}

export function readWorkspaceTab(storage?: WorkspaceTabStorage, scope?: string): WorkspaceTab {
  const target = storage ?? browserStorage();
  if (!target) return "Runline";
  try {
    const raw = target.getItem(workspaceTabStorageKey(scope)) ?? (scope ? target.getItem(WORKSPACE_TAB_STORAGE_KEY) : null);
    if (!raw) return "Runline";
    try {
      return normalizeWorkspaceTab(JSON.parse(raw));
    } catch {
      return normalizeWorkspaceTab(raw);
    }
  } catch {
    return "Runline";
  }
}

export function writeWorkspaceTab(tab: WorkspaceTab, storage?: WorkspaceTabStorage, scope?: string): void {
  const target = storage ?? browserStorage();
  if (!target) return;
  try {
    target.setItem(workspaceTabStorageKey(scope), JSON.stringify(normalizeWorkspaceTab(tab)));
  } catch {
    // A blocked or full browser store must not prevent workspace navigation.
  }
}

export function normalizeStudioMode(value: unknown, fallback: StudioMode = "workflows"): StudioMode {
  return STUDIO_MODES.includes(value as StudioMode) ? value as StudioMode : fallback;
}

export function readStudioMode(storage?: WorkspaceTabStorage, scope?: string): StudioMode {
  const target = storage ?? browserStorage();
  if (!target) return "workflows";
  try {
    const raw = target.getItem(studioModeStorageKey(scope)) ?? (scope ? target.getItem(STUDIO_MODE_STORAGE_KEY) : null);
    if (!raw) return "workflows";
    try {
      return normalizeStudioMode(JSON.parse(raw));
    } catch {
      return normalizeStudioMode(raw);
    }
  } catch {
    return "workflows";
  }
}

export function writeStudioMode(mode: StudioMode, storage?: WorkspaceTabStorage, scope?: string): void {
  const target = storage ?? browserStorage();
  if (!target) return;
  try {
    target.setItem(studioModeStorageKey(scope), JSON.stringify(normalizeStudioMode(mode)));
  } catch {
    // A blocked or full browser store must not prevent Studio navigation.
  }
}

function browserStorage(): WorkspaceTabStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function studioModeStorageKey(scope?: string): string {
  return scope ? `${STUDIO_MODE_STORAGE_KEY}.${encodeURIComponent(scope)}` : STUDIO_MODE_STORAGE_KEY;
}
