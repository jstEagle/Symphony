import type { JsonValue } from "./contracts";

export const AGENT_MESSAGE_ACTIONS_STORAGE_KEY = "symphony.agent-message-actions.v1";

export type AgentMessageAction = "reply" | "handled" | "cancel";
export type PendingAgentMessageAction = Readonly<{
  id: string;
  messageId: string;
  action: AgentMessageAction;
  requestKey: string;
  payload: Readonly<Record<string, JsonValue>>;
  createdAt: string;
  updatedAt: string;
  state: "pending" | "unknown";
  error: string | null;
}>;

type ActionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readPendingAgentMessageActions(storage?: ActionStorage): PendingAgentMessageAction[] {
  const target = storage ?? browserStorage();
  if (!target) return [];
  try {
    const raw = target.getItem(AGENT_MESSAGE_ACTIONS_STORAGE_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(isPendingAgentMessageAction);
  } catch {
    return [];
  }
}

export function writePendingAgentMessageActions(actions: readonly PendingAgentMessageAction[], storage?: ActionStorage): void {
  const target = storage ?? browserStorage();
  if (!target) return;
  try {
    if (actions.length === 0) target.removeItem(AGENT_MESSAGE_ACTIONS_STORAGE_KEY);
    else target.setItem(AGENT_MESSAGE_ACTIONS_STORAGE_KEY, JSON.stringify(actions));
  } catch {
    // A blocked/full browser store cannot become orchestration authority.
  }
}

export function createPendingAgentMessageAction(input: {
  messageId: string;
  action: AgentMessageAction;
  requestKey: string;
  payload: Readonly<Record<string, JsonValue>>;
  now?: string;
}): PendingAgentMessageAction {
  const now = input.now ?? new Date().toISOString();
  return {
    id: `${input.action}:${input.messageId}`,
    messageId: input.messageId,
    action: input.action,
    requestKey: input.requestKey,
    payload: input.payload,
    createdAt: now,
    updatedAt: now,
    state: "pending",
    error: null,
  };
}

export function updatePendingAgentMessageAction(
  action: PendingAgentMessageAction,
  patch: Pick<PendingAgentMessageAction, "state" | "error">,
  now = new Date().toISOString(),
): PendingAgentMessageAction {
  return { ...action, ...patch, updatedAt: now };
}

function isPendingAgentMessageAction(value: unknown): value is PendingAgentMessageAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.messageId === "string"
    && (record.action === "reply" || record.action === "handled" || record.action === "cancel")
    && typeof record.requestKey === "string"
    && Boolean(record.payload && typeof record.payload === "object" && !Array.isArray(record.payload))
    && typeof record.createdAt === "string"
    && typeof record.updatedAt === "string"
    && (record.state === "pending" || record.state === "unknown")
    && (record.error === null || typeof record.error === "string");
}

function browserStorage(): ActionStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try { return window.localStorage; } catch { return undefined; }
}
