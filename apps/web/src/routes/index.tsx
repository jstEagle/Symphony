import { createFileRoute } from "@tanstack/react-router";
import { Assistant } from "@/components/symphony/assistant";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <Assistant />;
}
