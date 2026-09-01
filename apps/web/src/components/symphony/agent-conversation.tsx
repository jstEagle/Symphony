"use client";

import {
  AssistantRuntimeProvider,
  type AppendMessage,
  type ThreadMessageLike,
  useExternalMessageConverter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { AgentLoader, AgentToolFallback } from "@/components/symphony/agent-tool";
import type { AgentDetail, ConversationMessage, EventEnvelope } from "@/lib/symphony/contracts";
import { isActivelyWorkingAgent, loaderForHarness } from "@/lib/symphony/format";
import {
  conversationTranscriptSignature,
  extractText,
  removeThreadMessage,
  toThreadMessages,
} from "@/lib/symphony/messages";

const THREAD_COMPONENTS = { ToolFallback: AgentToolFallback };

export function AgentConversation({
  detail,
  loadMessages,
  subscribeToAgent,
  onSteer,
  onCancel,
}: {
  detail: AgentDetail;
  loadMessages: (agentId: string) => Promise<ConversationMessage[]>;
  subscribeToAgent?: (
    agentId: string,
    onEvent: (event: EventEnvelope) => void,
    onReset?: () => void,
    onConnection?: (state: "connecting" | "live" | "stale") => void,
  ) => () => void;
  onSteer: (agentId: string, content: string) => Promise<void>;
  onCancel: (agentId: string) => Promise<void>;
}) {
  const [messages, setMessages] = useState<readonly ThreadMessageLike[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<"connecting" | "live" | "stale">("connecting");
  const refreshInFlight = useRef(false);
  const refreshTimer = useRef<number | null>(null);
  const transcriptSignature = useRef("");
  const live = isActivelyWorkingAgent(detail.state);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const next = await loadMessages(detail.id);
      const signature = conversationTranscriptSignature(next);
      if (signature !== transcriptSignature.current) {
        transcriptSignature.current = signature;
        setMessages(toThreadMessages(next));
      }
      setLoaded(true);
      setError(null);
    } catch (cause) {
      setLoaded(true);
      setError(cause instanceof Error ? cause.message : "The agent transcript could not be loaded.");
    } finally {
      refreshInFlight.current = false;
    }
  }, [detail.id, loadMessages]);

  useEffect(() => {
    setMessages([]);
    transcriptSignature.current = "";
    setLoaded(false);
    setError(null);
    setStreamState("connecting");
    void refresh();
    if (!subscribeToAgent) return;
    const scheduleRefresh = () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        void refresh();
      }, 80);
    };
    const unsubscribe = subscribeToAgent(detail.id, scheduleRefresh, scheduleRefresh, setStreamState);
    return () => {
      unsubscribe();
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    };
  }, [detail.id, live, refresh, subscribeToAgent]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const content = extractText(message.content);
    if (!content) return;
    const optimisticId = crypto.randomUUID();
    const optimistic: ThreadMessageLike = {
      id: optimisticId,
      role: "user",
      content: message.content,
      createdAt: new Date(),
    };
    setMessages((current) => [...current, optimistic]);
    setSending(true);
    setError(null);
    try {
      await onSteer(detail.id, content);
      await refresh();
    } catch (cause) {
      const deliveryError = cause instanceof Error ? cause.message : "The message could not be delivered to this agent.";
      setMessages((current) => removeThreadMessage(current, optimisticId));
      await refresh();
      setError(deliveryError);
    } finally {
      setSending(false);
    }
  }, [detail.id, onSteer, refresh]);

  const onCancelRun = useCallback(async () => {
    await onCancel(detail.id);
    await refresh();
  }, [detail.id, onCancel, refresh]);

  const convertedMessages = useExternalMessageConverter({
    messages: [...messages],
    callback: (message: ThreadMessageLike) => message,
    isRunning: live || sending,
    joinStrategy: "none",
  });
  const runtime = useExternalStoreRuntime({
    messages: convertedMessages,
    setMessages,
    onNew,
    onCancel: onCancelRun,
    onRefetchThread: () => refresh().then(() => undefined),
    isRunning: live || sending,
  });
  const loader = useMemo(() => loaderForHarness(detail.harness), [detail.harness]);

  if (!loaded) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <AgentLoader kind={loader} size={18} label={`Loading ${detail.name}`} />
          Loading native transcript…
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {error ? (
        <div className="absolute inset-x-4 top-3 z-10 rounded-lg border border-destructive/25 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm backdrop-blur">
          {error}
        </div>
      ) : null}
      {streamState === "stale" ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-warning/20 bg-warning/6 px-3 py-2 text-[10px] text-warning">
          <AgentLoader kind={loader} size={13} label="Reconnecting agent transcript" tone="warning" />
          Reconnecting to the durable transcript…
        </div>
      ) : null}
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread autoFocus={false} components={THREAD_COMPONENTS} />
      </AssistantRuntimeProvider>
    </div>
  );
}
