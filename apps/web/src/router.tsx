import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { AgentLoader } from "@/components/symphony/agent-tool";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPendingComponent: RouterPending,
  });
}

function RouterPending() {
  return (
    <div className="grid h-dvh place-items-center bg-background text-sm text-muted-foreground">
      <div className="flex items-center gap-2">
        <AgentLoader kind="circular" size={18} label="Loading Symphony" />
        <span>Loading Symphony…</span>
      </div>
    </div>
  );
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
