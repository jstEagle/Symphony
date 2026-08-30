"use client";

import type { ReactNode } from "react";
import type { PluginSlotName } from "@/lib/symphony/contracts";
import { useOptionalSymphony } from "@/components/symphony/context";

export function PluginSlot({
  name,
  children,
}: {
  name: PluginSlotName;
  children?: ReactNode;
}) {
  const symphony = useOptionalSymphony();
  const plugins = symphony?.envelope.plugins.filter((plugin) => plugin.status === "active") ?? [];

  if (name === "sidebar.footer" && plugins.length > 0) {
    return (
      <p className="px-2 py-1 text-[10px] text-muted-foreground">
        {plugins.length} plugin{plugins.length === 1 ? "" : "s"} active
      </p>
    );
  }

  if (name === "settings.panel") {
    return children ?? null;
  }

  return children ?? null;
}
