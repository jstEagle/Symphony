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
import {
  SymphonyContext,
  SymphonyMessagesContext,
  type SymphonyContextValue,
} from "@/components/symphony/context";
import { AgentLoader } from "@/components/symphony/agent-tool";
import {
  browseDirectories as browseDirectoriesRequest,
  authenticateNativeHarness,
  cancelAgent as cancelAgentRequest,
  createProject as createProjectRequest,
  createThread,
  fetchBootstrap,
  fetchRuntimeCatalog,
  fetchThread,
  fetchAgentMessages,
  fetchAgentLogs,
  fetchRunEvents,
  observeAgent as observeAgentRequest,
  resolveMode,
  sendThreadMessage,
  isRetryableRuntimeRequestError,
  steerAgent as steerAgentRequest,
  subscribeToRuntime,
  updateThread,
  updateNativeHarness,
  updateRuntimeSettings,
  type RuntimeMode,
} from "@/lib/symphony/runtime-client";
import {
  CHAT_OUTBOX_STORAGE_KEY,
  createPendingChatSend,
  deletePendingChatSend,
  markPendingChatSendAttempt,
  pendingChatSendToConversationMessage,
  putPendingChatSend,
  readPendingChatSends,
  reconcilePendingChatSend,
  removePendingChatSend,
  writePendingChatSend,
  type PendingChatSend,
} from "@/lib/symphony/chat-outbox";
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
import {
  mergeConversationMessageBatch,
  normalizeConversationMessage,
} from "@/lib/symphony/messages";
import {
  THREAD_CREATE_OUTBOX_STORAGE_KEY,
  createPendingThreadCreate,
  deletePendingThreadCreate,
  markPendingThreadCreateAttempt,
  readPendingThreadCreates,
  reconcilePendingThreadCreate,
  writePendingThreadCreate,
} from "@/lib/symphony/thread-outbox";
import {
  DRIVER_UPDATE_OUTBOX_STORAGE_KEY,
  deletePendingDriverUpdate,
  ensurePendingDriverUpdate,
  markPendingDriverUpdateAttempt,
  readPendingDriverUpdates,
  reconcilePendingDriverUpdate,
  writePendingDriverUpdate,
} from "@/lib/symphony/driver-update-outbox";
import {
  DRIVER_AUTHENTICATION_OUTBOX_STORAGE_KEY,
  deletePendingDriverAuthentication,
  ensurePendingDriverAuthentication,
  markPendingDriverAuthenticationAttempt,
  readPendingDriverAuthentications,
  reconcilePendingDriverAuthentication,
  writePendingDriverAuthentication,
} from "@/lib/symphony/driver-authentication-outbox";

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
  const [pendingChatSends, setPendingChatSends] = useState<PendingChatSend[]>(() => readPendingChatSends());
  const [optimisticallyArchived, setOptimisticallyArchived] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [modeResolved, setModeResolved] = useState(symphonyConfig.dataMode !== "auto");
  const subscriptionStart = useRef<{ epoch: string | null; cursor: number | string }>({ epoch: null, cursor: 0 });
  const pendingChatSendsRef = useRef(pendingChatSends);
  const pendingChatReconciliation = useRef(new Set<string>());
  const pendingThreadCreateReconciliation = useRef(new Set<string>());
  const pendingDriverUpdateReconciliation = useRef(new Set<string>());
  const pendingDriverAuthenticationReconciliation = useRef(new Set<string>());

  const updatePendingChatSends = useCallback((update: (current: PendingChatSend[]) => PendingChatSend[]) => {
    const previous = pendingChatSendsRef.current;
    const next = update(previous);
    const nextById = new Map(next.map((entry) => [entry.messageId, entry]));
    for (const entry of next) writePendingChatSend(entry);
    for (const entry of previous) if (!nextById.has(entry.messageId)) deletePendingChatSend(entry.messageId);
    pendingChatSendsRef.current = next;
    setPendingChatSends(next);
  }, []);

  useEffect(() => {
    const syncOutbox = (event: StorageEvent) => {
      if (!event.key?.startsWith(CHAT_OUTBOX_STORAGE_KEY)) return;
      const next = readPendingChatSends();
      pendingChatSendsRef.current = next;
      setPendingChatSends(next);
    };
    window.addEventListener("storage", syncOutbox);
    return () => window.removeEventListener("storage", syncOutbox);
  }, []);

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
    setModeResolved(true);
  }, [modeQuery.data]);

  const bootstrapQuery = useQuery({
    queryKey: ["symphony", "bootstrap", mode],
    enabled: modeResolved,
    queryFn: ({ signal }) => fetchBootstrap(mode, signal),
    retry: mode === "runtime" ? 1 : 0,
    refetchOnWindowFocus: true,
  });

  const catalogQuery = useQuery({
    queryKey: ["symphony", "catalog", mode],
    enabled: mode === "runtime" && Boolean(bootstrapQuery.data),
    queryFn: ({ signal }) => fetchRuntimeCatalog(signal),
    staleTime: 10_000,
    refetchInterval: settingsOpen && mode === "runtime" ? 5_000 : false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (settingsOpen && mode === "runtime") {
      void queryClient.invalidateQueries({ queryKey: ["symphony", "catalog"] });
    }
  }, [mode, queryClient, settingsOpen]);

  const envelope = useMemo(() => {
    const base = bootstrapQuery.data ?? (mode === "preview" ? previewEnvelope() : undefined);
    if (!base || base.mode === "preview" || !catalogQuery.data) return base;
    return {
      ...base,
      drivers: catalogQuery.data.drivers,
      models: catalogQuery.data.models,
    };
  }, [bootstrapQuery.data, catalogQuery.data, mode]);

  const runtimeEpoch = envelope?.mode === "runtime" ? envelope.runtimeEpoch : null;
  if (runtimeEpoch && subscriptionStart.current.epoch !== runtimeEpoch) {
    subscriptionStart.current = { epoch: runtimeEpoch, cursor: envelope?.cursor ?? 0 };
  }

  useEffect(() => {
    if (!runtimeEpoch) return;
    const pendingMessages = new Map<string, ConversationMessage>();
    const pendingEvents = new Map<string, EventEnvelope>();
    let messageFrame: number | null = null;
    let eventFrame: number | null = null;
    let bootstrapRefresh: number | null = null;

    const flushMessages = () => {
      messageFrame = null;
      if (pendingMessages.size === 0) return;
      const batch = [...pendingMessages.values()];
      pendingMessages.clear();
      setLiveMessages((current) => mergeConversationMessageBatch(current, batch).slice(-500));
    };

    const queueMessage = (message: ConversationMessage) => {
      pendingMessages.set(message.id, message);
      messageFrame ??= window.requestAnimationFrame(flushMessages);
    };

    const flushEvents = () => {
      eventFrame = null;
      if (pendingEvents.size === 0) return;
      const batch = [...pendingEvents.values()];
      pendingEvents.clear();
      setEvents((current) => mergeEvents(current, batch).slice(-200));
    };

    const queueEvent = (event: EventEnvelope) => {
      pendingEvents.set(event.id, event);
      eventFrame ??= window.requestAnimationFrame(flushEvents);
    };

    const queueBootstrapRefresh = () => {
      if (bootstrapRefresh !== null) return;
      bootstrapRefresh = window.setTimeout(() => {
        bootstrapRefresh = null;
        void queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
        void queryClient.invalidateQueries({ queryKey: ["symphony", "run-events"] });
      }, 180);
    };

    const unsubscribe = subscribeToRuntime(
      subscriptionStart.current.cursor,
      (event) => {
        const message = messageFromEvent(event);
        if (message) {
          queueMessage(message);
          return;
        }
        queueEvent(event);
        if (event.type === "driver.authenticated" || event.type === "driver.authentication.failed") {
          void queryClient.invalidateQueries({ queryKey: ["symphony", "catalog"] });
        }
        if (eventRequiresBootstrapRefresh(event.type)) queueBootstrapRefresh();
      },
      () => {
        pendingMessages.clear();
        pendingEvents.clear();
        if (messageFrame !== null) window.cancelAnimationFrame(messageFrame);
        messageFrame = null;
        if (eventFrame !== null) window.cancelAnimationFrame(eventFrame);
        eventFrame = null;
        if (bootstrapRefresh !== null) window.clearTimeout(bootstrapRefresh);
        bootstrapRefresh = null;
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
      pendingEvents.clear();
      if (messageFrame !== null) window.cancelAnimationFrame(messageFrame);
      if (eventFrame !== null) window.cancelAnimationFrame(eventFrame);
      if (bootstrapRefresh !== null) window.clearTimeout(bootstrapRefresh);
    };
  }, [queryClient, runtimeEpoch]);

  useEffect(() => {
    setEvents([]);
    setLiveMessages([]);
  }, [runtimeEpoch]);

  useEffect(() => {
    if (mode !== "runtime" || envelope?.mode !== "runtime" || connection !== "live") return;
    const pending = pendingChatSendsRef.current;
    for (const entry of pending) {
      const reconciliationKey = `${runtimeEpoch ?? "runtime"}:${entry.messageId}`;
      if (pendingChatReconciliation.current.has(reconciliationKey)) continue;
      pendingChatReconciliation.current.add(reconciliationKey);
      void reconcilePendingChatSend(entry, {
        fetchThread: async (threadId) => {
          const detail = await fetchThread(threadId);
          return { messages: detail.messages };
        },
        send: sendThreadMessage,
        isRetryableError: isRetryableRuntimeRequestError,
      }).then((result) => {
        if (result.status === "acknowledged") {
          updatePendingChatSends((current) => removePendingChatSend(current, entry.messageId));
          setActionError(null);
          void queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
          return;
        }
        if (result.status === "rejected") {
          updatePendingChatSends((current) => removePendingChatSend(current, entry.messageId));
          setActionError(errorMessage(result.error));
          return;
        }
        updatePendingChatSends((current) => markPendingChatSendAttempt(current, entry.messageId, result.error));
      }).finally(() => {
        pendingChatReconciliation.current.delete(reconciliationKey);
      });
    }
  }, [connection, envelope?.mode, mode, queryClient, runtimeEpoch, updatePendingChatSends]);

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
    const hidden = new Set(optimisticallyArchived);
    const threads = mergeThreads(envelope.threads, pendingThreads).filter((thread) => !hidden.has(thread.id));
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
  }, [envelope, extraGroups, pinnedSet, activeId, previewDir, runtimeEvents, readSet, pendingThreads, optimisticallyArchived]);

  const activeConversation = useMemo(() => {
    const id = directory.activeConversationId;
    return directory.groups.flatMap((group) => group.conversations).find((item) => item.id === id);
  }, [directory]);

  const activeRunId = useMemo(() => {
    if (!envelope || envelope.mode !== "runtime" || !activeConversation) return null;
    return envelope.runs.find((item) => item.id === `chat-run:${activeConversation.id}`)?.id
      ?? envelope.runs.find((item) => item.workflowId === `chat:${activeConversation.id}`)?.id
      ?? `chat-run:${activeConversation.id}`;
  }, [activeConversation, envelope]);

  const runEventsQuery = useQuery({
    queryKey: ["symphony", "run-events", activeRunId],
    enabled: mode === "runtime" && activeRunId !== null,
    queryFn: ({ signal }) => fetchRunEvents(activeRunId as string, signal),
    staleTime: 1_000,
    refetchOnWindowFocus: true,
  });

  const inbox = useMemo(() => {
    if (!envelope) return [];
    if (envelope.mode === "preview") {
      return envelope.inbox.map((item) => ({ ...item, read: readSet.has(item.id) ? true : item.read }));
    }
    return projectInbox(envelope.threads, envelope.agents, runtimeEvents, readSet);
  }, [envelope, runtimeEvents, readSet]);

  const projectedEvents = useMemo(
    () => mergeEvents(runtimeEvents, runEventsQuery.data ?? []),
    [runEventsQuery.data, runtimeEvents],
  );

  const snapshot = useMemo<RunSnapshot>(() => {
    if (!envelope) return previewSnapshot;
    if (envelope.mode === "preview") {
      return activeConversation?.id === "symphony-harness" ? previewSnapshot : emptyRunSnapshot("preview");
    }
    const thread =
      envelope.threads.find((item) => item.id === activeConversation?.id) ??
      pendingThreads.find((item) => item.id === activeConversation?.id);
    return snapshotForThread(thread, envelope, projectedEvents);
  }, [envelope, activeConversation?.id, projectedEvents, pendingThreads]);

  useEffect(() => {
    if (!envelope?.threads.length || pendingThreads.length === 0) return;
    const known = new Set(envelope.threads.map((thread) => thread.id));
    setPendingThreads((current) => current.filter((thread) => !known.has(thread.id)));
  }, [envelope?.threads, pendingThreads.length]);

  useEffect(() => {
    if (!envelope) return;
    const known = new Set(directory.groups.flatMap((group) => group.conversations.map((item) => item.id)));
    if (activeId && known.has(activeId)) return;
    if (!directory.activeConversationId || directory.activeConversationId === activeId) return;
    setActiveId(directory.activeConversationId);
    writeActiveConversationId(directory.activeConversationId);
  }, [directory, activeId, envelope]);

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

  const reconcileThreadCreateOutbox = useCallback(async () => {
    if (mode !== "runtime" || envelope?.mode !== "runtime") return;
    for (const pending of readPendingThreadCreates()) {
      if (pendingThreadCreateReconciliation.current.has(pending.idempotencyKey)) continue;
      pendingThreadCreateReconciliation.current.add(pending.idempotencyKey);
      try {
        const result = await reconcilePendingThreadCreate(pending, {
          create: createThread,
          isRetryableError: isRetryableRuntimeRequestError,
        });
        if (result.status === "acknowledged") {
          deletePendingThreadCreate(pending.idempotencyKey);
          setPendingThreads((current) => [
            result.thread,
            ...current.filter((thread) => thread.id !== result.thread.id),
          ]);
          await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
        } else if (result.status === "retry") {
          writePendingThreadCreate(markPendingThreadCreateAttempt(pending, result.error));
        } else {
          deletePendingThreadCreate(pending.idempotencyKey);
          setActionError(errorMessage(result.error));
        }
      } finally {
        pendingThreadCreateReconciliation.current.delete(pending.idempotencyKey);
      }
    }
  }, [envelope?.mode, mode, queryClient]);

  useEffect(() => {
    void reconcileThreadCreateOutbox();
  }, [reconcileThreadCreateOutbox, runtimeEpoch]);

  useEffect(() => {
    const syncThreadCreateOutbox = (event: StorageEvent) => {
      if (!event.key?.startsWith(THREAD_CREATE_OUTBOX_STORAGE_KEY)) return;
      void reconcileThreadCreateOutbox();
    };
    window.addEventListener("storage", syncThreadCreateOutbox);
    return () => window.removeEventListener("storage", syncThreadCreateOutbox);
  }, [reconcileThreadCreateOutbox]);

  const reconcileDriverUpdateOutbox = useCallback(async () => {
    if (mode !== "runtime" || envelope?.mode !== "runtime") return;
    for (const pending of readPendingDriverUpdates()) {
      if (pendingDriverUpdateReconciliation.current.has(pending.idempotencyKey)) continue;
      pendingDriverUpdateReconciliation.current.add(pending.idempotencyKey);
      try {
        const result = await reconcilePendingDriverUpdate(pending, {
          update: updateNativeHarness,
          isRetryableError: isRetryableRuntimeRequestError,
        });
        if (result.status === "acknowledged") {
          deletePendingDriverUpdate(pending);
          setActionError(null);
          await queryClient.invalidateQueries({ queryKey: ["symphony", "catalog"] });
        } else if (result.status === "retry") {
          writePendingDriverUpdate(markPendingDriverUpdateAttempt(pending, result.error));
        } else {
          deletePendingDriverUpdate(pending);
          setActionError(errorMessage(result.error));
        }
      } finally {
        pendingDriverUpdateReconciliation.current.delete(pending.idempotencyKey);
      }
    }
  }, [envelope?.mode, mode, queryClient]);

  useEffect(() => {
    void reconcileDriverUpdateOutbox();
  }, [reconcileDriverUpdateOutbox, runtimeEpoch]);

  useEffect(() => {
    const syncDriverUpdateOutbox = (event: StorageEvent) => {
      if (!event.key?.startsWith(DRIVER_UPDATE_OUTBOX_STORAGE_KEY)) return;
      void reconcileDriverUpdateOutbox();
    };
    window.addEventListener("storage", syncDriverUpdateOutbox);
    return () => window.removeEventListener("storage", syncDriverUpdateOutbox);
  }, [reconcileDriverUpdateOutbox]);

  const reconcileDriverAuthenticationOutbox = useCallback(async () => {
    if (mode !== "runtime" || envelope?.mode !== "runtime") return;
    for (const pending of readPendingDriverAuthentications()) {
      if (pendingDriverAuthenticationReconciliation.current.has(pending.idempotencyKey)) continue;
      pendingDriverAuthenticationReconciliation.current.add(pending.idempotencyKey);
      try {
        const result = await reconcilePendingDriverAuthentication(pending, {
          authenticate: authenticateNativeHarness,
          isRetryableError: isRetryableRuntimeRequestError,
        });
        if (result.status === "acknowledged") {
          deletePendingDriverAuthentication(pending);
          setActionError(null);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["symphony", "catalog"] }),
            queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] }),
          ]);
        } else if (result.status === "retry") {
          writePendingDriverAuthentication(markPendingDriverAuthenticationAttempt(pending, result.error));
        } else {
          deletePendingDriverAuthentication(pending);
          setActionError(errorMessage(result.error));
        }
      } finally {
        pendingDriverAuthenticationReconciliation.current.delete(pending.idempotencyKey);
      }
    }
  }, [envelope?.mode, mode, queryClient]);

  useEffect(() => {
    void reconcileDriverAuthenticationOutbox();
  }, [reconcileDriverAuthenticationOutbox, runtimeEpoch]);

  useEffect(() => {
    const syncDriverAuthenticationOutbox = (event: StorageEvent) => {
      if (!event.key?.startsWith(DRIVER_AUTHENTICATION_OUTBOX_STORAGE_KEY)) return;
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["symphony", "catalog"] }),
        queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] }),
      ]);
      void reconcileDriverAuthenticationOutbox();
    };
    window.addEventListener("storage", syncDriverAuthenticationOutbox);
    return () => window.removeEventListener("storage", syncDriverAuthenticationOutbox);
  }, [queryClient, reconcileDriverAuthenticationOutbox]);

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
        const pending = createPendingThreadCreate({
          title: "New chat",
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(!input.projectId ? { groupId: folder === "inbox" ? null : folder } : {}),
          ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
        });
        writePendingThreadCreate(pending);
        const result = await reconcilePendingThreadCreate(pending, {
          create: createThread,
          isRetryableError: isRetryableRuntimeRequestError,
        });
        if (result.status !== "acknowledged") {
          if (result.status === "retry") {
            writePendingThreadCreate(markPendingThreadCreateAttempt(pending, result.error));
          } else {
            deletePendingThreadCreate(pending.idempotencyKey);
          }
          throw result.error;
        }
        deletePendingThreadCreate(pending.idempotencyKey);
        const thread = result.thread;
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
      setOptimisticallyArchived((current) => current.includes(conversationId) ? current : [...current, conversationId]);
      try {
        await updateThread(conversationId, { archived: true });
        setActionError(null);
        await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
        setOptimisticallyArchived((current) => current.filter((id) => id !== conversationId));
      } catch (error) {
        setOptimisticallyArchived((current) => current.filter((id) => id !== conversationId));
        setActionError(errorMessage(error));
      }
    },
    [mode, queryClient],
  );

  const sendMessage = useCallback(
    async (threadId: string, input: { messageId: string; content: string; attachments: ChatAttachment[] }) => {
      if (mode === "runtime" && envelope?.mode === "runtime") {
        const pending = createPendingChatSend({ threadId, ...input });
        updatePendingChatSends((current) => putPendingChatSend(current, pending));
        setActionError(null);
        try {
          const receipt = await sendThreadMessage(threadId, input);
          if (receipt.messageId !== input.messageId) {
            throw new Error(`The daemon acknowledged ${receipt.messageId} instead of ${input.messageId}.`);
          }
          updatePendingChatSends((current) => removePendingChatSend(current, input.messageId));
          await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
        } catch (error) {
          updatePendingChatSends((current) => isRetryableRuntimeRequestError(error)
            ? markPendingChatSendAttempt(current, input.messageId, error)
            : removePendingChatSend(current, input.messageId));
          setActionError(errorMessage(error));
          throw error;
        }
      }
    },
    [envelope?.mode, mode, queryClient, updatePendingChatSends],
  );

  const saveSettings = useCallback(async (patch: Partial<Pick<RuntimeSettings, "conductor" | "agents" | "uiUtilities">>) => {
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
    const pending = ensurePendingDriverUpdate(driver);
    const result = await reconcilePendingDriverUpdate(pending, {
      update: updateNativeHarness,
      isRetryableError: isRetryableRuntimeRequestError,
    });
    if (result.status === "acknowledged") {
      deletePendingDriverUpdate(pending);
      await queryClient.invalidateQueries({ queryKey: ["symphony", "catalog"] });
      return;
    }
    if (result.status === "retry") {
      writePendingDriverUpdate(markPendingDriverUpdateAttempt(pending, result.error));
    } else {
      deletePendingDriverUpdate(pending);
    }
    setActionError(errorMessage(result.error));
    throw result.error;
  }, [mode, queryClient]);

  const authenticateHarness = useCallback(async (driver: string) => {
    if (mode === "preview") throw new Error("Native authentication is unavailable in preview mode.");
    setActionError(null);
    const pending = ensurePendingDriverAuthentication(driver);
    const reconciliation = await reconcilePendingDriverAuthentication(pending, {
      authenticate: authenticateNativeHarness,
      isRetryableError: isRetryableRuntimeRequestError,
    });
    if (reconciliation.status === "acknowledged") {
      deletePendingDriverAuthentication(pending);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["symphony", "catalog"] }),
        queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] }),
      ]);
      return reconciliation.result;
    }
    if (reconciliation.status === "retry") {
      writePendingDriverAuthentication(markPendingDriverAuthenticationAttempt(pending, reconciliation.error));
    } else {
      deletePendingDriverAuthentication(pending);
    }
    setActionError(errorMessage(reconciliation.error));
    throw reconciliation.error;
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

  const loadAgentMessages = useCallback(async (agentId: string) => {
    if (mode === "preview") {
      const detail = previewAgentDetail(agentId);
      if (!detail) return [];
      return [{
        id: `agent:${agentId}:objective`,
        threadId: `agent:${agentId}`,
        role: "user" as const,
        parts: [{ type: "text", text: detail.objective }],
        createdAt: detail.startedAt ?? new Date().toISOString(),
      }];
    }
    return (await fetchAgentMessages(agentId)).messages;
  }, [mode]);

  const loadAgentLogs = useCallback(async (agentId: string, after = 0) => {
    if (mode === "preview") {
      const detail = previewAgentDetail(agentId);
      if (!detail) throw new Error(`Agent not found: ${agentId}`);
      return {
        agent: {
          id: detail.id,
          status: detail.nativeStatus ?? "idle" as const,
          harness: detail.harness,
          model: detail.model,
          nativeSessionId: detail.nativeSessionId ?? null,
          nativeRunId: detail.nativeRunId ?? null,
          workspacePath: detail.workspacePath ?? "",
          error: detail.error ?? null,
        },
        cursor: 0,
        entries: [],
      };
    }
    return fetchAgentLogs(agentId, after);
  }, [mode]);

  const activeMessages = useMemo(() => {
    if (!envelope || !activeConversation) return [];
    return mergeMessages(
      envelope.messages.filter((message) => message.threadId === activeConversation.id),
      threadMessages?.threadId === activeConversation.id ? threadMessages.messages : [],
      [
        ...liveMessages.filter((message) => message.threadId === activeConversation.id),
        ...pendingChatSends
          .filter((pending) => pending.threadId === activeConversation.id)
          .map(pendingChatSendToConversationMessage),
      ],
    );
  }, [activeConversation, envelope, liveMessages, pendingChatSends, threadMessages]);

  const value = useMemo<SymphonyContextValue | null>(() => {
    if (!envelope) return null;
    return {
      ready: true,
      error: actionError ?? (bootstrapQuery.error instanceof Error ? bootstrapQuery.error.message : null),
      clearError: () => setActionError(null),
      mode: envelope.mode,
      connection: envelope.mode === "preview" ? "preview" : connection,
      envelope,
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
      authenticateHarness,
      cancelRun,
      openAgent: setSelectedAgentId,
      agentDetail,
      observe,
      steer,
      cancelOne,
      loadAgentMessages,
      loadAgentLogs,
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
    loadAgentMessages,
    loadAgentLogs,
    markInboxRead,
    moveConversation,
    observe,
    renameConversation,
    runtimeEvents,
    saveSettings,
    updateHarness,
    authenticateHarness,
    selectConversation,
    selectedAgentId,
    sendMessage,
    settingsOpen,
    snapshot,
    steer,
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

  return (
    <SymphonyContext.Provider value={value}>
      <SymphonyMessagesContext.Provider value={activeMessages}>
        {children}
      </SymphonyMessagesContext.Provider>
    </SymphonyContext.Provider>
  );
}

function mergeThreads(threads: ChatThreadRecord[], pending: ChatThreadRecord[]): ChatThreadRecord[] {
  if (pending.length === 0) return threads;
  const known = new Set(threads.map((thread) => thread.id));
  return [...pending.filter((thread) => !known.has(thread.id)), ...threads];
}

function mergeEvents(snapshot: EventEnvelope[], streamed: EventEnvelope[]): EventEnvelope[] {
  const byId = new Map<string, EventEnvelope>();
  for (const event of [...snapshot, ...streamed]) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.cursor - b.cursor);
}

function mergeMessages(
  snapshot: BootstrapEnvelope["messages"],
  completeThread: BootstrapEnvelope["messages"],
  streamed: BootstrapEnvelope["messages"] = [],
): BootstrapEnvelope["messages"] {
  const byId = new Map<string, BootstrapEnvelope["messages"][number]>();
  for (const message of [...completeThread, ...snapshot, ...streamed]) {
    byId.set(message.id, normalizeConversationMessage(message));
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function eventRequiresBootstrapRefresh(type: string): boolean {
  return !type.startsWith("driver.tool.");
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
