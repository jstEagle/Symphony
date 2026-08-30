import { createFileRoute } from "@tanstack/react-router";
import { Assistant } from "@/components/symphony/assistant";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    agent: typeof search.agent === "string" && search.agent.trim() ? search.agent : undefined,
    window: typeof search.window === "string" && search.window.trim() ? search.window : undefined,
    conversation: typeof search.conversation === "string" && search.conversation.trim() ? search.conversation : undefined,
  }),
  component: Home,
});

function Home() {
  const { agent, window, conversation } = Route.useSearch();
  return <Assistant popoutAgentId={agent} popoutWindowId={window} conversationId={conversation} />;
}
