export const symphonyConfig = {
  dataMode: "runtime" as "auto" | "preview" | "runtime",
  apiBasePath: "/v1",
  staleAfterMs: 15_000,
  reconnect: {
    minDelayMs: 500,
    maxDelayMs: 10_000,
  },
} as const;

export type DataMode = (typeof symphonyConfig)["dataMode"];
