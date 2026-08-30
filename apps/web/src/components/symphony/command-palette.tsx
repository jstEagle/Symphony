"use client";

import { useEffect, useMemo, useRef, useState, type ElementType, type ReactNode } from "react";
import { Archive, Bell, ChartBar, Chats, FolderSimplePlus, Gear, MagnifyingGlass, PencilSimpleLine } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, type DialogHandle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AgentLoader } from "@/components/symphony/agent-tool";
import type { ConversationDirectory } from "@/lib/symphony/contracts";
import { searchChats, type ChatSearchResponse } from "@/lib/symphony/runtime-client";
import { fuzzyScore, rankFuzzyMatches } from "@/lib/symphony/palette-search";

type PaletteAction = { id: string; label: string; detail: string; icon: ElementType; run: () => void };

export function CommandPalette({ open, onOpenChange, handle, directory, defaultGroupId, onSelectConversation, onNewConversation, onCreateGroup, onOpenSettings, onOpenUsage, onOpenInbox }: {
  open: boolean; onOpenChange: (open: boolean) => void; directory: ConversationDirectory; defaultGroupId?: string;
  handle: DialogHandle;
  onSelectConversation: (id: string) => void; onNewConversation: (groupId: string) => void; onCreateGroup: () => void;
  onOpenSettings?: () => void; onOpenUsage?: () => void; onOpenInbox?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<ChatSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchUnavailable, setSearchUnavailable] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchGeneration = useRef(0);
  const allChats = useMemo(() => directory.groups.flatMap((group) => group.conversations.map((conversation) => ({ conversation, group: group.title }))), [directory.groups]);
  const allChatsById = useMemo(
    () => new Map(allChats.map((item) => [item.conversation.id, item])),
    [allChats],
  );
  const actions = useMemo<PaletteAction[]>(() => [
    { id: "new-chat", label: "New chat", detail: "Start a conversation in the current project", icon: PencilSimpleLine, run: () => onNewConversation(defaultGroupId ?? directory.groups[0]?.id ?? "inbox") },
    { id: "new-group", label: "New group", detail: "Create a sidebar group", icon: FolderSimplePlus, run: onCreateGroup },
    ...(onOpenSettings ? [{ id: "settings", label: "Open settings", detail: "Harnesses, models, access, and limits", icon: Gear, run: onOpenSettings }] : []),
    ...(onOpenUsage ? [{ id: "usage", label: "Open usage", detail: "Costs and activity heatmap", icon: ChartBar, run: onOpenUsage }] : []),
    ...(onOpenInbox ? [{ id: "inbox", label: "Open inbox", detail: "Notifications and agent attention", icon: Bell, run: onOpenInbox }] : []),
  ], [defaultGroupId, directory.groups, onCreateGroup, onNewConversation, onOpenInbox, onOpenSettings, onOpenUsage]);

  useEffect(() => {
    const generation = ++searchGeneration.current;
    if (!open) { setQuery(""); setSearch(null); setLoading(false); setSearchUnavailable(false); setActiveIndex(0); return; }
    const normalized = query.trim();
    if (normalized.length < 2) { setSearch(null); setLoading(false); setSearchUnavailable(false); return; }
    setSearch(null);
    setSearchUnavailable(false);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void searchChats(normalized, controller.signal)
        .then((result) => {
          if (searchGeneration.current === generation) {
            setSearch(result);
            setSearchUnavailable(false);
          }
        })
        .catch(() => {
          if (searchGeneration.current === generation && !controller.signal.aborted) {
            setSearch(null);
            setSearchUnavailable(true);
          }
        })
        .finally(() => {
          if (searchGeneration.current === generation) setLoading(false);
        });
    }, 220);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, query]);

  const normalized = query.trim().toLocaleLowerCase();
  const visibleActions = actions.filter((action) => !normalized || fuzzyScore(normalized, `${action.label} ${action.detail}`) > 0);
  const remoteById = new Map(search?.results.map((result) => [result.threadId, result]) ?? []);
  const visibleChats = (search?.results.length
    ? search.results.flatMap((result) => { const match = allChatsById.get(result.threadId); return match ? [{ ...match, snippet: result.snippet }] : []; })
    : rankFuzzyMatches(allChats, normalized, (item) => `${item.conversation.title} ${item.group}`)
      .map((item) => ({ ...item, snippet: "" }))).slice(0, 24);
  const items = [
    ...visibleActions.map((action) => ({ run: action.run })),
    ...visibleChats.map((item) => ({ run: () => onSelectConversation(item.conversation.id) })),
  ];
  const execute = (run: () => void) => { onOpenChange(false); run(); };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} handle={handle}>
      <DialogContent className="top-[12vh] max-h-[min(42rem,76dvh)] translate-y-0 overflow-hidden border-border/70 bg-popover/88 p-0 shadow-2xl backdrop-blur-2xl sm:max-w-xl">
        <DialogHeader className="sr-only"><DialogTitle>Symphony command palette</DialogTitle></DialogHeader>
        <div className="flex h-12 items-center gap-2 border-b border-border/55 px-3">
          {loading ? <AgentLoader kind="circular" size={15} label="Searching chats" /> : <MagnifyingGlass className="size-4 text-muted-foreground" />}
          <Input autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((current) => Math.min(Math.max(0, items.length - 1), current + 1)); }
              else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => Math.max(0, current - 1)); }
              else if (event.key === "Enter" && items[activeIndex]) { event.preventDefault(); execute(items[activeIndex].run); }
            }}
            placeholder="Search chats or run a command…" aria-label="Command palette"
            className="h-11 flex-1 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0" />
          <kbd className="rounded border border-border/60 bg-muted/45 px-1.5 py-0.5 text-[9px] text-muted-foreground">esc</kbd>
        </div>
        <div className="min-h-0 overflow-y-auto p-2">
          {searchUnavailable ? (
            <div role="status" className="mx-2 mb-1 rounded-md bg-warning/8 px-2.5 py-2 text-[10px] text-warning">
              Semantic search is unavailable. Showing local fuzzy matches instead.
            </div>
          ) : null}
          {visibleActions.length > 0 ? <PaletteSection label="Actions">{visibleActions.map((action, index) => <PaletteButton key={action.id} active={activeIndex === index} icon={action.icon} label={action.label} detail={action.detail} onClick={() => execute(action.run)} />)}</PaletteSection> : null}
          {visibleChats.length > 0 ? <PaletteSection label="Chats" meta={search ? (search.method === "openrouter-rerank" ? "Semantic" : "Fuzzy") : undefined}>{visibleChats.map((item, index) => {
            const result = remoteById.get(item.conversation.id);
            return <PaletteButton key={item.conversation.id} active={activeIndex === visibleActions.length + index} icon={Chats} label={item.conversation.title} detail={item.snippet || item.group}
              meta={result && search?.method === "openrouter-rerank" ? `${Math.round(result.score * 100)}%` : item.conversation.updatedLabel}
              onClick={() => execute(() => onSelectConversation(item.conversation.id))} />;
          })}</PaletteSection> : null}
          {!loading && visibleActions.length === 0 && visibleChats.length === 0 ? <div className="grid min-h-36 place-items-center px-6 text-center text-xs text-muted-foreground"><div><Archive className="mx-auto mb-2 size-5" />No matching command or chat</div></div> : null}
        </div>
        <div className="flex items-center justify-between border-t border-border/45 px-3 py-2 text-[9px] text-muted-foreground"><span>↑↓ navigate · ↵ run</span><span>{searchUnavailable ? "Local fuzzy fallback" : search?.method === "openrouter-rerank" ? "OpenRouter rerank" : "Local fuzzy search"}</span></div>
      </DialogContent>
    </Dialog>
  );
}

function PaletteSection({ label, meta, children }: { label: string; meta?: string; children: ReactNode }) {
  return <section className="mb-2 last:mb-0"><div className="flex h-7 items-center justify-between px-2 text-[9px] uppercase tracking-[0.12em] text-muted-foreground/70"><span>{label}</span>{meta ? <span>{meta}</span> : null}</div><div className="space-y-0.5">{children}</div></section>;
}
function PaletteButton({ active, icon: Icon, label, detail, meta, onClick }: { active: boolean; icon: ElementType; label: string; detail: string; meta?: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}><span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/55 text-muted-foreground"><Icon className="size-3.5" /></span><span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-medium">{label}</span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{detail}</span></span>{meta ? <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">{meta}</span> : null}</button>;
}
