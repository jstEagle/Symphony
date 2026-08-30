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
import type { AgentDetail, ConversationMessage } from "@/lib/symphony/contracts";
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
  onSteer,
  onCancel,
}: {
  detail: AgentDetail;
  loadMessages: (agentId: string) => Promise<ConversationMessage[]>;
  onSteer: (agentId: string, content: string) => Promise<void>;
  onCancel: (agentId: string) => Promise<void>;
}) {
  const [messages, setMessages] = useState<readonly ThreadMessageLike[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlight = useRef(false);
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
    void refresh();
    if (!live) return;
    const interval = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(interval);
  }, [detail.id, live, refresh]);

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
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread autoFocus={false} components={THREAD_COMPONENTS} />
      </AssistantRuntimeProvider>
    </div>
  );
}
