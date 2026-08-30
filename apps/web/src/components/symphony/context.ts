"use client";

import { createContext, useContext } from "react";
import type {
  AgentDetail,
  AgentObservation,
  BootstrapEnvelope,
  ChatAttachment,
  ConnectionState,
  ConversationDirectory,
  ConversationSummary,
  EventEnvelope,
  InboxItem,
  ObservationLevel,
  DirectoryListing,
  ProjectRecord,
  RunSnapshot,
  RuntimeSettings,
} from "@/lib/symphony/contracts";
import type { RuntimeMode } from "@/lib/symphony/runtime-client";

export type SymphonyContextValue = {
  ready: boolean;
  error: string | null;
  clearError: () => void;
  mode: RuntimeMode;
  connection: ConnectionState;
  envelope: BootstrapEnvelope;
  runtimeEvents: EventEnvelope[];
  projects: ProjectRecord[];
  directory: ConversationDirectory;
  activeConversation: ConversationSummary | undefined;
  snapshot: RunSnapshot;
  inbox: InboxItem[];
  unreadInbox: number;
  settingsOpen: boolean;
  usageOpen: boolean;
  inboxOpen: boolean;
  selectedAgentId: string | null;
  setSettingsOpen: (open: boolean) => void;
  setUsageOpen: (open: boolean) => void;
  setInboxOpen: (open: boolean) => void;
  selectConversation: (id: string) => void;
  createConversation: (input: { projectId?: string; groupId?: string; workspacePath?: string }) => Promise<void>;
  createProject: (input: { workspacePath: string; title?: string }) => Promise<ProjectRecord>;
  browseDirectories: (path?: string) => Promise<DirectoryListing>;
  createGroup: (title: string) => void;
  moveConversation: (conversationId: string, groupId: string) => Promise<void>;
  togglePinned: (conversationId: string) => void;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  archiveConversation: (conversationId: string) => Promise<void>;
  sendMessage: (threadId: string, input: { messageId: string; content: string; attachments: ChatAttachment[] }) => Promise<void>;
  saveSettings: (patch: Partial<Pick<RuntimeSettings, "conductor" | "agents">>) => Promise<void>;
  updateHarness: (driver: string) => Promise<void>;
  cancelRun: () => Promise<void>;
  openAgent: (id: string | null) => void;
  agentDetail: (id: string) => AgentDetail | null;
  observe: (agentId: string, level: ObservationLevel) => Promise<AgentObservation>;
  steer: (agentId: string, content: string) => Promise<void>;
  cancelOne: (agentId: string) => Promise<void>;
  markInboxRead: (id: string) => void;
  loadThreadMessages: (threadId: string) => Promise<BootstrapEnvelope["messages"]>;
};

export const SymphonyContext = createContext<SymphonyContextValue | null>(null);

export function useSymphony(): SymphonyContextValue {
  const value = useContext(SymphonyContext);
  if (!value) throw new Error("useSymphony must be used within SymphonyProvider");
  return value;
}

export function useOptionalSymphony(): SymphonyContextValue | null {
  return useContext(SymphonyContext);
}
