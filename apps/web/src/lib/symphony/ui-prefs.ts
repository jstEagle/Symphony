const PINNED_KEY = "symphony.ui.pinnedConversationIds";
const ACTIVE_KEY = "symphony.ui.activeConversationId";
const READ_INBOX_KEY = "symphony.ui.readInboxIds";
const GROUPS_KEY = "symphony.ui.groups";
const CHAT_ORDER_KEY = "symphony.ui.conversationOrder";
const PINNED_ORDER_KEY = "symphony.ui.pinnedConversationOrder";

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

export function readActiveConversationId(scope?: string): string | null {
  const scoped = scopedKey(ACTIVE_KEY, scope);
  const value = readJson<string | null>(scoped, null);
  return value ?? (scope ? readJson<string | null>(ACTIVE_KEY, null) : null);
}

export function writeActiveConversationId(id: string | null, scope?: string): void {
  writeJson(scopedKey(ACTIVE_KEY, scope), id);
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

export function readConversationOrder(): string[] {
  return readStringIds(CHAT_ORDER_KEY);
}

export function writeConversationOrder(ids: string[]): void {
  writeJson(CHAT_ORDER_KEY, ids);
}

export function readPinnedConversationOrder(): string[] {
  return readStringIds(PINNED_ORDER_KEY);
}

export function writePinnedConversationOrder(ids: string[]): void {
  writeJson(PINNED_ORDER_KEY, ids);
}

function readStringIds(key: string): string[] {
  const value = readJson<unknown>(key, []);
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

function scopedKey(key: string, scope?: string): string {
  return scope ? `${key}.${encodeURIComponent(scope)}` : key;
}
