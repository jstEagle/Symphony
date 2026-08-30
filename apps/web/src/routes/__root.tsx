import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IconContext } from "@phosphor-icons/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { defaultTheme, themeStyle, ThemeRuntime } from "@/lib/theme";
import type { ReactNode } from "react";
import { useState } from "react";
import "@/styles.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Symphony" },
      {
        name: "description",
        content: "A local chat interface for orchestrating, observing, and steering native coding agents.",
      },
      { name: "theme-color", content: defaultTheme.colors.background },
    ],
    links: [
      { rel: "icon", href: "/v1/theme/icon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/v1/theme/icon.svg" },
    ],
  }),
  component: RootComponent,
  pendingComponent: ShellPending,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <html lang="en" className="dark antialiased" style={themeStyle(defaultTheme)} data-theme={defaultTheme.name}>
      <head>
        <HeadContent />
      </head>
      <body className="bg-background text-foreground">
        <ThemeRuntime />
        <QueryClientProvider client={queryClient}>
          <IconContext.Provider value={{ size: 16, weight: "light" }}>
            <TooltipProvider>{children}</TooltipProvider>
          </IconContext.Provider>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}

function ShellPending() {
  return (
    <div className="grid h-dvh place-items-center bg-background text-sm text-muted-foreground">
      <div className="flex items-center gap-2">
        <AgentLoader kind="circular" size={18} label="Loading Symphony" />
        <span>Loading Symphony…</span>
      </div>
    </div>
  );
}
