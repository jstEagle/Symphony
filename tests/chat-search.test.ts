import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, SecretStore } from "../packages/config/src/index.js";
import { ConversationMessageSchema } from "../packages/protocol/src/index.js";
import { UiUtilityService } from "../packages/runtime/src/index.js";
import { SymphonyStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "symphony-chat-search-"));
  temporary.push(root);
  return root;
}

describe("bounded chat search", () => {
  it("keeps remote reranking off by default and parses an explicit opt-in", () => {
    const root = temporaryRoot();
    expect(loadConfig({ rootDirectory: root }).config.uiUtilities.chatSearch.rerankEnabled).toBe(false);
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      version: 1,
      uiUtilities: { chatSearch: { rerankEnabled: true, prefilterLimit: 12 } },
    }));
    const loaded = loadConfig({ rootDirectory: root });
    expect(loaded.config.uiUtilities.chatSearch).toMatchObject({
      rerankEnabled: true,
      reranker: "cohere/rerank-v3.5",
      prefilterLimit: 12,
      maxDocumentCharacters: 4_000,
    });
  });

  it("retrieves the actual newest messages beyond the legacy 1000-row window", () => {
    const root = temporaryRoot();
    const store = new SymphonyStore(join(root, "state.sqlite"));
    const origin = Date.parse("2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 1_005; index += 1) {
      store.appendConversationMessage(ConversationMessageSchema.parse({
        id: `message-${String(index).padStart(4, "0")}`,
        threadId: "thread",
        role: "user",
        parts: [{ type: "text", text: `message ${index}` }],
        createdAt: new Date(origin + index).toISOString(),
      }));
    }
    expect(store.listConversationMessages("thread")).toHaveLength(1_000);
    expect(store.listRecentConversationMessages("thread", 3).map((message) => message.id)).toEqual([
      "message-1002",
      "message-1003",
      "message-1004",
    ]);
    store.close();
  });

  it("does not inspect secrets or call the network while reranking is disabled", async () => {
    const root = temporaryRoot();
    const loaded = loadConfig({ rootDirectory: root });
    const store = new SymphonyStore(join(root, "state.sqlite"));
    const secrets = new SecretStore("dev.symphony.search-test");
    const getSecret = vi.spyOn(secrets, "get").mockReturnValue("unused");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const service = new UiUtilityService(loaded, secrets, store);
    await expect(service.rankChats("query", [{ id: "one", text: "document" }])).resolves.toBeNull();
    expect(getSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    store.close();
  });

  it("caps candidates and document text, meters unknown cost, and caches identical reranks", async () => {
    const root = temporaryRoot();
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.uiUtilities.provider = "openrouter";
    loaded.config.uiUtilities.chatSearch.rerankEnabled = true;
    loaded.config.uiUtilities.chatSearch.prefilterLimit = 2;
    loaded.config.uiUtilities.chatSearch.maxDocumentCharacters = 256;
    const store = new SymphonyStore(join(root, "state.sqlite"));
    const secrets = new SecretStore("dev.symphony.search-test");
    vi.spyOn(secrets, "get").mockReturnValue("secret");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.4 },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new UiUtilityService(loaded, secrets, store);
    const documents = [
      { id: "one", text: "a".repeat(500) },
      { id: "two", text: "b".repeat(500) },
      { id: "three", text: "c".repeat(500) },
    ];
    const first = await service.rankChats("bounded query", documents);
    const second = await service.rankChats("bounded query", documents);
    expect(first).toEqual([{ id: "two", score: 0.9 }, { id: "one", score: 0.4 }]);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { model: string; documents: string[]; top_n: number };
    expect(body).toMatchObject({ model: "cohere/rerank-v3.5", top_n: 2 });
    expect(body.documents).toHaveLength(2);
    expect(body.documents.every((document) => document.length === 256)).toBe(true);
    expect(store.listUsage({ workflowId: "ui:chat-search" })).toMatchObject([
      { basis: "unknown", costAmount: null, model: "cohere/rerank-v3.5" },
    ]);
    store.close();
  });

  it("treats empty provider results as unavailable rather than semantic success", async () => {
    const root = temporaryRoot();
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.uiUtilities.chatSearch.rerankEnabled = true;
    const store = new SymphonyStore(join(root, "state.sqlite"));
    const secrets = new SecretStore("dev.symphony.search-test");
    vi.spyOn(secrets, "get").mockReturnValue("secret");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const service = new UiUtilityService(loaded, secrets, store);
    await expect(service.rankChats("query", [{ id: "one", text: "document" }])).resolves.toBeNull();
    expect(store.listUsage({ workflowId: "ui:chat-search" })).toHaveLength(1);
    store.close();
  });
});
