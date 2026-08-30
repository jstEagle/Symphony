"use client";

import { memo, useDeferredValue, useMemo, useState, type FormEvent } from "react";
import {
  Archive,
  Bell,
  CaretDown,
  ChartBar,
  DotsThree,
  FolderSimple,
  FolderSimplePlus,
  Gear,
  MagnifyingGlass,
  PencilSimple,
  PencilSimpleLine,
  Plus,
  PushPin,
} from "@phosphor-icons/react";
import { PluginSlot } from "@/components/symphony/plugin-slots";
import type {
  ConversationDirectory,
  ConversationGroup,
  ConversationSummary,
} from "@/lib/symphony/contracts";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";

type ConversationSidebarProps = {
  directory: ConversationDirectory;
  activeConversationId: string;
  runCost: number;
  unreadInbox?: number;
  onSelectConversation: (id: string) => void;
  onNewConversation: (groupId: string) => void;
  onCreateGroup: (title: string) => void;
  onMoveConversation: (conversationId: string, groupId: string) => void;
  onTogglePinned: (conversationId: string) => void;
  onRenameConversation?: (conversationId: string, title: string) => void;
  onArchiveConversation?: (conversationId: string) => void;
  onOpenSettings?: () => void;
  onOpenUsage?: () => void;
  onOpenInbox?: () => void;
};

export const ConversationSidebar = memo(function ConversationSidebar({
  directory,
  activeConversationId,
  runCost,
  unreadInbox = 0,
  onSelectConversation,
  onNewConversation,
  onCreateGroup,
  onMoveConversation,
  onTogglePinned,
  onRenameConversation,
  onArchiveConversation,
  onOpenSettings,
  onOpenUsage,
  onOpenInbox,
}: ConversationSidebarProps) {
  const [query, setQuery] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const { isMobile, setOpenMobile } = useSidebar();

  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const { pinned, visibleGroups } = useMemo(() => {
    const matches = (conversation: ConversationSummary) =>
      normalizedQuery.length === 0 ||
      conversation.title.toLowerCase().includes(normalizedQuery);
    const nextPinned = directory.groups
      .flatMap((group) => group.conversations)
      .filter((item) => item.pinned && matches(item));
    const nextGroups = directory.groups
      .map((group) => ({
        ...group,
        conversations: group.conversations.filter(
          (conversation) => !conversation.pinned && matches(conversation),
        ),
      }))
      .filter(
        (group) =>
          normalizedQuery.length === 0 ||
          group.title.toLowerCase().includes(normalizedQuery) ||
          group.conversations.length > 0,
      );
    return { pinned: nextPinned, visibleGroups: nextGroups };
  }, [directory.groups, normalizedQuery]);

  const activeConversation = directory.groups
    .flatMap((group) => group.conversations)
    .find((conversation) => conversation.id === activeConversationId);
  const defaultGroupId = activeConversation?.groupId ?? directory.groups[0]?.id;

  const selectConversation = (id: string) => {
    onSelectConversation(id);
    if (isMobile) setOpenMobile(false);
  };

  const createConversation = (groupId: string) => {
    setCollapsedGroupIds((current) => {
      if (!current.has(groupId)) return current;
      const next = new Set(current);
      next.delete(groupId);
      return next;
    });
    onNewConversation(groupId);
    if (isMobile) setOpenMobile(false);
  };

  const toggleGroup = (groupId: string) => {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  return (
    <>
      <Sidebar collapsible="offcanvas" className="border-sidebar-border bg-sidebar">
        <SidebarHeader className="gap-1.5 border-b border-sidebar-border/60 p-2">
          <div className="flex items-center gap-1">
            <SidebarMenu className="min-w-0 flex-1">
              <SidebarMenuItem>
              <SidebarMenuButton
                type="button"
                size="sm"
                className="h-7 font-medium"
                onClick={() => createConversation(defaultGroupId ?? "inbox")}
              >
                <PencilSimpleLine />
                <span>New chat</span>
              </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7 shrink-0 text-muted-foreground"
              onClick={() => setCreateGroupOpen(true)}
              aria-label="New group"
              title="New group"
            >
              <FolderSimplePlus />
            </Button>
          </div>
          <div className="relative">
            <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="h-7 rounded-md border-transparent bg-sidebar-accent/40 pl-7 text-xs shadow-none focus-visible:border-sidebar-border focus-visible:ring-0"
            />
          </div>
        </SidebarHeader>

        <SidebarContent className="py-1">
          {pinned.length > 0 && (
            <SidebarGroup className="px-1 py-0.5">
              <SidebarGroupLabel className="h-6 px-2 text-[10px] font-normal uppercase tracking-wide text-muted-foreground/65">
                <span className="min-w-0 flex-1">Pinned</span>
                <span className="tabular-nums">{pinned.length}</span>
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {pinned.map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      groups={directory.groups}
                      active={conversation.id === activeConversationId}
                      onSelect={selectConversation}
                      onMove={onMoveConversation}
                      onTogglePinned={onTogglePinned}
                      onRename={onRenameConversation ? () => setRenameId(conversation.id) : undefined}
                      onArchive={onArchiveConversation}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          {pinned.length > 0 && <SidebarSeparator className="my-0.5 opacity-50" />}

          {visibleGroups.map((group) => {
            const collapsed = normalizedQuery.length === 0 && collapsedGroupIds.has(group.id);
            return (
              <Collapsible
                key={group.id}
                open={!collapsed}
                onOpenChange={() => toggleGroup(group.id)}
              >
                <SidebarGroup className="group/project px-1 py-0.5">
                  <div className="flex h-6 items-center gap-0.5 px-1">
                    <CollapsibleTrigger className="group/group flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground">
                      <CaretDown className="size-3 shrink-0 transition-transform group-data-[state=closed]/group:-rotate-90" />
                      <FolderSimple className="size-3 shrink-0 opacity-70" />
                      <span className="min-w-0 flex-1 truncate">{group.title}</span>
                      <span className="shrink-0 text-[9px] font-normal tabular-nums text-muted-foreground/55">
                        {group.conversations.length}
                      </span>
                    </CollapsibleTrigger>
                    <button
                      type="button"
                      onClick={() => createConversation(group.id)}
                      className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 group-hover/project:opacity-100"
                      aria-label={`New chat in ${group.title}`}
                      title={`New chat in ${group.title}`}
                    >
                      <Plus className="size-3" />
                    </button>
                  </div>
                  <CollapsibleContent>
                    <SidebarGroupContent>
                      {group.conversations.length > 0 ? (
                        <SidebarMenu>
                          {group.conversations.map((conversation) => (
                            <ConversationRow
                              key={conversation.id}
                              conversation={conversation}
                              groups={directory.groups}
                              active={conversation.id === activeConversationId}
                              onSelect={selectConversation}
                              onMove={onMoveConversation}
                              onTogglePinned={onTogglePinned}
                              onRename={onRenameConversation ? () => setRenameId(conversation.id) : undefined}
                              onArchive={onArchiveConversation}
                            />
                          ))}
                        </SidebarMenu>
                      ) : (
                        <p className="px-8 py-1 text-[10px] text-muted-foreground/50">
                          {normalizedQuery ? "No matching chats" : "No chats yet"}
                        </p>
                      )}
                    </SidebarGroupContent>
                  </CollapsibleContent>
                </SidebarGroup>
              </Collapsible>
            );
          })}

          {normalizedQuery && pinned.length === 0 && visibleGroups.length === 0 && (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">No chats found</p>
          )}
        </SidebarContent>

        <SidebarFooter className="gap-1 border-t border-sidebar-border/60 p-1.5">
          <PluginSlot name="sidebar.footer" />
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center">
              <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={onOpenSettings}>
                <Gear />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Usage" onClick={onOpenUsage}>
                <ChartBar />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Inbox" onClick={onOpenInbox} className="relative">
                <Bell />
                {unreadInbox > 0 && (
                  <span className="absolute top-1 right-1 size-1 rounded-full bg-foreground" />
                )}
              </Button>
            </div>
            <span className="px-2 text-[11px] tabular-nums text-muted-foreground">
              ${runCost.toFixed(2)}
            </span>
          </div>
        </SidebarFooter>
      </Sidebar>

      <CreateGroupDialog
        open={createGroupOpen}
        onOpenChange={setCreateGroupOpen}
        onCreate={onCreateGroup}
      />
      <RenameDialog
        key={renameId ?? "closed"}
        open={renameId !== null}
        title={directory.groups.flatMap((group) => group.conversations).find((item) => item.id === renameId)?.title ?? ""}
        onOpenChange={(open) => {
          if (!open) setRenameId(null);
        }}
        onRename={(title) => {
          if (renameId) onRenameConversation?.(renameId, title);
          setRenameId(null);
        }}
      />
    </>
  );
});

function ConversationRow({
  conversation,
  groups,
  active,
  onSelect,
  onMove,
  onTogglePinned,
  onRename,
  onArchive,
}: {
  conversation: ConversationSummary;
  groups: ConversationGroup[];
  active: boolean;
  onSelect: (id: string) => void;
  onMove: (conversationId: string, groupId: string) => void;
  onTogglePinned: (conversationId: string) => void;
  onRename?: () => void;
  onArchive?: (conversationId: string) => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        size="sm"
        onClick={() => onSelect(conversation.id)}
        className="group/chat-row h-7 gap-1.5 px-2 pr-7 text-[12px] data-active:bg-sidebar-accent/80 data-active:font-medium"
        tooltip={conversation.title}
      >
        {conversation.state === "running" ? (
          <AgentLoader
            kind={conversation.loader ?? "square"}
            size={12}
            label={`${conversation.title} active`}
          />
        ) : null}
        <span
          className={`min-w-0 flex-1 truncate ${conversation.state === "idle" ? "text-sidebar-foreground/55" : ""}`}
        >
          {conversation.title}
        </span>
        {conversation.pinned && <PushPin className="size-2.5 shrink-0 text-muted-foreground/65" />}
        {conversation.state !== "running" && !conversation.pinned && (
          <span className="w-7 shrink-0 truncate text-right text-[9px] tabular-nums text-muted-foreground/50 group-hover/chat-row:opacity-0">
            {conversation.updatedLabel}
          </span>
        )}
      </SidebarMenuButton>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="absolute top-1 right-1 grid size-5 place-items-center rounded-md text-muted-foreground opacity-0 outline-none hover:bg-sidebar-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring group-hover/menu-item:opacity-100 data-popup-open:opacity-100"
              aria-label={`Chat options for ${conversation.title}`}
            />
          }
        >
          <DotsThree className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-44">
          <DropdownMenuCheckboxItem
            checked={conversation.pinned}
            onClick={() => onTogglePinned(conversation.id)}
          >
            Pinned
          </DropdownMenuCheckboxItem>
          {onRename && (
            <DropdownMenuItem onClick={onRename}>
              <PencilSimple className="size-3.5" />
              Rename
            </DropdownMenuItem>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Move to group</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44">
              <DropdownMenuLabel>Groups</DropdownMenuLabel>
              {groups.map((group) => (
                <DropdownMenuItem
                  key={group.id}
                  disabled={group.id === conversation.groupId}
                  onClick={() => onMove(conversation.id, group.id)}
                >
                  <FolderSimple className="size-3.5" />
                  <span className="truncate">{group.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {onArchive && (
            <DropdownMenuItem onClick={() => onArchive(conversation.id)}>
              <Archive className="size-3.5" />
              Archive
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function CreateGroupDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (title: string) => void;
}) {
  const [title, setTitle] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    onCreate(trimmed);
    setTitle("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Group name"
            aria-label="Group name"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim()}>
              Create group
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  open,
  title,
  onOpenChange,
  onRename,
}: {
  open: boolean;
  title: string;
  onOpenChange: (open: boolean) => void;
  onRename: (title: string) => void;
}) {
  const [value, setValue] = useState(title);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onRename(trimmed);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setValue(title);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label="Chat title"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
