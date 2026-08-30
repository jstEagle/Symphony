"use client";

import { memo, useEffect, useMemo, useState, type RefObject } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { extractText } from "@/lib/symphony/messages";

export const PromptRail = memo(function PromptRail({
  messages,
  scopeRef,
}: {
  messages: readonly ThreadMessageLike[];
  scopeRef: RefObject<HTMLElement | null>;
}) {
  const prompts = useMemo(
    () => messages.filter((message) => message.role === "user"),
    [messages],
  );
  const [activeIndex, setActiveIndex] = useState(Math.max(0, prompts.length - 1));

  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    const roots = [...scope.querySelectorAll<HTMLElement>("[data-role='user']")];
    if (!roots.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => Math.abs(left.boundingClientRect.top) - Math.abs(right.boundingClientRect.top))[0];
        if (!visible) return;
        const index = roots.indexOf(visible.target as HTMLElement);
        if (index >= 0) setActiveIndex(index);
      },
      { root: scope.querySelector<HTMLElement>("[data-slot='aui_thread-viewport']"), threshold: 0.35 },
    );
    roots.forEach((root) => observer.observe(root));
    return () => observer.disconnect();
  }, [prompts.length, scopeRef]);

  if (prompts.length < 2) return null;

  return (
    <nav
      aria-label="Conversation prompts"
      className="pointer-events-auto absolute left-1 top-16 z-20 flex max-h-[calc(100%-10rem)] w-4 flex-col items-center gap-1.5 overflow-y-auto rounded-md bg-background/22 py-2 opacity-55 backdrop-blur-md transition-opacity hover:opacity-100"
    >
      {prompts.map((prompt, index) => {
        const label = extractText(prompt.content).replace(/\s+/gu, " ").trim() || `Prompt ${index + 1}`;
        return (
          <button
            key={prompt.id ?? index}
            type="button"
            onClick={() => {
              const target = scopeRef.current?.querySelectorAll<HTMLElement>("[data-role='user']")[index];
              target?.scrollIntoView({ behavior: "smooth", block: "start" });
              setActiveIndex(index);
            }}
            className={`h-0.5 min-h-0.5 cursor-pointer rounded-full transition-[width,background-color,opacity] hover:w-3 ${index === activeIndex ? "w-3 bg-foreground opacity-100" : "w-2 bg-muted-foreground opacity-65"}`}
            aria-label={`Go to prompt ${index + 1}: ${label}`}
            title={label}
          />
        );
      })}
    </nav>
  );
}, promptRailPropsEqual);

function promptRailPropsEqual(
  previous: { messages: readonly ThreadMessageLike[]; scopeRef: RefObject<HTMLElement | null> },
  next: { messages: readonly ThreadMessageLike[]; scopeRef: RefObject<HTMLElement | null> },
): boolean {
  if (previous.scopeRef !== next.scopeRef) return false;
  const previousPrompts = previous.messages.filter((message) => message.role === "user");
  const nextPrompts = next.messages.filter((message) => message.role === "user");
  if (previousPrompts.length !== nextPrompts.length) return false;
  return previousPrompts.every((message, index) => {
    const nextMessage = nextPrompts[index];
    return message.id === nextMessage?.id && extractText(message.content) === extractText(nextMessage.content);
  });
}
