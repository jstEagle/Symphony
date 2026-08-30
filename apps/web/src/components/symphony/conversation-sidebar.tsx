"use client";

import { memo, useMemo, useState, type DragEvent, type FormEvent } from "react";
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
  PushPinSlash,
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
  DialogTrigger,
  type DialogHandle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  readConversationOrder,
  readPinnedConversationOrder,
  writeConversationOrder,
  writePinnedConversationOrder,
} from "@/lib/symphony/ui-prefs";
import {
  currentConversationOrder,
  moveIdBefore,
  orderGroupConversations,
  orderPinnedConversations,
} from "@/lib/symphony/sidebar-order";
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
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
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
  commandPaletteHandle: DialogHandle;
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
  commandPaletteHandle,
}: ConversationSidebarProps) {
  const [renameId, setRenameId] = useState<string | null>(null);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [conversationOrder, setConversationOrder] = useState<string[]>(() => readConversationOrder());
  const [pinnedOrder, setPinnedOrder] = useState<string[]>(() => readPinnedConversationOrder());
  const [draggingConversationId, setDraggingConversationId] = useState<string | null>(null);
  const { isMobile, setOpenMobile } = useSidebar();

  const normalizedQuery = "";
  const { pinned, visibleGroups } = useMemo(() => {
    const matches = (conversation: ConversationSummary) =>
      normalizedQuery.length === 0 ||
      conversation.title.toLowerCase().includes(normalizedQuery);
    const nextPinned = orderPinnedConversations(
      directory.groups
        .flatMap((group) => group.conversations)
        .filter((item) => item.pinned && matches(item)),
      pinnedOrder,
    );
    const nextGroups = directory.groups
      .map((group) => ({
        ...group,
        conversations: orderGroupConversations(
          group.conversations.filter((conversation) => !conversation.pinned && matches(conversation)),
          conversationOrder,
        ),
      }))
      .filter(
        (group) =>
          normalizedQuery.length === 0 ||
          group.title.toLowerCase().includes(normalizedQuery) ||
          group.conversations.length > 0,
      );
    return { pinned: nextPinned, visibleGroups: nextGroups };
  }, [conversationOrder, directory.groups, normalizedQuery, pinnedOrder]);

  const commitConversationOrder = (ids: string[]) => {
    setConversationOrder(ids);
    writeConversationOrder(ids);
  };

  const commitPinnedOrder = (ids: string[]) => {
    setPinnedOrder(ids);
    writePinnedConversationOrder(ids);
  };

  const dropConversation = (conversationId: string, groupId: string, beforeId?: string) => {
    const current = directory.groups.find((candidate) => candidate.conversations.some((item) => item.id === conversationId));
    const dragged = current?.conversations.find((item) => item.id === conversationId);
    if (!current || dragged?.pinned) {
      setDraggingConversationId(null);
      return;
    }
    const order = currentConversationOrder(directory.groups, conversationOrder).filter((id) => id !== conversationId);
    const group = directory.groups.find((candidate) => candidate.id === groupId);
    const beforeIndex = beforeId ? order.indexOf(beforeId) : -1;
    const targetIds = orderGroupConversations(
      (group?.conversations ?? []).filter((item) => item.id !== conversationId && !item.pinned),
      conversationOrder,
    ).map((item) => item.id);
    const lastTargetIndex = targetIds.reduce((last, id) => Math.max(last, order.indexOf(id)), -1);
    const insertAt = beforeIndex >= 0 ? beforeIndex : lastTargetIndex >= 0 ? lastTargetIndex + 1 : order.length;
    order.splice(insertAt, 0, conversationId);
    commitConversationOrder(order);
    if (current?.id !== groupId) onMoveConversation(conversationId, groupId);
    setDraggingConversationId(null);
  };

  const dropPinnedConversation = (conversationId: string, beforeId?: string) => {
    const pinnedIds = orderPinnedConversations(
      directory.groups.flatMap((group) => group.conversations).filter((item) => item.pinned),
      pinnedOrder,
    ).map((item) => item.id);
    if (!pinnedIds.includes(conversationId)) {
      setDraggingConversationId(null);
      return;
    }
    commitPinnedOrder(moveIdBefore(pinnedIds, conversationId, beforeId));
    setDraggingConversationId(null);
  };

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

  const setGroupOpen = (groupId: string, open: boolean) => {
    setCollapsedGroupIds((current) => {
      const currentlyOpen = !current.has(groupId);
      if (currentlyOpen === open) return current;
      const next = new Set(current);
      if (open) next.delete(groupId);
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
            <SidebarTrigger
              className="size-7 shrink-0 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            />
          </div>
          <DialogTrigger
            handle={commandPaletteHandle}
            aria-label="Open command palette"
            render={<button type="button" />}
            className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md bg-sidebar-accent/40 px-2 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <MagnifyingGlass className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Search or run a command</span>
            <kbd className="text-[8px] text-muted-foreground/60">⌘K</kbd>
          </DialogTrigger>
        </SidebarHeader>

        <SidebarContent className="py-1">
          {pinned.length > 0 && (
            <SidebarGroup className="px-2 py-1">
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
                      dragging={draggingConversationId === conversation.id}
                      onDragStart={setDraggingConversationId}
                      onDropConversation={(draggedId) => dropPinnedConversation(draggedId, conversation.id)}
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
                onOpenChange={(open) => setGroupOpen(group.id, open)}
              >
                <SidebarGroup className="group/project px-2 py-1">
                  <div
                    className="flex h-6 items-center gap-0.5 rounded-md px-1 transition-colors data-[drag-over=true]:bg-sidebar-accent/70"
                    onDragOver={(event) => {
                      if (!draggingConversationId) return;
                      event.preventDefault();
                      event.currentTarget.dataset.dragOver = "true";
                    }}
                    onDragLeave={(event) => { delete event.currentTarget.dataset.dragOver; }}
                    onDrop={(event) => {
                      event.preventDefault();
                      delete event.currentTarget.dataset.dragOver;
                      if (draggingConversationId) dropConversation(draggingConversationId, group.id);
                    }}
                  >
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
                  <CollapsibleContent className="data-open:pb-3">
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
                              dragging={draggingConversationId === conversation.id}
                              onDragStart={setDraggingConversationId}
                              onDropConversation={(draggedId) => dropConversation(draggedId, group.id, conversation.id)}
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
        <SidebarRail />
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
  dragging,
  onDragStart,
  onDropConversation,
}: {
  conversation: ConversationSummary;
  groups: ConversationGroup[];
  active: boolean;
  onSelect: (id: string) => void;
  onMove: (conversationId: string, groupId: string) => void;
  onTogglePinned: (conversationId: string) => void;
  onRename?: () => void;
  onArchive?: (conversationId: string) => void;
  dragging: boolean;
  onDragStart: (conversationId: string | null) => void;
  onDropConversation: (conversationId: string) => void;
}) {
  return (
    <SidebarMenuItem
      draggable
      aria-grabbed={dragging}
      onDragStart={(event: DragEvent<HTMLLIElement>) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-symphony-conversation", conversation.id);
        onDragStart(conversation.id);
      }}
      onDragEnd={() => onDragStart(null)}
      onDragOver={(event: DragEvent<HTMLLIElement>) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event: DragEvent<HTMLLIElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const id = event.dataTransfer.getData("application/x-symphony-conversation");
        if (id && id !== conversation.id) onDropConversation(id);
      }}
      className={dragging ? "opacity-45" : undefined}
    >
      <SidebarMenuButton
        isActive={active}
        size="sm"
        onClick={() => onSelect(conversation.id)}
        className="group/chat-row h-7 gap-1.5 px-2 pr-12 text-[12px] data-active:bg-sidebar-accent/80 data-active:font-medium"
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
        {conversation.state !== "running" && (
          <span className="w-7 shrink-0 truncate text-right text-[9px] tabular-nums text-muted-foreground/50 group-hover/chat-row:opacity-0">
            {conversation.updatedLabel}
          </span>
        )}
      </SidebarMenuButton>

      <button
        type="button"
        onClick={() => onTogglePinned(conversation.id)}
        className={`group/pin absolute top-1 right-1 grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none transition-[opacity,color,background-color] hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring ${conversation.pinned ? "opacity-100" : "opacity-0 group-hover/menu-item:opacity-100"}`}
        aria-label={conversation.pinned ? `Unpin ${conversation.title}` : `Pin ${conversation.title}`}
        title={conversation.pinned ? "Unpin chat" : "Pin chat"}
      >
        {conversation.pinned ? (
          <>
            <PushPin className="size-3 group-hover/pin:hidden" weight="fill" />
            <PushPinSlash className="hidden size-3 group-hover/pin:block" />
          </>
        ) : (
          <PushPin className="size-3" />
        )}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="absolute top-1 right-6 grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-0 outline-none hover:bg-sidebar-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring group-hover/menu-item:opacity-100 data-popup-open:opacity-100"
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
              <DropdownMenuGroup>
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
              </DropdownMenuGroup>
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

export function CreateGroupDialog({
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
