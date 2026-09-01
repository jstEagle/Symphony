import { describe, expect, it } from "vitest";
import {
  AGENT_MESSAGE_ACTIONS_STORAGE_KEY,
  createPendingAgentMessageAction,
  readPendingAgentMessageActions,
  updatePendingAgentMessageAction,
  writePendingAgentMessageActions,
} from "../apps/web/src/lib/symphony/agent-message-outbox.js";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("web durable agent message actions", () => {
  it("round-trips one request key and preserves it when marked unknown", () => {
    const target = storage();
    const action = createPendingAgentMessageAction({
      messageId: "message-1",
      action: "reply",
      requestKey: "request-1",
      payload: { summary: "A durable reply" },
      now: "2026-09-01T00:00:00.000Z",
    });
    writePendingAgentMessageActions([action], target);
    const stored = readPendingAgentMessageActions(target);
    expect(stored).toEqual([action]);

    const unknown = updatePendingAgentMessageAction(stored[0]!, { state: "unknown", error: "Network disconnected" }, "2026-09-01T00:00:01.000Z");
    writePendingAgentMessageActions([unknown], target);
    expect(readPendingAgentMessageActions(target)[0]).toMatchObject({ requestKey: "request-1", state: "unknown", error: "Network disconnected" });
  });

  it("removes the durable action only when explicitly cleared", () => {
    const target = storage();
    const action = createPendingAgentMessageAction({ messageId: "message-2", action: "cancel", requestKey: "request-2", payload: {} });
    writePendingAgentMessageActions([action], target);
    writePendingAgentMessageActions([], target);
    expect(target.getItem(AGENT_MESSAGE_ACTIONS_STORAGE_KEY)).toBeNull();
    expect(readPendingAgentMessageActions(target)).toEqual([]);
  });

  it("ignores malformed browser records instead of promoting them to authority", () => {
    const target = storage();
    target.setItem(AGENT_MESSAGE_ACTIONS_STORAGE_KEY, JSON.stringify([{ messageId: "message-3", requestKey: "request-3" }]));
    expect(readPendingAgentMessageActions(target)).toEqual([]);
  });
});
