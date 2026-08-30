const PINNED_KEY = "symphony.ui.pinnedConversationIds";
const ACTIVE_KEY = "symphony.ui.activeConversationId";
const READ_INBOX_KEY = "symphony.ui.readInboxIds";
const GROUPS_KEY = "symphony.ui.groups";

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function readPinnedIds(): string[] {
  return readJson<string[]>(PINNED_KEY, []);
}

export function writePinnedIds(ids: string[]): void {
  writeJson(PINNED_KEY, ids);
}

export function readActiveConversationId(): string | null {
  return readJson<string | null>(ACTIVE_KEY, null);
}

export function writeActiveConversationId(id: string | null): void {
  writeJson(ACTIVE_KEY, id);
}

export function readInboxIds(): string[] {
  return readJson<string[]>(READ_INBOX_KEY, []);
}

export function writeReadInboxIds(ids: string[]): void {
  writeJson(READ_INBOX_KEY, ids);
}

export function readGroups(): Array<{ id: string; title: string }> {
  return readJson<Array<{ id: string; title: string }>>(GROUPS_KEY, []);
}

export function writeGroups(groups: Array<{ id: string; title: string }>): void {
  writeJson(GROUPS_KEY, groups);
}
