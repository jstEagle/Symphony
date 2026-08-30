"use client";

import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { AgentLoader, AgentToolFallback } from "@/components/symphony/agent-tool";
import { ConductorSelector } from "@/components/symphony/conductor-selector";
import { ConversationSidebar } from "@/components/symphony/conversation-sidebar";
import { NewChatDialog } from "@/components/symphony/new-chat-dialog";
import { SymphonyWelcome } from "@/components/symphony/welcome";
import { SymphonyProvider } from "@/components/symphony/provider";
import { useSymphony } from "@/components/symphony/context";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import {
  AssistantRuntimeProvider,
  CompositeAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  type AppendMessage,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { FolderSimple, Square, X } from "@phosphor-icons/react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { buildPreviewMessages, extractText, toThreadMessages } from "@/lib/symphony/messages";
import { isLiveAgentState, loaderForHarness } from "@/lib/symphony/format";
import { cn } from "@/lib/utils";
import type { ChatAttachment, JsonValue } from "@/lib/symphony/contracts";

const THREAD_COMPONENTS = {
  ToolFallback: AgentToolFallback,
  Welcome: SymphonyWelcome,
  ComposerControls: ConductorSelector,
};
const AgentSheet = lazy(() => import("@/components/symphony/agent-sheet").then((module) => ({ default: module.AgentSheet })));
const InboxDialog = lazy(() => import("@/components/symphony/inbox-dialog").then((module) => ({ default: module.InboxDialog })));
const RunDetails = lazy(() => import("@/components/symphony/run-details").then((module) => ({ default: module.RunDetails })));
const SettingsDialog = lazy(() => import("@/components/symphony/settings-dialog").then((module) => ({ default: module.SettingsDialog })));
const UsageDialog = lazy(() => import("@/components/symphony/usage-dialog").then((module) => ({ default: module.UsageDialog })));
const SymphonyStructuredDataUI = lazy(() => import("@/components/symphony/structured-data-ui").then((module) => ({ default: module.SymphonyStructuredDataUI })));
const SymphonyGenerativeDataUI = lazy(() => import("@/components/symphony/generative-data-ui").then((module) => ({ default: module.SymphonyGenerativeDataUI })));
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
const WORKSPACE_TABS = ["Chat", "Overview", "Trace", "Graph", "Activity"] as const;
type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export function Assistant() {
  return (
    <SymphonyProvider>
      <SymphonyShell />
    </SymphonyProvider>
  );
}

function SymphonyShell() {
  const symphony = useSymphony();
  const active = symphony.activeConversation;
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatProjectId, setNewChatProjectId] = useState<string | undefined>();

  const openNewChat = useCallback((groupId?: string) => {
    const requested = groupId && symphony.projects.some((project) => project.id === groupId) ? groupId : undefined;
    const activeProject = active?.groupId && symphony.projects.some((project) => project.id === active.groupId)
      ? active.groupId
      : undefined;
    setNewChatProjectId(requested ?? activeProject);
    setNewChatOpen(true);
  }, [active?.groupId, symphony.projects]);
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
      />
      {active ? (
        <AssistantConversation key={active.id} />
      ) : (
        <SidebarInset className="grid h-dvh place-items-center bg-background text-sm text-muted-foreground">
          Start a conversation with the conductor.
        </SidebarInset>
      )}
      <Suspense fallback={null}>
        {symphony.settingsOpen ? <SettingsDialog /> : null}
        {symphony.usageOpen ? <UsageDialog /> : null}
        {symphony.inboxOpen ? <InboxDialog /> : null}
        {symphony.selectedAgentId ? (
          <AgentSheet
            detail={symphony.agentDetail(symphony.selectedAgentId)}
            open
            onOpenChange={(open) => {
              if (!open) symphony.openAgent(null);
            }}
            onObserve={symphony.observe}
            onSteer={symphony.steer}
            onCancel={symphony.cancelOne}
            onOpenChild={symphony.openAgent}
          />
        ) : null}
      </Suspense>
      <NewChatDialog
        open={newChatOpen}
        initialProjectId={newChatProjectId}
        onOpenChange={setNewChatOpen}
      />
    </SidebarProvider>
  );
}

function AssistantConversation() {
  const symphony = useSymphony();
  const conversation = symphony.activeConversation;
  const snapshot = symphony.snapshot;
  const [localMessages, setLocalMessages] = useState<readonly ThreadMessageLike[]>(() =>
    messagesForConversation(symphony, conversation),
  );
  const [isRunning, setIsRunning] = useState(conversation?.state === "running");
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("Chat");
  const streamingMessage = symphony.envelope.messages.some(
    (message) => message.threadId === conversation?.id && message.role === "assistant" && message.streaming,
  );

  useEffect(() => {
    setIsRunning(conversation?.state === "running" || streamingMessage);
  }, [conversation?.state, streamingMessage]);

  const runtimeMessages = useMemo(() => {
    if (symphony.mode === "preview") return localMessages;
    const fromDaemon = toThreadMessages(
      symphony.envelope.messages.filter((message) => message.threadId === conversation?.id),
    );
    const extras = localMessages.filter((message) => {
      if (fromDaemon.some((item) => item.id === message.id)) return false;
      if (message.role !== "user") return true;
      const text = extractText(message.content);
      return !fromDaemon.some((item) => item.role === "user" && extractText(item.content) === text);
    });
    return [...fromDaemon, ...extras];
  }, [conversation?.id, localMessages, symphony.envelope.messages, symphony.mode]);

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
      } catch (error) {
        setIsRunning(false);
        setLocalMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: error instanceof Error ? error.message : "The daemon did not accept that message.",
            createdAt: new Date(),
            status: { type: "complete", reason: "stop" },
          },
        ]);
      }
    },
    [conversation, symphony],
  );

  const onCancel = useCallback(async () => {
    setIsRunning(false);
    await symphony.cancelRun();
  }, [symphony]);

  const runtime = useExternalStoreRuntime({
    messages: runtimeMessages,
    convertMessage: (message) => message,
    setMessages: setLocalMessages,
    onNew,
    onCancel,
    onRefetchThread: conversation ? () => symphony.loadThreadMessages(conversation.id).then(() => undefined) : undefined,
    adapters: { attachments: attachmentAdapter },
    isRunning,
  });

  if (!conversation) return null;

  const live = isRunning || snapshot.agents.some((agent) => isLiveAgentState(agent.state));
  const dataNames = new Set(runtimeMessages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part !== null && typeof part === "object" && "type" in part && part.type === "data" && "name" in part && typeof part.name === "string"
            ? [part.name]
            : [],
        )
      : [],
  ));
  const hasGenerativeData = dataNames.has("generative-ui");
  const hasStructuredData = [...dataNames].some((name) => name !== "generative-ui");

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
      <SidebarInset className="relative flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-background">
        <header className="shrink-0 border-b border-border/55 bg-background">
          <div className="flex h-12 items-center justify-between gap-3 px-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <SidebarTrigger className="-ml-1" />
              {live && (
                <AgentLoader
                  kind={conversation.loader ?? loaderForHarness(snapshot.agents[0]?.harness ?? "pi")}
                  size={14}
                  label={`${conversation.title} active`}
                />
              )}
              <div className="flex min-w-0 items-center gap-2.5">
                <h1 className="truncate text-[13px] font-medium tracking-[-0.01em]">{conversation.title}</h1>
                {conversation.workspacePath ? (
                  <span
                    className="hidden min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground lg:flex"
                    title={conversation.workspacePath}
                  >
                    <span className="h-3 w-px bg-border" aria-hidden="true" />
                    <FolderSimple className="size-3 shrink-0" />
                    <span className="max-w-72 truncate font-mono">{conversation.workspacePath}</span>
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex items-center justify-end gap-0.5">
              <ConnectionBadge />
              {live && (
                <button
                  onClick={() => void onCancel()}
                  className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  aria-label="Stop run"
                  title="Stop run"
                >
                  <Square className="size-3.5 fill-current" />
                </button>
              )}
            </div>
          </div>
          <nav className="flex h-10 items-end gap-1 overflow-x-auto px-3" aria-label="Conversation views">
            {WORKSPACE_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setWorkspaceTab(tab)}
                className={cn(
                  "relative flex h-10 shrink-0 items-center px-3 text-xs font-medium outline-none transition-colors after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-transparent focus-visible:bg-muted/45 focus-visible:ring-1 focus-visible:ring-ring/40",
                  workspaceTab === tab
                    ? "text-foreground after:bg-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-current={workspaceTab === tab ? "page" : undefined}
              >
                {tab}
              </button>
            ))}
          </nav>
        </header>

        {symphony.error && (
          <div className="mx-3 mb-1 flex items-start gap-2 rounded-md border border-border bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1">{symphony.error}</span>
            <button type="button" onClick={symphony.clearError} aria-label="Dismiss error" className="shrink-0 hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {workspaceTab === "Chat" ? (
          <Thread autoFocus={false} components={THREAD_COMPONENTS} />
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
      </SidebarInset>
    </AssistantRuntimeProvider>
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
): readonly ThreadMessageLike[] {
  if (!conversation) return [];
  if (symphony.mode === "preview") return buildPreviewMessages(symphony.snapshot, conversation);
  return toThreadMessages(symphony.envelope.messages.filter((message) => message.threadId === conversation.id));
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
