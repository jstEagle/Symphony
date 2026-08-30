"use client";

import { useEffect } from "react";
import type { CSSProperties } from "react";
import bundledTheme from "../../../../theme.json";

export type SymphonyTheme = {
  version: number;
  name: string;
  colors: Record<string, string>;
};

export const defaultTheme = bundledTheme as SymphonyTheme;

export function themeStyle(theme: SymphonyTheme): CSSProperties {
  return Object.fromEntries(
    Object.entries(theme.colors).map(([token, value]) => [`--${token}`, value]),
  ) as CSSProperties;
}

function applyTheme(theme: SymphonyTheme): void {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${token}`, value);
  }
  root.dataset.theme = theme.name;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta && theme.colors.background) meta.content = theme.colors.background;
}

export function ThemeRuntime() {
  useEffect(() => {
    let active = true;
    let controller = new AbortController();
    const refresh = () => {
      controller.abort();
      controller = new AbortController();
      void fetch("/v1/theme", { cache: "no-store", signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<SymphonyTheme> : Promise.reject(new Error("Theme unavailable")))
        .then((theme) => { if (active) applyTheme(theme); })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      controller.abort();
    };
  }, []);
  return null;
}
