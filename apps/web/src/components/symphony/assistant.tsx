"use client";

import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { AgentLoader, AgentToolFallback } from "@/components/symphony/agent-tool";
import { ConductorSelector } from "@/components/symphony/conductor-selector";
import { ConversationSidebar, CreateGroupDialog } from "@/components/symphony/conversation-sidebar";
import { CommandPalette } from "@/components/symphony/command-palette";
import { NewChatDialog } from "@/components/symphony/new-chat-dialog";
import { SymphonyWelcome } from "@/components/symphony/welcome";
import { SymphonyProvider } from "@/components/symphony/provider";
import { PromptRail } from "@/components/symphony/prompt-rail";
import { useSymphony, useSymphonyMessages } from "@/components/symphony/context";
import {
  WorkspaceNavigation,
  type WorkspaceTab,
} from "@/components/symphony/workspace-navigation";
import { readStudioMode, readWorkspaceTab, writeStudioMode, writeWorkspaceTab, type StudioMode } from "@/lib/symphony/workspace-tabs";
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { createDialogHandle, DialogTrigger } from "@/components/ui/dialog";
import {
  AssistantRuntimeProvider,
  CompositeAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  type AppendMessage,
  type ThreadMessageLike,
  useExternalMessageConverter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { ArrowSquareOut, ChatsCircle, FolderSimple, ListMagnifyingGlass, Square, X } from "@phosphor-icons/react";
import gsap from "gsap";
import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  buildPreviewMessages,
  extractText,
  mergeProjectedThreadMessages,
  toThreadMessages,
} from "@/lib/symphony/messages";
import { isActivelyWorkingAgent, loaderForHarness } from "@/lib/symphony/format";
import type { AgentDetail, AgentSessionLog as AgentSessionLogRecord, ChatAttachment, ConversationMessage, EventEnvelope, JsonValue, WorkflowRevisionRecord } from "@/lib/symphony/contracts";
import { openAgentWindow } from "@/lib/symphony/window-layout";
import {
  getOrCreateWindowId,
  useSymphonyWindowRegistry,
  workspaceWindowLabel,
} from "@/lib/symphony/window-registry";

const THREAD_COMPONENTS = {
  ToolFallback: AgentToolFallback,
  Welcome: SymphonyWelcome,
  ComposerControls: ConductorSelector,
};
const InboxDialog = lazy(() => import("@/components/symphony/inbox-dialog").then((module) => ({ default: module.InboxDialog })));
const RunDetails = lazy(() => import("@/components/symphony/run-details").then((module) => ({ default: module.RunDetails })));
const SettingsDialog = lazy(() => import("@/components/symphony/settings-dialog").then((module) => ({ default: module.SettingsDialog })));
const UsageDialog = lazy(() => import("@/components/symphony/usage-dialog").then((module) => ({ default: module.UsageDialog })));
const ObjectiveCreateDialog = lazy(() => import("@/components/symphony/objective-create-dialog").then((module) => ({ default: module.ObjectiveCreateDialog })));
const ObjectiveControlRoomSurface = lazy(() => import("@/components/symphony/objective-control-room-surface").then((module) => ({ default: module.ObjectiveControlRoomSurface })));
const WorkflowStudio = lazy(() => import("@/components/symphony/workflow-studio").then((module) => ({ default: module.WorkflowStudio })));
const SymphonyStructuredDataUI = lazy(() => import("@/components/symphony/structured-data-ui").then((module) => ({ default: module.SymphonyStructuredDataUI })));
const SymphonyGenerativeDataUI = lazy(() => import("@/components/symphony/generative-data-ui").then((module) => ({ default: module.SymphonyGenerativeDataUI })));
const AgentConversation = lazy(() => import("@/components/symphony/agent-conversation").then((module) => ({ default: module.AgentConversation })));
const AgentSessionLog = lazy(() => import("@/components/symphony/agent-session-log").then((module) => ({ default: module.AgentSessionLog })));
const textAttachmentAdapter = new SimpleTextAttachmentAdapter();
textAttachmentAdapter.accept = [
  "text/*",
  "application/json",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".rb", ".rs", ".go", ".java", ".kt", ".swift",
  ".css", ".scss", ".html", ".md", ".mdx", ".txt", ".csv",
  ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml", ".sql",
  ".sh", ".zsh", ".fish", ".env.example",
].join(",");
const attachmentAdapter = new CompositeAttachmentAdapter([textAttachmentAdapter]);

export function Assistant({
  popoutAgentId,
  popoutWindowId,
  conversationId,
}: {
  popoutAgentId?: string;
  popoutWindowId?: string;
  conversationId?: string;
}) {
  const [mainWindowId] = useState(() => getOrCreateWindowId("main"));
  const providerWindowId = popoutAgentId
    ? popoutWindowId ?? `agent:${popoutAgentId}`
    : mainWindowId;
  return (
    <SymphonyProvider windowId={providerWindowId}>
      {popoutAgentId ? (
        <AgentPopout
          agentId={popoutAgentId}
          windowId={popoutWindowId ?? `agent:${popoutAgentId}`}
          conversationId={conversationId}
        />
      ) : <SymphonyShell />}
    </SymphonyProvider>
  );
}

function SymphonyShell() {
  const symphony = useSymphony();
  const active = symphony.activeConversation;
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatProjectId, setNewChatProjectId] = useState<string | undefined>();
  const [objectiveCreateOpen, setObjectiveCreateOpen] = useState(false);
  const [objectiveWorkflow, setObjectiveWorkflow] = useState<WorkflowRevisionRecord | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteHandle] = useState(createDialogHandle);
  const [paletteGroupOpen, setPaletteGroupOpen] = useState(false);
  const [openAgentIds, setOpenAgentIds] = useState<string[]>([]);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(() => readWorkspaceTab(undefined, symphony.windowId));
  const [studioMode, setStudioMode] = useState<StudioMode>(() => readStudioMode(undefined, symphony.windowId));
  const windowId = symphony.windowId;
  const registeredWindows = useSymphonyWindowRegistry({
    windowId,
    kind: "main",
    conversationId: active?.id,
    title: active?.title ?? "Symphony",
  });
  const externalAgentIds = useMemo(
    () => new Set(registeredWindows.filter((item) => item.kind === "agent").flatMap((item) => item.agentId ? [item.agentId] : [])),
    [registeredWindows],
  );

  useEffect(() => {
    document.title = workspaceWindowLabel(windowId, active?.title, registeredWindows);
  }, [active?.title, registeredWindows, windowId]);

  useEffect(() => {
    setOpenAgentIds([]);
    symphony.openAgent(null);
  }, [active?.id]);

  useEffect(() => {
    const agentId = symphony.selectedAgentId;
    if (!agentId || agentId === active?.conductorAgentId) return;
    setOpenAgentIds((current) => current.includes(agentId) ? current : [...current, agentId]);
  }, [active?.conductorAgentId, symphony.selectedAgentId]);

  const closeAgent = useCallback((agentId: string) => {
    setOpenAgentIds((current) => current.filter((id) => id !== agentId));
    if (symphony.selectedAgentId === agentId) symphony.openAgent(null);
  }, [symphony.openAgent, symphony.selectedAgentId]);

  const openNewChat = useCallback((groupId?: string) => {
    const requested = groupId && symphony.projects.some((project) => project.id === groupId) ? groupId : undefined;
    const activeProject = active?.groupId && symphony.projects.some((project) => project.id === active.groupId)
      ? active.groupId
      : undefined;
    setNewChatProjectId(requested ?? activeProject);
    setNewChatOpen(true);
  }, [active?.groupId, symphony.projects]);
  const openNewObjective = useCallback((workflow?: WorkflowRevisionRecord) => {
    setObjectiveWorkflow(workflow ?? null);
    setObjectiveCreateOpen(true);
  }, []);
  const moveConversation = useCallback(
    (id: string, groupId: string) => void symphony.moveConversation(id, groupId),
    [symphony.moveConversation],
  );
  const renameConversation = useCallback(
    (id: string, title: string) => void symphony.renameConversation(id, title),
    [symphony.renameConversation],
  );
  const archiveConversation = useCallback(
    (id: string) => void symphony.archiveConversation(id),
    [symphony.archiveConversation],
  );
  const openSettings = useCallback(() => symphony.setSettingsOpen(true), [symphony.setSettingsOpen]);
  const openUsage = useCallback(() => symphony.setUsageOpen(true), [symphony.setUsageOpen]);
  const openInbox = useCallback(() => symphony.setInboxOpen(true), [symphony.setInboxOpen]);
  const onWorkspaceTabChange = useCallback((tab: WorkspaceTab) => {
    setWorkspaceTab(tab);
    writeWorkspaceTab(tab, undefined, symphony.windowId);
  }, [symphony.windowId]);
  const onStudioModeChange = useCallback((mode: StudioMode) => {
    setStudioMode(mode);
    writeStudioMode(mode, undefined, symphony.windowId);
  }, [symphony.windowId]);
  const openStudio = useCallback((mode?: StudioMode) => {
    if (mode) onStudioModeChange(mode);
    onWorkspaceTabChange("Studio");
  }, [onStudioModeChange, onWorkspaceTabChange]);
  const runtime = symphony.mode === "runtime" && symphony.envelope.mode === "runtime";

  useEffect(() => {
    const openPalette = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", openPalette);
    return () => window.removeEventListener("keydown", openPalette);
  }, []);

  return (
    <SidebarProvider
      className="h-dvh min-h-0 overflow-hidden"
      style={{ "--sidebar-width": "15.5rem" } as CSSProperties}
    >
      <ConversationSidebar
        directory={symphony.directory}
        activeConversationId={active?.id ?? ""}
        runCost={symphony.envelope.costs.knownTotal ?? symphony.envelope.costs.amount}
        unreadInbox={symphony.unreadInbox}
        onSelectConversation={symphony.selectConversation}
        onNewConversation={openNewChat}
        onCreateGroup={symphony.createGroup}
        onMoveConversation={moveConversation}
        onTogglePinned={symphony.togglePinned}
        onRenameConversation={renameConversation}
        onArchiveConversation={archiveConversation}
        onOpenSettings={openSettings}
        onOpenUsage={openUsage}
        onOpenInbox={openInbox}
        commandPaletteHandle={commandPaletteHandle}
      />
      <CreateGroupDialog
        open={paletteGroupOpen}
        onOpenChange={setPaletteGroupOpen}
        onCreate={symphony.createGroup}
      />
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        handle={commandPaletteHandle}
        directory={symphony.directory}
        defaultGroupId={active?.groupId}
        onSelectConversation={symphony.selectConversation}
        onNewConversation={openNewChat}
        onCreateGroup={() => setPaletteGroupOpen(true)}
        onCreateObjective={symphony.mode === "runtime" ? openNewObjective : undefined}
        onOpenSettings={openSettings}
        onOpenUsage={openUsage}
        onOpenInbox={openInbox}
        onOpenCapabilities={runtime ? (mode) => openStudio(mode) : undefined}
        onOpenAgentMessages={runtime ? () => onWorkspaceTabChange("ControlRoom") : undefined}
        onOpenDiagnostics={runtime ? () => onWorkspaceTabChange("Trace") : undefined}
        onNavigate={(target) => {
          if (target === "Inbox") openInbox();
          else if (target === "Studio") openStudio();
          else onWorkspaceTabChange(target);
        }}
      />
      {active ? (
        <AssistantConversation
          key={active.id}
          openAgentIds={openAgentIds}
          onCloseAgent={closeAgent}
          externalAgentIds={externalAgentIds}
          commandPaletteHandle={commandPaletteHandle}
          onOpenObjective={openNewObjective}
          workspaceTab={workspaceTab}
          onWorkspaceTabChange={onWorkspaceTabChange}
          studioMode={studioMode}
          onStudioModeChange={onStudioModeChange}
        />
      ) : (
        <SidebarInset className="grid h-dvh place-items-center bg-background text-sm text-muted-foreground">
          Start a conversation with the conductor.
        </SidebarInset>
      )}
      <Suspense fallback={null}>
        {symphony.settingsOpen ? <SettingsDialog /> : null}
        {symphony.usageOpen ? <UsageDialog /> : null}
        {symphony.inboxOpen ? <InboxDialog /> : null}
      </Suspense>
      <NewChatDialog
        open={newChatOpen}
        initialProjectId={newChatProjectId}
        onOpenChange={setNewChatOpen}
      />
      <ObjectiveCreateDialog
        open={objectiveCreateOpen}
        initialWorkflow={objectiveWorkflow}
        initialProjectId={active?.groupId && symphony.projects.some((project) => project.id === active.groupId) ? active.groupId : symphony.projects[0]?.id}
        initialWorkspacePath={active?.workspacePath}
        onOpenChange={(open) => {
          setObjectiveCreateOpen(open);
          if (!open) setObjectiveWorkflow(null);
        }}
      />
    </SidebarProvider>
  );
}

function AssistantConversation({
  openAgentIds,
  onCloseAgent,
  externalAgentIds,
  commandPaletteHandle,
  onOpenObjective,
  workspaceTab,
  onWorkspaceTabChange,
  studioMode,
  onStudioModeChange,
}: {
  openAgentIds: string[];
  onCloseAgent: (agentId: string) => void;
  externalAgentIds: ReadonlySet<string>;
  commandPaletteHandle: ReturnType<typeof createDialogHandle>;
  onOpenObjective: (workflow?: WorkflowRevisionRecord) => void;
  workspaceTab: WorkspaceTab;
  onWorkspaceTabChange: (tab: WorkspaceTab) => void;
  studioMode: StudioMode;
  onStudioModeChange: (mode: StudioMode) => void;
}) {
  const symphony = useSymphony();
  const projectedMessages = useSymphonyMessages();
  // Token/event projections can arrive more frequently than the browser can
  // paint a full assistant-ui tree. Keep the live state immediate, but let
  // expensive message conversion and markdown/tool rendering yield to input.
  const deferredProjectedMessages = useDeferredValue(projectedMessages);
  const conversation = symphony.activeConversation;
  const snapshot = symphony.snapshot;
  const [localMessages, setLocalMessages] = useState<readonly ThreadMessageLike[]>(() =>
    symphony.mode === "preview" ? messagesForConversation(symphony, conversation, projectedMessages) : [],
  );
  const [isRunning, setIsRunning] = useState(conversation?.state === "running");
  const workspaceRef = useRef<HTMLDivElement>(null);
  const orchestratorChatRef = useRef<HTMLDivElement>(null);
  const sidebar = useSidebar();
  const animatedPanes = useRef(new Set<string>());
  const streamingMessage = projectedMessages.some(
    (message) => message.threadId === conversation?.id && message.role === "assistant" && message.streaming,
  );

  useEffect(() => {
    setLocalMessages(
      symphony.mode === "preview" ? messagesForConversation(symphony, conversation, projectedMessages) : [],
    );
    // Projected runtime messages are owned by the provider. Local messages are
    // scoped optimistic state and must never leak into a different thread.
  }, [conversation?.id, symphony.mode]);

  useEffect(() => {
    setIsRunning(conversation?.state === "running" || streamingMessage);
  }, [conversation?.state, streamingMessage]);

  const runtimeMessages = useMemo(() => {
    if (symphony.mode === "preview") return localMessages;
    const fromDaemon = toThreadMessages(
      deferredProjectedMessages.filter((message) => message.threadId === conversation?.id),
    );
    return mergeProjectedThreadMessages(fromDaemon, localMessages);
  }, [conversation?.id, deferredProjectedMessages, localMessages, symphony.mode]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = extractText(message.content);
      const messageId = crypto.randomUUID();
      const userMessage: ThreadMessageLike = {
        id: messageId,
        role: message.role,
        content: message.content,
        createdAt: new Date(),
        attachments: message.role === "user" ? message.attachments : undefined,
      };

      if (symphony.mode === "preview") {
        setLocalMessages((current) => [
          ...current,
          userMessage,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content:
              "This interface is currently using an explicit preview projection. Once the Symphony daemon is connected, this message will be delivered as an audited conductor command.",
            createdAt: new Date(),
            status: { type: "complete", reason: "stop" },
          },
        ]);
        return;
      }

      setIsRunning(true);
      setLocalMessages((current) => [...current, userMessage]);
      if (!conversation) return;
      try {
        await symphony.sendMessage(conversation.id, {
          messageId,
          content: text,
          attachments: serializeAttachments(message.attachments),
        });
      } catch {
        setIsRunning(false);
        setLocalMessages((current) => current.filter((candidate) => candidate.id !== messageId));
        await symphony.loadThreadMessages(conversation.id).catch(() => undefined);
      }
    },
    [conversation, symphony],
  );

  const onCancel = useCallback(async () => {
    setIsRunning(false);
    await symphony.cancelRun();
  }, [symphony]);

  const convertedMessages = useExternalMessageConverter({
    messages: [...runtimeMessages],
    callback: (message: ThreadMessageLike) => message,
    isRunning,
    joinStrategy: "none",
  });

  const runtime = useExternalStoreRuntime({
    messages: convertedMessages,
    setMessages: (messages) => setLocalMessages(messages),
    onNew,
    onCancel,
    onRefetchThread: conversation ? () => symphony.loadThreadMessages(conversation.id).then(() => undefined) : undefined,
    adapters: { attachments: attachmentAdapter },
    isRunning,
  });

  const live = isRunning || snapshot.agents.some((agent) => isActivelyWorkingAgent(agent.state));
  const dataNames = useMemo(() => new Set(runtimeMessages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part !== null && typeof part === "object" && "type" in part && part.type === "data" && "name" in part && typeof part.name === "string"
            ? [part.name]
            : [],
        )
      : [],
  )), [runtimeMessages]);
  const hasGenerativeData = dataNames.has("generative-ui");
  const hasStructuredData = [...dataNames].some((name) => name !== "generative-ui");
  const agentDetails = openAgentIds
    .map((id) => symphony.agentDetail(id))
    .filter((detail): detail is AgentDetail => detail !== null);
  const tileCount = 1 + agentDetails.length;
  const paneSignature = ["orchestrator", ...agentDetails.map((detail) => detail.id)].join("|");
  const tileLayout = tileCount === 1
    ? "grid-cols-1"
    : tileCount === 2
      ? "md:grid-cols-2"
      : tileCount === 3
        ? "lg:grid-cols-2 lg:grid-rows-2"
        : tileCount === 4
          ? "md:grid-cols-2 md:grid-rows-2"
        : "md:grid-cols-2 xl:grid-cols-3";

  useLayoutEffect(() => {
    const root = workspaceRef.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const fresh = [...root.querySelectorAll<HTMLElement>("[data-symphony-pane]")]
      .filter((element) => {
        const id = element.dataset.symphonyPane;
        if (!id || animatedPanes.current.has(id)) return false;
        animatedPanes.current.add(id);
        return true;
      });
    if (!fresh.length) return;
    const tween = gsap.fromTo(
      fresh,
      { autoAlpha: 0.72, y: 4, scale: 0.997 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.22, ease: "power2.out", stagger: 0.025, clearProps: "opacity,transform,visibility" },
    );
    return () => {
      tween.kill();
    };
  }, [paneSignature]);

  if (!conversation) return null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {hasStructuredData && (
        <Suspense fallback={null}>
          <SymphonyStructuredDataUI />
        </Suspense>
      )}
      {hasGenerativeData && (
        <Suspense fallback={null}>
          <SymphonyGenerativeDataUI />
        </Suspense>
      )}
      <SidebarInset className="relative h-dvh min-h-0 min-w-0 overflow-hidden bg-muted/20">
        <div ref={workspaceRef} className={`grid h-full min-h-0 [grid-auto-rows:minmax(0,1fr)] ${tileCount > 1 ? "gap-1.5 p-1.5" : "gap-0 p-0"} ${tileLayout}`}>
          <section
            data-symphony-pane="orchestrator"
            className={`flex min-h-0 min-w-0 flex-col overflow-hidden bg-background ${tileCount > 1 ? "rounded-lg border border-foreground/75 bg-background/82 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-foreground)_12%,transparent)] backdrop-blur-xl" : "border border-transparent"} ${tileCount === 3 ? "lg:row-span-2" : ""}`}
            aria-label="Orchestrator conversation"
          >
            <header className="shrink-0 bg-background/68 backdrop-blur-xl">
              <div className="flex h-11 items-center justify-between gap-3 px-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  {(sidebar.isMobile ? !sidebar.openMobile : !sidebar.open) ? (
                    <>
                      <SidebarTrigger className="size-7 shrink-0 text-muted-foreground hover:bg-muted/50 hover:text-foreground" aria-label="Open sidebar" />
                      <DialogTrigger
                        handle={commandPaletteHandle}
                        aria-label="Open command palette"
                        title="Search or run a command"
                        render={<button type="button" />}
                        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ListMagnifyingGlass className="size-3.5" />
                      </DialogTrigger>
                    </>
                  ) : null}
                  {live ? (
                    <AgentLoader
                      kind={conversation.loader ?? loaderForHarness(snapshot.agents[0]?.harness ?? "pi")}
                      size={14}
                      label={`${conversation.title} active`}
                      tone="info"
                    />
                  ) : null}
                  <h1 className="truncate text-[13px] font-medium tracking-[-0.01em]">{conversation.title}</h1>
                  {conversation.workspacePath ? (
                    <span
                      className="hidden min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground xl:flex"
                      title={conversation.workspacePath}
                    >
                      <span className="h-3 w-px bg-border" aria-hidden="true" />
                      <FolderSimple className="size-3 shrink-0" />
                      <span className="max-w-48 truncate font-mono">{conversation.workspacePath}</span>
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center justify-end gap-0.5">
                  <WorkspaceNavigation activeTab={workspaceTab} onTabChange={onWorkspaceTabChange} />
                  <ConnectionBadge />
                  {live ? (
                    <button
                      onClick={() => void onCancel()}
                      className="grid size-8 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                      aria-label="Stop run"
                      title="Stop run"
                    >
                      <Square className="size-3.5 fill-current" />
                    </button>
                  ) : null}
                </div>
              </div>
            </header>

            {symphony.error ? (
              <div className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs text-destructive">
                <span className="min-w-0 flex-1">{symphony.error}</span>
                <button type="button" onClick={symphony.clearError} aria-label="Dismiss error" className="shrink-0 cursor-pointer hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              </div>
            ) : null}

            {workspaceTab === "ControlRoom" ? (
              <ObjectiveControlRoomSurface onOpenAgent={symphony.openAgent} />
            ) : workspaceTab === "Studio" ? (
              <WorkflowStudio onOpenObjective={onOpenObjective} studioMode={studioMode} onStudioModeChange={onStudioModeChange} />
            ) : workspaceTab === "Chat" ? (
              <div ref={orchestratorChatRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                <Thread autoFocus={false} components={THREAD_COMPONENTS} />
                <PromptRail messages={runtimeMessages} scopeRef={orchestratorChatRef} />
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="grid min-h-0 flex-1 place-items-center text-xs text-muted-foreground">
                    <AgentLoader kind="circular" size={18} label={`Loading ${workspaceTab}`} />
                  </div>
                }
              >
                <RunDetails
                  snapshot={snapshot}
                  selectedAgentId={symphony.selectedAgentId}
                  onSelectAgent={symphony.openAgent}
                  tab={workspaceTab}
                />
              </Suspense>
            )}
          </section>

          {agentDetails.map((detail) => (
            <AgentTile
              key={detail.id}
              detail={detail}
              conversationId={conversation.id}
              selected={symphony.selectedAgentId === detail.id}
              external={externalAgentIds.has(detail.id)}
              loadMessages={symphony.loadAgentMessages}
              subscribeToAgent={symphony.subscribeToAgent}
              loadLogs={symphony.loadAgentLogs}
              onSteer={symphony.steer}
              onCancel={symphony.cancelOne}
              onSelect={() => symphony.openAgent(detail.id)}
              onClose={() => onCloseAgent(detail.id)}
            />
          ))}
        </div>
      </SidebarInset>
    </AssistantRuntimeProvider>
  );
}

type AgentTileProps = {
  detail: AgentDetail;
  conversationId: string;
  selected: boolean;
  external: boolean;
  loadMessages: (agentId: string) => Promise<ConversationMessage[]>;
  subscribeToAgent: (agentId: string, onEvent: (event: EventEnvelope) => void, onReset?: () => void) => () => void;
  loadLogs: (agentId: string, after?: number) => Promise<AgentSessionLogRecord>;
  onSteer: (agentId: string, content: string) => Promise<void>;
  onCancel: (agentId: string) => Promise<void>;
  onSelect: () => void;
  onClose: () => void;
};

const AgentTile = memo(function AgentTile({
  detail,
  conversationId,
  selected,
  external,
  loadMessages,
  subscribeToAgent,
  loadLogs,
  onSteer,
  onCancel,
  onSelect,
  onClose,
}: AgentTileProps) {
  const live = isActivelyWorkingAgent(detail.state);
  const [view, setView] = useState<"chat" | "logs">("chat");
  return (
    <section
      data-symphony-pane={detail.id}
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-background/78 backdrop-blur-xl transition-[border-color,box-shadow] ${selected ? "border-foreground/45 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-foreground)_8%,transparent)]" : "border-border/75"}`}
      aria-label={`${detail.name} agent conversation`}
      onFocusCapture={onSelect}
      onPointerDownCapture={onSelect}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 bg-background/50 px-3 backdrop-blur-xl">
        <AgentLoader
          kind={loaderForHarness(detail.harness)}
          size={14}
          label={`${detail.name} ${detail.state}`}
          animated={live}
          tone={agentTone(detail)}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium">{detail.name}</p>
          <p className="truncate text-[9px] text-muted-foreground">
            {detail.harness} · {detail.model} · {detail.state}
          </p>
        </div>
        {external ? (
          <span className="hidden text-[9px] text-info xl:inline">External window</span>
        ) : null}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setView((current) => current === "chat" ? "logs" : "chat");
          }}
          className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={view === "chat" ? `View logs for ${detail.name}` : `View chat for ${detail.name}`}
          title={view === "chat" ? "Session logs" : "Agent chat"}
        >
          {view === "chat" ? <ListMagnifyingGlass className="size-3.5" /> : <ChatsCircle className="size-3.5" />}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            openAgentWindow(detail.id, conversationId);
          }}
          className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={`Open ${detail.name} in a new window`}
          title="Open in new window"
        >
          <ArrowSquareOut className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={`Close ${detail.name}`}
          title="Close pane"
        >
          <X className="size-3.5" />
        </button>
      </header>
      {detail.error ? (
        <div className="flex items-start gap-2 border-b border-destructive/20 bg-destructive/8 px-3 py-2 text-[10px] leading-4 text-destructive">
          <span className="min-w-0 flex-1">{detail.error}</span>
          <button type="button" className="shrink-0 cursor-pointer underline underline-offset-2" onClick={() => setView("logs")}>View logs</button>
        </div>
      ) : null}
      {view === "chat" ? (
        <Suspense fallback={<AgentPaneLoading label={`Loading ${detail.name} chat`} />}>
          <AgentConversation
            detail={detail}
            loadMessages={loadMessages}
            subscribeToAgent={subscribeToAgent}
            onSteer={onSteer}
            onCancel={onCancel}
          />
        </Suspense>
      ) : (
        <Suspense fallback={<AgentPaneLoading label={`Loading ${detail.name} logs`} />}>
          <AgentSessionLog detail={detail} loadLogs={loadLogs} />
        </Suspense>
      )}
    </section>
  );
}, areAgentTilePropsEqual);

function areAgentTilePropsEqual(previous: AgentTileProps, next: AgentTileProps): boolean {
  if (previous.conversationId !== next.conversationId || previous.selected !== next.selected || previous.external !== next.external) return false;
  if (previous.loadMessages !== next.loadMessages || previous.subscribeToAgent !== next.subscribeToAgent || previous.loadLogs !== next.loadLogs || previous.onSteer !== next.onSteer || previous.onCancel !== next.onCancel) return false;
  const left = previous.detail;
  const right = next.detail;
  return left.id === right.id
    && left.name === right.name
    && left.objective === right.objective
    && left.model === right.model
    && left.harness === right.harness
    && left.access === right.access
    && left.state === right.state
    && left.nativeStatus === right.nativeStatus
    && left.elapsed === right.elapsed
    && left.cost === right.cost
    && left.lastActivity === right.lastActivity
    && left.nativeSessionId === right.nativeSessionId
    && left.nativeRunId === right.nativeRunId
    && left.workspacePath === right.workspacePath
    && left.error === right.error
    && left.runId === right.runId
    && left.workflowId === right.workflowId
    && left.startedAt === right.startedAt
    && left.updatedAt === right.updatedAt
    && left.finishedAt === right.finishedAt;
}

function AgentPopout({
  agentId,
  windowId,
  conversationId,
}: {
  agentId: string;
  windowId: string;
  conversationId?: string;
}) {
  const symphony = useSymphony();
  const [view, setView] = useState<"chat" | "logs">("chat");
  useSymphonyWindowRegistry({ windowId, kind: "agent", agentId, conversationId });

  useEffect(() => {
    if (conversationId && symphony.activeConversation?.id !== conversationId) {
      symphony.selectConversation(conversationId);
    }
  }, [conversationId, symphony.activeConversation?.id, symphony.selectConversation]);

  const detail = symphony.agentDetail(agentId);
  useEffect(() => {
    if (!detail) return;
    const previous = document.title;
    document.title = `${detail.name} · Symphony`;
    return () => {
      document.title = previous;
    };
  }, [detail?.id, detail?.name]);

  if (!detail) {
    return (
      <main className="grid h-dvh place-items-center bg-background text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <AgentLoader kind="circular" size={18} label="Loading agent window" />
          Locating agent conversation…
        </div>
      </main>
    );
  }

  const live = isActivelyWorkingAgent(detail.state);
  return (
    <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <AgentLoader
          kind={loaderForHarness(detail.harness)}
          size={15}
          label={`${detail.name} ${detail.state}`}
          animated={live}
          tone={agentTone(detail)}
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[13px] font-medium">{detail.name}</h1>
          <p className="truncate text-[9px] text-muted-foreground">
            {detail.harness} · {detail.model} · {detail.state}
          </p>
        </div>
        <span className="rounded border border-border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
          Agent
        </span>
        <button
          type="button"
          onClick={() => setView((current) => current === "chat" ? "logs" : "chat")}
          className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={view === "chat" ? `View logs for ${detail.name}` : `View chat for ${detail.name}`}
          title={view === "chat" ? "Session logs" : "Agent chat"}
        >
          {view === "chat" ? <ListMagnifyingGlass className="size-3.5" /> : <ChatsCircle className="size-3.5" />}
        </button>
      </header>
      {detail.error ? (
        <div className="border-b border-destructive/20 bg-destructive/8 px-3 py-2 text-[10px] leading-4 text-destructive">
          {detail.error}
        </div>
      ) : null}
      {view === "chat" ? (
        <Suspense fallback={<AgentPaneLoading label={`Loading ${detail.name} chat`} />}>
          <AgentConversation
            detail={detail}
            loadMessages={symphony.loadAgentMessages}
            subscribeToAgent={symphony.subscribeToAgent}
            onSteer={symphony.steer}
            onCancel={symphony.cancelOne}
          />
        </Suspense>
      ) : (
        <Suspense fallback={<AgentPaneLoading label={`Loading ${detail.name} logs`} />}>
          <AgentSessionLog detail={detail} loadLogs={symphony.loadAgentLogs} />
        </Suspense>
      )}
    </main>
  );
}

function agentTone(detail: Pick<AgentDetail, "state">): "info" | "success" | "danger" | "warning" {
  if (detail.state === "succeeded") return "success";
  if (detail.state === "failed") return "danger";
  if (detail.state === "blocked" || detail.state === "cancelled" || detail.state === "stale" || detail.state === "waiting") return "warning";
  return "info";
}

function AgentPaneLoading({ label }: { label: string }) {
  return (
    <div className="grid min-h-32 flex-1 place-items-center text-[10px] text-muted-foreground">
      <span className="flex items-center gap-2">
        <AgentLoader kind="square" size={14} label={label} />
        {label}
      </span>
    </div>
  );
}

function serializeAttachments(attachments: AppendMessage["attachments"]): ChatAttachment[] {
  return (attachments ?? []).map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    type: attachment.type,
    ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
    content: attachment.content as unknown as JsonValue[],
  }));
}

function messagesForConversation(
  symphony: ReturnType<typeof useSymphony>,
  conversation: ReturnType<typeof useSymphony>["activeConversation"],
  messages: ReturnType<typeof useSymphonyMessages>,
): readonly ThreadMessageLike[] {
  if (!conversation) return [];
  if (symphony.mode === "preview") return buildPreviewMessages(symphony.snapshot, conversation);
  return toThreadMessages(messages.filter((message) => message.threadId === conversation.id));
}

function ConnectionBadge() {
  const { connection } = useSymphony();
  const label =
    connection === "preview"
      ? "Preview"
      : connection === "live"
        ? "Live"
        : connection === "connecting"
          ? "Connecting"
          : connection === "stale"
            ? "Reconnecting"
            : "Offline";
  return (
    <span className="hidden items-center gap-1.5 px-2 text-[11px] text-muted-foreground sm:flex">
      {connection === "connecting" || connection === "stale" ? (
        <AgentLoader kind="circular" size={12} label={label} />
      ) : null}
      {label}
    </span>
  );
}
