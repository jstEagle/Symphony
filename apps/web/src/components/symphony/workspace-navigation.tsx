"use client";

import {
  ChatCircleText,
  FlowArrow,
  Graph,
  SquaresFour,
  ListMagnifyingGlass,
  Pulse,
  TreeStructure,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { WORKSPACE_TABS, type WorkspaceTab } from "@/lib/symphony/workspace-tabs";
import { cn } from "@/lib/utils";

export { WORKSPACE_TABS } from "@/lib/symphony/workspace-tabs";
export type { WorkspaceTab } from "@/lib/symphony/workspace-tabs";

const TAB_ICONS: Record<WorkspaceTab, ReactNode> = {
  Chat: <ChatCircleText />,
  Runline: <FlowArrow />,
  ControlRoom: <SquaresFour />,
  Studio: <TreeStructure />,
  Trace: <ListMagnifyingGlass />,
  Graph: <Graph />,
  Activity: <Pulse />,
};

export function WorkspaceNavigation({
  activeTab,
  onTabChange,
}: {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
}) {
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg bg-muted/25 p-0.5"
      role="tablist"
      aria-label="Workspace views"
    >
      {WORKSPACE_TABS.map((tab) => (
        <TooltipIconButton
          key={tab}
          tooltip={tab}
          side="bottom"
          type="button"
          role="tab"
          aria-selected={activeTab === tab}
          onClick={() => onTabChange(tab)}
          className={cn(
            "size-7 cursor-pointer rounded-md p-1.5 text-muted-foreground transition-[background-color,color,transform] hover:bg-background/55 hover:text-foreground active:scale-95",
            activeTab === tab && "bg-foreground text-background shadow-sm hover:bg-foreground hover:text-background",
          )}
        >
          {TAB_ICONS[tab]}
        </TooltipIconButton>
      ))}
    </div>
  );
}
