"use client";

import { CaretDown, Check, XCircle } from "@phosphor-icons/react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { memo } from "react";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { DotmSquare3 } from "@/components/ui/dotm-square-3";
import { DotmCircular5 } from "@/components/ui/dotm-circular-5";
import { DotmTriangle2 } from "@/components/ui/dotm-triangle-2";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { useOptionalSymphony } from "@/components/symphony/context";
import { loaderForHarness } from "@/lib/symphony/format";
import { cn } from "@/lib/utils";

export const AgentToolFallback: ToolCallMessagePartComponent = (props) => {
  const { toolName, argsText, result, status } = props;
  const args = "args" in props ? props.args : undefined;
  const symphony = useOptionalSymphony();
  const resultState = readResultState(result);
  const active = status?.type === "running" || resultState === "running";
  const failed = status?.type === "incomplete";
  const label = toolLabels[toolName] ?? toolName.replaceAll("_", " ");
  const summary = toolSummary(toolName, args, result);
  const agentId = readAgentId(args, result);

  return (
    <ToolFallback.Root defaultOpen={failed}>
      <CollapsibleTrigger className="group/agent-tool flex w-fit origin-left items-center gap-2 py-1.5 text-sm text-muted-foreground transition hover:text-foreground active:scale-[0.98]">
        {active ? (
          <AgentLoader kind={loaderForTool(toolName, argsText)} size={18} label={`${label} active`} />
        ) : failed ? (
          <XCircle className="size-4 text-destructive" />
        ) : (
          <Check className="size-4" />
        )}
        <span className={cn(active && "shimmer motion-reduce:animate-none")}>
          {active ? "Working: " : ""}
          <b>{label}</b>
          {summary ? <span className="font-normal"> · {summary}</span> : null}
        </span>
        <CaretDown className="size-4 -rotate-90 transition-transform group-data-open/agent-tool:rotate-0" />
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
      <ToolFallback.Content>
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

export const AgentLoader = memo(function AgentLoader({
  kind,
  size = 18,
  label = "Agent active",
}: {
  kind: "square" | "circular" | "triangle";
  size?: number;
  label?: string;
}) {
  const shared = {
    size,
    color: "currentColor",
    ariaLabel: label,
    className: "shrink-0 text-primary",
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

function readResultState(result: unknown) {
  if (typeof result !== "object" || result === null || !("state" in result)) return undefined;
  return (result as { state?: unknown }).state;
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
  return undefined;
}

function recordString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}
