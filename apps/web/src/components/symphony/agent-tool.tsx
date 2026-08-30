"use client";

import { CaretDown, Check, FileText, MagnifyingGlass, PencilLine, TerminalWindow, Wrench, XCircle } from "@phosphor-icons/react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { memo } from "react";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { DotmSquare3 } from "@/components/ui/dotm-square-3";
import { DotmCircular5 } from "@/components/ui/dotm-circular-5";
import { DotmTriangle2 } from "@/components/ui/dotm-triangle-2";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { useOptionalSymphony } from "@/components/symphony/context";
import { isActivelyWorkingAgent, loaderForHarness } from "@/lib/symphony/format";
import { cn } from "@/lib/utils";

export const AgentToolFallback: ToolCallMessagePartComponent = (props) => {
  const { toolName, argsText, result, status } = props;
  const args = "args" in props ? props.args : undefined;
  const symphony = useOptionalSymphony();
  const label = toolLabel(toolName);
  const summary = toolSummary(toolName, args, result);
  const agentId = readAgentId(args, result);
  const authoritativeAgent = agentId
    ? symphony?.snapshot.agents.find((agent) => agent.id === agentId)
    : undefined;
  const active = authoritativeAgent
    ? isActivelyWorkingAgent(authoritativeAgent.state)
    : status?.type === "running";
  const failed = status?.type === "incomplete"
    || authoritativeAgent?.state === "failed"
    || authoritativeAgent?.state === "cancelled"
    || authoritativeAgent?.state === "stale";
  const ToolIcon = toolIcon(toolName);

  return (
    <ToolFallback.Root defaultOpen={failed}>
      <CollapsibleTrigger className="group/agent-tool flex min-h-8 w-full origin-left cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm text-muted-foreground transition-[color,background-color,scale] hover:bg-muted/38 hover:text-foreground active:scale-[0.995]">
        {active ? (
          <AgentLoader kind={loaderForTool(toolName, argsText)} size={18} label={`${label} active`} />
        ) : failed ? (
          <XCircle className="size-4 text-destructive" />
        ) : (
          <Check className="size-3.5 text-success" />
        )}
        <ToolIcon className="size-3.5 shrink-0 opacity-70" />
        <span className={cn("min-w-0 flex-1 truncate text-left", active && "shimmer motion-reduce:animate-none")}>
          <b className="font-medium text-foreground/85">{label}</b>
          {summary ? <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">{summary}</span> : null}
        </span>
        <CaretDown className="size-3.5 shrink-0 -rotate-90 opacity-65 transition-transform group-data-open/agent-tool:rotate-0" />
      </CollapsibleTrigger>
      {agentId && symphony && (
        <button
          type="button"
          className="mb-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => symphony.openAgent(agentId)}
        >
          Open agent
        </button>
      )}
      <ToolFallback.Content className="max-h-80 overflow-y-auto">
        <ToolFallback.Error status={status} />
        <ToolFallback.Args argsText={argsText} />
        <ToolFallback.Result result={result} />
      </ToolFallback.Content>
    </ToolFallback.Root>
  );
};

const toolLabels: Record<string, string> = {
  create_agent: "started an agent",
  observe_agent: "observed an agent",
  send_message: "steered an agent",
  list_agents: "checked active agents",
  cancel_agent: "cancelled an agent",
};

function toolLabel(toolName: string): string {
  const normalized = toolName.replace(/^mcp[_\s-]*symphony[_\s-]*/iu, "").replace(/^symphony[_\s-]*/iu, "");
  return toolLabels[normalized]
    ?? ({ bash: "Ran command", command_execution: "Ran command", read: "Read file", grep: "Searched files", glob: "Listed files", file_change: "Changed files", edit: "Edited file", write: "Wrote file", apply_patch: "Applied patch", toolsearch: "Found tools" } as Record<string, string>)[normalized.toLocaleLowerCase()]
    ?? normalized.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function toolIcon(toolName: string) {
  const normalized = toolName.toLocaleLowerCase();
  if (/bash|command|shell|terminal/u.test(normalized)) return TerminalWindow;
  if (/read|file/u.test(normalized) && !/edit|write|patch|change/u.test(normalized)) return FileText;
  if (/grep|glob|search|find|list/u.test(normalized)) return MagnifyingGlass;
  if (/edit|write|patch|change/u.test(normalized)) return PencilLine;
  return Wrench;
}

export const AgentLoader = memo(function AgentLoader({
  kind,
  size = 18,
  label = "Agent active",
  animated = true,
  tone = "default",
}: {
  kind: "square" | "circular" | "triangle";
  size?: number;
  label?: string;
  animated?: boolean;
  tone?: "default" | "info" | "success" | "warning" | "danger";
}) {
  const colors = {
    default: "currentColor",
    info: "var(--color-info)",
    success: "var(--color-success)",
    warning: "var(--color-warning)",
    danger: "var(--color-destructive)",
  } as const;
  const shared = {
    size,
    color: colors[tone],
    ariaLabel: label,
    className: "shrink-0 text-primary",
    animated,
  };

  if (kind === "triangle") return <DotmTriangle2 {...shared} dotSize={size <= 18 ? 2.4 : 3.2} />;
  if (kind === "circular") return <DotmCircular5 {...shared} dotSize={size <= 18 ? 2.5 : 3.4} />;
  return <DotmSquare3 {...shared} dotSize={size <= 18 ? 2.4 : 3.2} />;
});

function loaderForTool(toolName: string, argsText?: string) {
  if (toolName === "observe_agent") return "triangle" as const;
  if (toolName === "list_agents") return "circular" as const;
  if (argsText) {
    const harness = /claude|codex|cursor|opencode|pi/i.exec(argsText)?.[0];
    if (harness) return loaderForHarness(harness);
  }
  return "square" as const;
}

function readAgentId(args: unknown, result: unknown): string | undefined {
  const fromResult = recordString(result, "agentId");
  if (fromResult) return fromResult;
  return recordString(args, "agentId");
}

function toolSummary(toolName: string, args: unknown, result: unknown): string | undefined {
  if (toolName === "create_agent") return recordString(args, "objective");
  if (toolName === "observe_agent") return recordString(result, "summary") ?? recordString(args, "granularity");
  if (toolName === "send_message") return recordString(args, "message");
  if (toolName === "cancel_agent") return recordString(args, "agentId");
  const target = ["path", "file_path", "filePath", "query", "pattern", "command"]
    .map((key) => recordString(args, key))
    .find(Boolean);
  return target ? clip(target) : undefined;
}

function clip(value: string): string { const normalized = value.replace(/\s+/gu, " ").trim(); return normalized.length > 78 ? `${normalized.slice(0, 75)}…` : normalized; }

function recordString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}
