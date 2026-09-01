import { afterEach, describe, expect, it, vi } from "vitest";
import { studioModeForCommand } from "../apps/web/src/components/symphony/command-palette.js";
import { rankFuzzyMatches, rankPaletteActions } from "../apps/web/src/lib/symphony/palette-search.js";
import {
  currentConversationOrder,
  moveIdBefore,
  orderGroupConversations,
  orderPinnedConversations,
} from "../apps/web/src/lib/symphony/sidebar-order.js";
import { agentWindowName, openAgentWindow } from "../apps/web/src/lib/symphony/window-layout.js";

const chat = (id: string, pinned = false) => ({ id, pinned });

describe("sidebar conversation ordering", () => {
  it("keeps new chats visible first without resetting the user's existing group order", () => {
    const conversations = [chat("new"), chat("older-a"), chat("older-b")];
    expect(orderGroupConversations(conversations, ["older-b", "older-a"]).map((item) => item.id)).toEqual([
      "new",
      "older-b",
      "older-a",
    ]);
    expect(currentConversationOrder([{ id: "project", conversations }], ["older-b", "older-a"])).toEqual([
      "new",
      "older-b",
      "older-a",
    ]);
  });

  it("reorders pinned chats independently of their project membership", () => {
    const pinned = [chat("project-a", true), chat("project-b", true), chat("new-pin", true)];
    const current = orderPinnedConversations(pinned, ["project-b", "project-a"]).map((item) => item.id);
    expect(current).toEqual(["project-b", "project-a", "new-pin"]);
    expect(moveIdBefore(current, "project-a", "project-b")).toEqual(["project-a", "project-b", "new-pin"]);
  });
});

describe("command palette local fallback", () => {
  it("keeps useful fuzzy matches available when remote semantic search has no result", () => {
    const chats = [
      { id: "one", text: "Durable worker recovery" },
      { id: "two", text: "Theme settings" },
    ];
    expect(rankFuzzyMatches(chats, "dwr", (item) => item.text).map((item) => item.id)).toEqual(["one"]);
  });

  it("ranks available operator actions and never exposes permission-denied actions", () => {
    const actions = [
      { id: "trace", label: "Open Trace", detail: "Inspect event evidence" },
      { id: "diagnostics", label: "Open diagnostics", detail: "Inspect daemon health" },
      { id: "admin", label: "Reset daemon", detail: "Requires full access", available: false },
    ];
    expect(rankPaletteActions(actions, "diag").map((action) => action.id)).toEqual(["diagnostics"]);
    expect(rankPaletteActions(actions, "").map((action) => action.id)).toEqual(["trace", "diagnostics"]);
  });

  it("deep-links the capability command into Studio capabilities without changing generic Studio navigation", () => {
    expect(studioModeForCommand("capabilities")).toBe("capabilities");
    expect(studioModeForCommand("studio")).toBeUndefined();
  });
});

describe("agent popout reuse", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses a stable named popup, navigates it once, and focuses it on every request", () => {
    const focus = vi.fn();
    const replace = vi.fn((next: string) => { popup.location.href = next; });
    const popup = { closed: false, focus, location: { href: "about:blank", replace } };
    const open = vi.fn(() => popup);
    const localStorage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    vi.stubGlobal("window", {
      location: { href: "http://127.0.0.1:3210/" },
      localStorage,
      open,
      outerWidth: 1400,
      outerHeight: 900,
      screenX: 20,
      screenY: 30,
    });

    openAgentWindow("agent:one", "thread-1");
    openAgentWindow("agent:one", "thread-1");

    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls.every((call) => call[1] === agentWindowName("agent:one"))).toBe(true);
    expect(open.mock.calls.every((call) => !String(call[2]).includes("noopener"))).toBe(true);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(2);
  });
});
