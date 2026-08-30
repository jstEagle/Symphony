import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

describe("local daemon API", () => {
  it("serves health, bootstrap, resumable state, and grouped chat metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true });
    try {
      const base = `http://127.0.0.1:${port}`;
      const health = await fetch(`${base}/health`).then((response) => response.json()) as { ok: boolean };
      expect(health.ok).toBe(true);
      const created = await fetch(`${base}/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Harness work", groupId: "Symphony" }) }).then((response) => response.json()) as { id: string; groupId: string };
      expect(created.groupId).toBe("Symphony");
      const bootstrap = await fetch(`${base}/v1/bootstrap`).then((response) => response.json()) as {
        cursor: number;
        events: unknown[];
        runCosts: Record<string, unknown>;
        agentCosts: Record<string, unknown>;
        settings: { conductor: { harness: string } };
        daemon: { noPlugins: boolean };
      };
      expect(bootstrap.cursor).toBeGreaterThan(0);
      expect(bootstrap.events.length).toBeGreaterThan(0);
      expect(bootstrap.runCosts[`chat-run:${created.id}`]).toBeDefined();
      expect(bootstrap.agentCosts).toEqual({});
      expect(bootstrap.settings.conductor.harness).toBe("pi");
      expect(bootstrap.daemon.noPlugins).toBe(true);
      daemon.store.recordUsage({
        id: "heatmap-usage",
        workflowId: `chat:${created.id}`,
        runId: `chat-run:${created.id}`,
        agentId: null,
        model: "fixture",
        harness: null,
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: null,
        costAmount: 0.0025,
        currency: "USD",
        basis: "provider-reported",
        priceSnapshotId: null,
        recordedAt: new Date().toISOString(),
      });
      const heatmap = await fetch(`${base}/v1/usage/heatmap?weeks=12`).then((response) => response.json()) as {
        weeks: number;
        days: Array<{ knownCost: number; eventCount: number; future: boolean }>;
      };
      expect(heatmap.weeks).toBe(12);
      expect(heatmap.days).toHaveLength(84);
      expect(heatmap.days.some((day) => day.knownCost === 0.0025 && day.eventCount === 1 && !day.future)).toBe(true);
      const detail = await fetch(`${base}/v1/threads/${created.id}`).then((response) => response.json()) as { thread: { title: string }; messages: unknown[] };
      expect(detail.thread.title).toBe("Harness work");
      expect(detail.messages).toEqual([]);

      const projectPath = join(root, "project-alpha");
      const canonicalRoot = realpathSync(root);
      mkdirSync(join(projectPath, "src"), { recursive: true });
      mkdirSync(join(projectPath, ".git"));
      const listing = await fetch(`${base}/v1/filesystem/directories?path=${encodeURIComponent(root)}`).then((response) => response.json()) as {
        currentPath: string;
        entries: Array<{ name: string; isGitRepository: boolean }>;
      };
      expect(listing.currentPath).toBe(canonicalRoot);
      expect(listing.entries).toContainEqual(expect.objectContaining({ name: "project-alpha", isGitRepository: true }));
      const project = await fetch(`${base}/v1/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspacePath: projectPath }),
      }).then((response) => response.json()) as { id: string; title: string; workspacePath: string; isGitRepository: boolean };
      const canonicalProjectPath = realpathSync(projectPath);
      expect(project).toMatchObject({ title: "project-alpha", workspacePath: canonicalProjectPath, isGitRepository: true });
      const projectChat = await fetch(`${base}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      }).then((response) => response.json()) as { id: string; groupId: string; workspacePath: string };
      expect(projectChat).toMatchObject({ groupId: project.id, workspacePath: canonicalProjectPath });

      const streamingAgentId = "streaming-conductor";
      const streamingThread = daemon.store.getThread(projectChat.id);
      expect(streamingThread).not.toBeNull();
      daemon.store.saveThread({ ...streamingThread!, conductorAgentId: streamingAgentId });
      daemon.store.saveAgent({
        id: streamingAgentId,
        logicalAgentId: streamingAgentId,
        workflowId: `chat:${projectChat.id}`,
        runId: `chat-run:${projectChat.id}`,
        parentAgentId: null,
        depth: 0,
        objective: "Stream a response",
        missionHash: "fixture-mission",
        requestedHarness: "codex",
        requestedModel: "fixture",
        harness: "codex",
        model: "fixture",
        permissions: "full-access",
        status: "running",
        nativeSessionId: "fixture-session",
        nativeRunId: "fixture-run",
        workspacePath: canonicalProjectPath,
        output: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: null,
      });
      const appendDriverEvent = (type: string, payload: Record<string, unknown>) => daemon.store.appendEvent({
        type,
        workflowId: `chat:${projectChat.id}`,
        runId: `chat-run:${projectChat.id}`,
        agentId: streamingAgentId,
        occurredAt: new Date().toISOString(),
        payload: payload as never,
        provenance: { source: "driver", driver: "codex" },
      });
      appendDriverEvent("driver.message.delta", { text: "Hello" });
      appendDriverEvent("driver.message.delta", { text: " from Symphony" });
      let streamed = await fetch(`${base}/v1/threads/${projectChat.id}`).then((response) => response.json()) as {
        messages: Array<{ id: string; streaming: boolean; parts: Array<{ text?: string }> }>;
      };
      expect(streamed.messages).toHaveLength(1);
      expect(streamed.messages[0]).toMatchObject({ streaming: true, parts: [{ text: "Hello from Symphony" }] });
      const streamMessageId = streamed.messages[0]?.id;
      appendDriverEvent("driver.output.completed", { text: "Hello from Symphony." });
      streamed = await fetch(`${base}/v1/threads/${projectChat.id}`).then((response) => response.json()) as typeof streamed;
      expect(streamed.messages).toHaveLength(1);
      expect(streamed.messages[0]).toMatchObject({ id: streamMessageId, streaming: false, parts: [{ text: "Hello from Symphony." }] });

      const projectBootstrap = await fetch(`${base}/v1/bootstrap`).then((response) => response.json()) as {
        projects: Array<{ id: string }>;
      };
      expect(projectBootstrap.projects).toContainEqual(expect.objectContaining({ id: project.id }));

      const settings = await fetch(`${base}/v1/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conductor: { harness: "claude", model: "auto" },
          agents: { defaultPermissions: "read-only", maxDepth: 2, maxConcurrent: 4 },
        }),
      }).then((response) => response.json()) as {
        conductor: { harness: string; model: string };
        agents: { defaultPermissions: string; maxDepth: number | null; maxConcurrent: number | null };
      };
      expect(settings).toMatchObject({
        conductor: { harness: "claude", model: "auto" },
        agents: { defaultPermissions: "read-only", maxDepth: 2, maxConcurrent: 4 },
      });
      const unlimited = await fetch(`${base}/v1/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agents: { maxDepth: null, maxConcurrent: null } }),
      }).then((response) => response.json()) as {
        agents: { maxDepth: number | null; maxConcurrent: number | null };
      };
      expect(unlimited.agents).toMatchObject({ maxDepth: null, maxConcurrent: null });
      const persisted = JSON.parse(readFileSync(join(root, "symphony.config.json"), "utf8")) as {
        conductor: { harness: string };
        agents: { maxDepth: number | null; maxConcurrent: number | null };
      };
      expect(persisted.conductor.harness).toBe("claude");
      expect(persisted.agents).toMatchObject({ maxDepth: null, maxConcurrent: null });

      const chat = await fetch(`${base}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New chat" }),
      }).then((response) => response.json()) as { id: string };
      const sent = await fetch(`${base}/v1/threads/${chat.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messageId: "client-message-1",
          content: "Fix the thing",
          attachments: [{
            id: "attachment-1",
            name: "notes.md",
            type: "document",
            contentType: "text/markdown",
            content: [{ type: "text", text: "<attachment name=notes.md>\nUse the existing API.\n</attachment>" }],
          }],
        }),
      });
      expect(sent.status).toBe(202);
      const chatDetail = await fetch(`${base}/v1/threads/${chat.id}`).then((response) => response.json()) as {
        thread: { title: string };
        messages: Array<{ id: string; parts: Array<{ type?: string }> }>;
      };
      expect(chatDetail.thread.title).toBe("Fix the thing");
      expect(chatDetail.messages[0]).toMatchObject({
        id: "client-message-1",
        parts: [{ type: "text" }, { type: "attachment" }],
      });
    } finally {
      await daemon.close();
    }
  });
});
