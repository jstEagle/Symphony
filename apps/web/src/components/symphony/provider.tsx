"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentDetail,
  AgentObservation,
  BootstrapEnvelope,
  ChatAttachment,
  ConnectionState,
  ChatThreadRecord,
  ConversationMessage,
  ConversationSummary,
  EventEnvelope,
  ObservationLevel,
  RunSnapshot,
  RuntimeSettings,
} from "@/lib/symphony/contracts";
import { SymphonyContext, type SymphonyContextValue } from "@/components/symphony/context";
import { AgentLoader } from "@/components/symphony/agent-tool";
import {
  browseDirectories as browseDirectoriesRequest,
  cancelAgent as cancelAgentRequest,
  createProject as createProjectRequest,
  createThread,
  fetchBootstrap,
  fetchThread,
  observeAgent as observeAgentRequest,
  resolveMode,
  sendThreadMessage,
  steerAgent as steerAgentRequest,
  subscribeToRuntime,
  updateThread,
  updateNativeHarness,
  updateRuntimeSettings,
  type RuntimeMode,
} from "@/lib/symphony/runtime-client";
import { previewAgentDetail, previewDirectory, previewEnvelope, previewSnapshot } from "@/lib/symphony/preview";
import { emptyRunSnapshot, projectDirectory, projectInbox, snapshotForThread } from "@/lib/symphony/project";
import {
  readActiveConversationId,
  readInboxIds,
  readGroups,
  readPinnedIds,
  writeActiveConversationId,
  writePinnedIds,
  writeReadInboxIds,
  writeGroups,
} from "@/lib/symphony/ui-prefs";
import { symphonyConfig } from "@/symphony.config";

type ExtraGroup = { id: string; title: string };

export function SymphonyProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<RuntimeMode>(symphonyConfig.dataMode === "preview" ? "preview" : "runtime");
  const [connection, setConnection] = useState<ConnectionState>(
    symphonyConfig.dataMode === "preview" ? "preview" : "connecting",
  );
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => readPinnedIds());
  const [readInbox, setReadInbox] = useState<string[]>(() => readInboxIds());
  const [extraGroups, setExtraGroups] = useState<ExtraGroup[]>(() => readGroups());
  const [activeId, setActiveId] = useState<string | null>(() => readActiveConversationId());
  const [previewDir, setPreviewDir] = useState(previewDirectory);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [liveMessages, setLiveMessages] = useState<ConversationMessage[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<{ threadId: string; messages: BootstrapEnvelope["messages"] } | null>(null);
  const [pendingThreads, setPendingThreads] = useState<ChatThreadRecord[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const resolved = useRef(false);
  const subscriptionStart = useRef<{ epoch: string | null; cursor: number | string }>({ epoch: null, cursor: 0 });

  const modeQuery = useQuery({
    queryKey: ["symphony", "mode"],
    queryFn: ({ signal }) => resolveMode(symphonyConfig.dataMode, signal),
    staleTime: 3_000,
    refetchInterval: (query) =>
      symphonyConfig.dataMode === "auto" && query.state.data === "preview" ? 3_000 : false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!modeQuery.data) return;
    setMode(modeQuery.data);
    if (modeQuery.data === "preview") setConnection("preview");
    resolved.current = true;
  }, [modeQuery.data]);

  const bootstrapQuery = useQuery({
    queryKey: ["symphony", "bootstrap", mode],
    enabled: resolved.current || symphonyConfig.dataMode !== "auto",
    queryFn: ({ signal }) => fetchBootstrap(mode, signal),
    retry: mode === "runtime" ? 1 : 0,
    refetchInterval: settingsOpen && mode === "runtime" ? 5_000 : false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (settingsOpen && mode === "runtime") {
      void queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
    }
  }, [mode, queryClient, settingsOpen]);

  const envelope = bootstrapQuery.data ?? (mode === "preview" ? previewEnvelope() : undefined);

  const runtimeEpoch = envelope?.mode === "runtime" ? envelope.runtimeEpoch : null;
  if (runtimeEpoch && subscriptionStart.current.epoch !== runtimeEpoch) {
    subscriptionStart.current = { epoch: runtimeEpoch, cursor: envelope?.cursor ?? 0 };
  }

  useEffect(() => {
    if (!runtimeEpoch) return;
    const pendingMessages = new Map<string, ConversationMessage>();
    let messageFrame: number | null = null;

    const flushMessages = () => {
      messageFrame = null;
      if (pendingMessages.size === 0) return;
      const batch = [...pendingMessages.values()];
      pendingMessages.clear();
      setLiveMessages((current) => mergeMessages([], current, batch).slice(-500));
    };

    const queueMessage = (message: ConversationMessage) => {
      pendingMessages.set(message.id, message);
      messageFrame ??= window.requestAnimationFrame(flushMessages);
    };

    const unsubscribe = subscribeToRuntime(
      subscriptionStart.current.cursor,
      (event) => {
        const message = messageFromEvent(event);
        if (message) {
          queueMessage(message);
          return;
        }
        setEvents((current) => [...current.slice(-200), event]);
        void queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
      },
      () => {
        pendingMessages.clear();
        if (messageFrame !== null) window.cancelAnimationFrame(messageFrame);
        messageFrame = null;
        setEvents([]);
        setLiveMessages([]);
        queryClient.removeQueries({ queryKey: ["symphony"] });
        void queryClient.invalidateQueries({ queryKey: ["symphony"] });
      },
      setConnection,
    );
    return () => {
      unsubscribe();
      pendingMessages.clear();
      if (messageFrame !== null) window.cancelAnimationFrame(messageFrame);
    };
  }, [queryClient, runtimeEpoch]);

  useEffect(() => {
    setEvents([]);
    setLiveMessages([]);
  }, [runtimeEpoch]);

  const runtimeEvents = useMemo(
    () => mergeEvents(envelope?.events ?? [], events),
    [envelope?.events, events],
  );

  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const readSet = useMemo(() => new Set(readInbox), [readInbox]);

  const directory = useMemo(() => {
    if (!envelope) return previewDir;
    if (envelope.mode === "preview") return previewDir;
    const unread = new Set(
      projectInbox(envelope.threads, envelope.agents, runtimeEvents, readSet)
        .filter((item) => !item.read && item.conversationId)
        .map((item) => item.conversationId as string),
    );
    const threads = mergeThreads(envelope.threads, pendingThreads);
    const projectGroups = envelope.projects.map((project) => ({ id: project.id, title: project.title }));
    const projectIds = new Set(projectGroups.map((group) => group.id));
    return projectDirectory(
      threads,
      envelope.agents,
      [...projectGroups, ...extraGroups.filter((group) => !projectIds.has(group.id))],
      pinnedSet,
      activeId,
      unread,
    );
  }, [envelope, extraGroups, pinnedSet, activeId, previewDir, runtimeEvents, readSet, pendingThreads]);

  const activeConversation = useMemo(() => {
    const id = directory.activeConversationId;
    return directory.groups.flatMap((group) => group.conversations).find((item) => item.id === id);
  }, [directory]);

  const inbox = useMemo(() => {
    if (!envelope) return [];
    if (envelope.mode === "preview") {
      return envelope.inbox.map((item) => ({ ...item, read: readSet.has(item.id) ? true : item.read }));
    }
    return projectInbox(envelope.threads, envelope.agents, runtimeEvents, readSet);
  }, [envelope, runtimeEvents, readSet]);

  const snapshot = useMemo<RunSnapshot>(() => {
    if (!envelope) return previewSnapshot;
    if (envelope.mode === "preview") {
      return activeConversation?.id === "symphony-harness" ? previewSnapshot : emptyRunSnapshot("preview");
    }
    const thread =
      envelope.threads.find((item) => item.id === activeConversation?.id) ??
      pendingThreads.find((item) => item.id === activeConversation?.id);
    return snapshotForThread(thread, envelope, runtimeEvents);
  }, [envelope, activeConversation?.id, runtimeEvents, pendingThreads]);

  useEffect(() => {
    if (!envelope?.threads.length || pendingThreads.length === 0) return;
    const known = new Set(envelope.threads.map((thread) => thread.id));
    setPendingThreads((current) => current.filter((thread) => !known.has(thread.id)));
  }, [envelope?.threads, pendingThreads.length]);

  useEffect(() => {
    const known = new Set(directory.groups.flatMap((group) => group.conversations.map((item) => item.id)));
    if (activeId && known.has(activeId)) return;
    if (!directory.activeConversationId || directory.activeConversationId === activeId) return;
    setActiveId(directory.activeConversationId);
    writeActiveConversationId(directory.activeConversationId);
  }, [directory, activeId]);

  useEffect(() => {
    if (!envelope || envelope.mode !== "runtime" || !activeConversation) {
      setThreadMessages(null);
      return;
    }
    let cancelled = false;
    void fetchThread(activeConversation.id)
      .then((detail) => {
        if (!cancelled) setThreadMessages({ threadId: activeConversation.id, messages: detail.messages });
      })
      .catch(() => {
        if (!cancelled) {
          setThreadMessages({ threadId: activeConversation.id, messages: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeConversation?.id, envelope?.mode, runtimeEpoch]);

  const selectConversation = useCallback((id: string) => {
    setActiveId(id);
    writeActiveConversationId(id);
    setPreviewDir((current) => ({ ...current, activeConversationId: id }));
    setSelectedAgentId(null);
  }, []);

  const persistPinned = useCallback((ids: string[]) => {
    setPinnedIds(ids);
    writePinnedIds(ids);
  }, []);

  const createConversation = useCallback(
    async (input: { projectId?: string; groupId?: string; workspacePath?: string }) => {
      const folder = input.groupId?.trim() || input.projectId || "inbox";
      if (mode === "preview" || !envelope || envelope.mode === "preview") {
        const id = crypto.randomUUID();
        const conversation: ConversationSummary = {
          id,
          groupId: folder,
          title: "New chat",
          updatedLabel: "now",
          updatedAt: new Date().toISOString(),
          state: "idle",
          pinned: false,
        };
        setPreviewDir((current) => {
          const groups = current.groups.some((group) => group.id === folder)
            ? current.groups
            : [{ id: folder, title: folder === "inbox" ? "Inbox" : folder, conversations: [] }, ...current.groups];
          return {
            ...current,
            activeConversationId: id,
            groups: groups.map((group) =>
              group.id === folder ? { ...group, conversations: [conversation, ...group.conversations] } : group,
            ),
          };
        });
        setActiveId(id);
        writeActiveConversationId(id);
        return;
      }
      try {
        const thread = await createThread({
          title: "New chat",
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(!input.projectId ? { groupId: folder === "inbox" ? null : folder } : {}),
          ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
        });
        setActionError(null);
        setPendingThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
        setActiveId(thread.id);
        writeActiveConversationId(thread.id);
        persistPinned(pinnedIds);
        await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
      } catch (error) {
        setActionError(errorMessage(error));
        throw error;
      }
    },
    [envelope, mode, persistPinned, pinnedIds, queryClient],
  );

  const createProject = useCallback(async (input: { workspacePath: string; title?: string }) => {
    if (mode === "preview") {
      const now = new Date().toISOString();
      return {
        id: input.workspacePath,
        title: input.title?.trim() || input.workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) || input.workspacePath,
        workspacePath: input.workspacePath,
        isGitRepository: false,
        createdAt: now,
        updatedAt: now,
      };
    }
    try {
      const project = await createProjectRequest(input);
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
      return project;
    } catch (error) {
      setActionError(errorMessage(error));
      throw error;
    }
  }, [mode, queryClient]);

  const browseDirectories = useCallback(async (path?: string) => {
    try {
      const listing = await browseDirectoriesRequest(path);
      setActionError(null);
      return listing;
    } catch (error) {
      setActionError(errorMessage(error));
      throw error;
    }
  }, []);

  const createGroup = useCallback((title: string) => {
    const id = title.trim();
    if (!id) return;
    if (mode === "preview") {
      setPreviewDir((current) => ({
        ...current,
        groups: current.groups.some((group) => group.id === id)
          ? current.groups
          : [...current.groups, { id, title, conversations: [] }],
      }));
      return;
    }
    setExtraGroups((current) => {
      const next = current.some((group) => group.id === id) ? current : [...current, { id, title }];
      writeGroups(next);
      return next;
    });
  }, [mode]);

  const moveConversation = useCallback(
    async (conversationId: string, groupId: string) => {
      if (mode === "preview") {
        setPreviewDir((current) => {
          const conversation = current.groups.flatMap((group) => group.conversations).find((item) => item.id === conversationId);
          if (!conversation || conversation.groupId === groupId) return current;
          return {
            ...current,
            groups: current.groups.map((group) => {
              if (group.id === conversation.groupId) {
                return { ...group, conversations: group.conversations.filter((item) => item.id !== conversationId) };
              }
              if (group.id === groupId) {
                return { ...group, conversations: [{ ...conversation, groupId }, ...group.conversations] };
              }
              return group;
            }),
          };
        });
        return;
      }
      try {
        await updateThread(conversationId, { groupId: groupId === "inbox" ? null : groupId });
        setActionError(null);
        await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [mode, queryClient],
  );

  const togglePinned = useCallback(
    (conversationId: string) => {
      const next = pinnedSet.has(conversationId)
        ? pinnedIds.filter((id) => id !== conversationId)
        : [...pinnedIds, conversationId];
      persistPinned(next);
      if (mode === "preview") {
        setPreviewDir((current) => ({
          ...current,
          groups: current.groups.map((group) => ({
            ...group,
            conversations: group.conversations.map((conversation) =>
              conversation.id === conversationId ? { ...conversation, pinned: !conversation.pinned } : conversation,
            ),
          })),
        }));
      }
    },
    [mode, persistPinned, pinnedIds, pinnedSet],
  );

  const renameConversation = useCallback(
    async (conversationId: string, title: string) => {
      if (mode === "preview") {
        setPreviewDir((current) => ({
          ...current,
          groups: current.groups.map((group) => ({
            ...group,
            conversations: group.conversations.map((conversation) =>
              conversation.id === conversationId ? { ...conversation, title } : conversation,
            ),
          })),
        }));
        return;
      }
      try {
        await updateThread(conversationId, { title });
        setActionError(null);
        await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [mode, queryClient],
  );

  const archiveConversation = useCallback(
    async (conversationId: string) => {
      if (mode === "preview") {
        setPreviewDir((current) => ({
          ...current,
          groups: current.groups.map((group) => ({
            ...group,
            conversations: group.conversations.filter((conversation) => conversation.id !== conversationId),
          })),
        }));
        return;
      }
      try {
        await updateThread(conversationId, { archived: true });
        setActionError(null);
        await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [mode, queryClient],
  );

  const sendMessage = useCallback(
    async (threadId: string, input: { messageId: string; content: string; attachments: ChatAttachment[] }) => {
      if (mode === "runtime" && envelope?.mode === "runtime") {
        setActionError(null);
        try {
          await sendThreadMessage(threadId, input);
          await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
        } catch (error) {
          setActionError(errorMessage(error));
          throw error;
        }
      }
    },
    [envelope?.mode, mode, queryClient],
  );

  const saveSettings = useCallback(async (patch: Partial<Pick<RuntimeSettings, "conductor" | "agents">>) => {
    if (mode === "preview") return;
    setActionError(null);
    try {
      await updateRuntimeSettings(patch);
      await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
    } catch (error) {
      setActionError(errorMessage(error));
      throw error;
    }
  }, [mode, queryClient]);

  const updateHarness = useCallback(async (driver: string) => {
    if (mode === "preview") return;
    setActionError(null);
    try {
      await updateNativeHarness(driver);
      await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
    } catch (error) {
      setActionError(errorMessage(error));
      throw error;
    }
  }, [mode, queryClient]);

  const cancelRun = useCallback(async () => {
    const conductorId = activeConversation?.conductorAgentId ?? snapshot.agents.find((agent) => agent.depth === 0)?.id;
    if (!conductorId || mode === "preview") return;
    try {
      await cancelAgentRequest(conductorId);
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [activeConversation?.conductorAgentId, mode, queryClient, snapshot.agents]);

  const observe = useCallback(
    async (agentId: string, level: ObservationLevel): Promise<AgentObservation> => {
      if (mode === "preview") {
        const detail = previewAgentDetail(agentId);
        const existing = detail?.observations[level];
        if (existing) return existing;
        return {
          level,
          summary: detail?.objective ?? "No observation is available in this preview.",
          generatedBy: "deterministic",
          model: null,
        };
      }
      const result = await observeAgentRequest(agentId, level);
      if (result && typeof result === "object" && "summary" in result && typeof result.summary === "string") {
        return {
          level,
          summary: result.summary,
          generatedBy: "generatedBy" in result && result.generatedBy === "model" ? "model" : "deterministic",
          model: "model" in result && typeof result.model === "string" ? result.model : null,
        };
      }
      return { level, summary: JSON.stringify(result), generatedBy: "deterministic", model: null };
    },
    [mode],
  );

  const steer = useCallback(
    async (agentId: string, content: string) => {
      if (mode === "preview") return;
      await steerAgentRequest(agentId, content);
      await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
    },
    [mode, queryClient],
  );

  const cancelOne = useCallback(
    async (agentId: string) => {
      if (mode === "preview") return;
      await cancelAgentRequest(agentId);
      await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
    },
    [mode, queryClient],
  );

  const agentDetail = useCallback(
    (id: string): AgentDetail | null => {
      if (mode === "preview") return previewAgentDetail(id);
      const agent = snapshot.agents.find((item) => item.id === id);
      if (!agent) return null;
      return {
        ...agent,
        parent: snapshot.agents.find((item) => item.id === agent.parentId),
        children: snapshot.agents.filter((item) => item.parentId === agent.id),
        observations: {},
        files: [],
        artifacts: [],
      };
    },
    [mode, snapshot.agents],
  );

  const markInboxRead = useCallback((id: string) => {
    setReadInbox((current) => {
      const next = current.includes(id) ? current : [...current, id];
      writeReadInboxIds(next);
      return next;
    });
  }, []);

  const loadThreadMessages = useCallback(async (threadId: string) => {
    if (mode === "preview") return [];
    const detail = await fetchThread(threadId);
    setThreadMessages({ threadId, messages: detail.messages });
    return detail.messages;
  }, [mode]);

  const value = useMemo<SymphonyContextValue | null>(() => {
    if (!envelope) return null;
    const activeMessages = activeConversation
      ? mergeMessages(
          envelope.messages.filter((message) => message.threadId === activeConversation.id),
          threadMessages?.threadId === activeConversation.id ? threadMessages.messages : [],
          liveMessages.filter((message) => message.threadId === activeConversation.id),
        )
      : [];
    return {
      ready: true,
      error: actionError ?? (bootstrapQuery.error instanceof Error ? bootstrapQuery.error.message : null),
      clearError: () => setActionError(null),
      mode: envelope.mode,
      connection: envelope.mode === "preview" ? "preview" : connection,
      envelope: { ...envelope, messages: activeMessages },
      runtimeEvents,
      projects: envelope.projects,
      directory,
      activeConversation,
      snapshot,
      inbox,
      unreadInbox: inbox.filter((item) => !item.read).length,
      settingsOpen,
      usageOpen,
      inboxOpen,
      selectedAgentId,
      setSettingsOpen,
      setUsageOpen,
      setInboxOpen,
      selectConversation,
      createConversation,
      createProject,
      browseDirectories,
      createGroup,
      moveConversation,
      togglePinned,
      renameConversation,
      archiveConversation,
      sendMessage,
      saveSettings,
      updateHarness,
      cancelRun,
      openAgent: setSelectedAgentId,
      agentDetail,
      observe,
      steer,
      cancelOne,
      markInboxRead,
      loadThreadMessages,
    };
  }, [
    activeConversation,
    actionError,
    agentDetail,
    archiveConversation,
    bootstrapQuery.error,
    cancelOne,
    cancelRun,
    connection,
    createProject,
    browseDirectories,
    createConversation,
    createGroup,
    directory,
    envelope,
    inbox,
    inboxOpen,
    loadThreadMessages,
    liveMessages,
    markInboxRead,
    moveConversation,
    observe,
    renameConversation,
    runtimeEvents,
    saveSettings,
    updateHarness,
    selectConversation,
    selectedAgentId,
    sendMessage,
    settingsOpen,
    snapshot,
    steer,
    threadMessages,
    togglePinned,
    usageOpen,
  ]);

  if (!value) {
    return (
      <div className="grid h-dvh place-items-center bg-background text-sm text-muted-foreground">
        {bootstrapQuery.isError && mode === "runtime" ? (
          "Symphony runtime unavailable"
        ) : (
          <div className="flex items-center gap-2">
            <AgentLoader kind="circular" size={18} label="Loading Symphony" />
            <span>Loading Symphony…</span>
          </div>
        )}
      </div>
    );
  }

  return <SymphonyContext.Provider value={value}>{children}</SymphonyContext.Provider>;
}

function mergeThreads(threads: ChatThreadRecord[], pending: ChatThreadRecord[]): ChatThreadRecord[] {
  if (pending.length === 0) return threads;
  const known = new Set(threads.map((thread) => thread.id));
  return [...pending.filter((thread) => !known.has(thread.id)), ...threads];
}

function mergeEvents(snapshot: EventEnvelope[], streamed: EventEnvelope[]): EventEnvelope[] {
  const byId = new Map<string, EventEnvelope>();
  for (const event of [...snapshot, ...streamed]) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.cursor - b.cursor).slice(-500);
}

function mergeMessages(
  snapshot: BootstrapEnvelope["messages"],
  completeThread: BootstrapEnvelope["messages"],
  streamed: BootstrapEnvelope["messages"] = [],
): BootstrapEnvelope["messages"] {
  const byId = new Map<string, BootstrapEnvelope["messages"][number]>();
  for (const message of [...completeThread, ...snapshot, ...streamed]) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function messageFromEvent(event: EventEnvelope): ConversationMessage | null {
  if (event.type !== "chat.message.updated" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return null;
  }
  const message = (event.payload as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const candidate = message as Partial<ConversationMessage>;
  if (
    typeof candidate.id !== "string"
    || typeof candidate.threadId !== "string"
    || !["user", "assistant", "system", "tool"].includes(candidate.role ?? "")
    || !Array.isArray(candidate.parts)
    || typeof candidate.createdAt !== "string"
  ) return null;
  return candidate as ConversationMessage;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
