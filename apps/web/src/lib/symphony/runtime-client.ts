import type {
  AgentObservation,
  AgentSessionLog,
  AgentRecord,
  BootstrapEnvelope,
  ChatAttachment,
  ChatThreadRecord,
  CommandReceipt,
  CommandType,
  ConversationMessage,
  CostSummary,
  DriverReport,
  DriverAuthenticationResult,
  EventEnvelope,
  JsonValue,
  ModelDescriptor,
  ObservationLevel,
  PluginState,
  ProjectRecord,
  DirectoryListing,
  RuntimeSettings,
  UsageHeatmap,
} from "./contracts";
import { previewEnvelope } from "./preview";
import { symphonyConfig } from "@/symphony.config";

export type RuntimeMode = "preview" | "runtime";
export type RuntimeCatalog = {
  drivers: DriverReport[];
  models: ModelDescriptor[];
};

type DaemonBootstrap = {
  cursor: number;
  events: EventEnvelope[];
  workflows: JsonValue[];
  runs: JsonValue[];
  agents: AgentRecord[];
  messages: ConversationMessage[];
  projects: ProjectRecord[];
  costs: JsonValue;
  runCosts: Record<string, JsonValue>;
  agentCosts: Record<string, JsonValue>;
  plugins: PluginState[];
  settings: RuntimeSettings;
  daemon: BootstrapEnvelope["daemon"];
};

export class RuntimeRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RuntimeRequestError";
    this.status = status;
  }
}

export function isRetryableRuntimeRequestError(error: unknown): boolean {
  if (!(error instanceof RuntimeRequestError)) return true;
  return error.status === 408
    || error.status === 425
    || error.status === 429
    || error.status >= 500;
}

async function request<T>(
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`${symphonyConfig.apiBasePath}${path}`, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const value = text ? (JSON.parse(text) as T) : (undefined as T);
  if (!response.ok) {
    const error = typeof value === "object" && value && "error" in value ? String((value as { error: unknown }).error) : text;
    throw new RuntimeRequestError(response.status, error || `${response.status} ${response.statusText}`);
  }
  return value;
}

export async function getHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch("/health", {
      signal,
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

export async function fetchBootstrap(
  mode: RuntimeMode,
  signal?: AbortSignal,
): Promise<BootstrapEnvelope> {
  if (mode === "preview") return previewEnvelope();

  const [bootstrap, threads] = await Promise.all([
    request<DaemonBootstrap>("/bootstrap", { signal }),
    request<ChatThreadRecord[]>("/threads", { signal }).catch(() => [] as ChatThreadRecord[]),
  ]);

  return {
    apiVersion: 1,
    runtimeEpoch: bootstrap.daemon.startedAt,
    cursor: bootstrap.cursor,
    events: bootstrap.events ?? [],
    mode: "runtime",
    directory: { activeConversationId: null, groups: [] },
    run: previewEnvelope().run,
    threads,
    messages: bootstrap.messages,
    projects: bootstrap.projects ?? [],
    agents: bootstrap.agents ?? [],
    runs: (bootstrap.runs as BootstrapEnvelope["runs"]) ?? [],
    costs: normalizeCost(bootstrap.costs),
    runCosts: normalizeCostMap(bootstrap.runCosts),
    agentCosts: normalizeCostMap(bootstrap.agentCosts),
    plugins: bootstrap.plugins ?? [],
    drivers: [],
    models: [],
    settings: bootstrap.settings,
    inbox: [],
    daemon: bootstrap.daemon,
  };
}

export async function fetchRuntimeCatalog(signal?: AbortSignal): Promise<RuntimeCatalog> {
  const [drivers, models] = await Promise.all([
    request<DriverReport[]>("/drivers", { signal }).catch(() => [] as DriverReport[]),
    request<ModelDescriptor[]>("/models", { signal }).catch(() => [] as ModelDescriptor[]),
  ]);
  return { drivers, models };
}

export async function fetchThread(id: string, signal?: AbortSignal) {
  return request<{ thread: ChatThreadRecord; messages: ConversationMessage[] }>(`/threads/${id}`, { signal });
}

export type ChatSearchResponse = {
  method: "openrouter-rerank" | "fuzzy";
  results: Array<{ threadId: string; title: string; groupId: string | null; score: number; snippet: string }>;
};

export async function searchChats(query: string, signal?: AbortSignal) {
  return request<ChatSearchResponse>(`/search/chats?q=${encodeURIComponent(query)}`, { signal });
}

export type ChatThreadCreateInput = {
  title?: string;
  projectId?: string;
  groupId?: string | null;
  workspacePath?: string;
  mission?: { statement: string; keyResults?: string[] };
};

export async function createThread(input: ChatThreadCreateInput, idempotencyKey: string) {
  return request<ChatThreadRecord>("/threads", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export async function createProject(input: { workspacePath: string; title?: string }) {
  return request<ProjectRecord>("/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function browseDirectories(path?: string, signal?: AbortSignal) {
  const query = path?.trim() ? `?path=${encodeURIComponent(path.trim())}` : "";
  return request<DirectoryListing>(`/filesystem/directories${query}`, { signal });
}

export async function updateThread(
  id: string,
  patch: { title?: string; groupId?: string | null; archived?: boolean },
) {
  return request<ChatThreadRecord>(`/threads/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function sendThreadMessage(
  threadId: string,
  input: { messageId: string; content: string; attachments: ChatAttachment[] },
) {
  return request<{ thread: ChatThreadRecord; agentId: string; messageId: string }>(
    `/threads/${threadId}/messages`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function updateRuntimeSettings(patch: Partial<Pick<RuntimeSettings, "conductor" | "agents" | "uiUtilities">>) {
  return request<RuntimeSettings>("/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function updateNativeHarness(driver: string, idempotencyKey: string) {
  return request<{ report: DriverReport; output: string }>(`/drivers/${encodeURIComponent(driver)}/update`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
  });
}

export async function authenticateNativeHarness(driver: string, idempotencyKey: string) {
  return request<DriverAuthenticationResult>(`/drivers/${encodeURIComponent(driver)}/authenticate`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
  });
}

export async function fetchUsageHeatmap(weeks = 12, signal?: AbortSignal): Promise<UsageHeatmap> {
  return request<UsageHeatmap>(`/usage/heatmap?weeks=${weeks}`, { signal });
}

export async function observeAgent(agentId: string, level: ObservationLevel, signal?: AbortSignal) {
  return request<AgentObservation | JsonValue>(`/agents/${agentId}/observe?level=${level}`, { signal });
}

export async function fetchAgentMessages(agentId: string, signal?: AbortSignal) {
  return request<{ agentId: string; messages: ConversationMessage[] }>(
    `/agents/${encodeURIComponent(agentId)}/messages`,
    { signal },
  );
}

export async function fetchAgentLogs(agentId: string, after = 0, limit = 500, signal?: AbortSignal) {
  const tail = after === 0 ? "&tail=true" : "";
  return request<AgentSessionLog>(`/agents/${encodeURIComponent(agentId)}/logs?after=${after}&limit=${limit}${tail}`, { signal });
}

export async function fetchRunEvents(runId: string, signal?: AbortSignal): Promise<EventEnvelope[]> {
  const events: EventEnvelope[] = [];
  let cursor = 0;
  let hasMore = true;
  while (hasMore) {
    const page = await request<{
      runId: string;
      cursor: number;
      hasMore: boolean;
      events: EventEnvelope[];
    }>(`/runs/${encodeURIComponent(runId)}/events?after=${cursor}&limit=2000`, { signal });
    events.push(...page.events);
    hasMore = page.hasMore;
    if (page.cursor <= cursor) break;
    cursor = page.cursor;
  }
  return events;
}

export async function cancelAgent(agentId: string) {
  return request<void>(`/agents/${agentId}/cancel`, {
    method: "POST",
    headers: { "idempotency-key": `web:cancel-agent:${crypto.randomUUID()}` },
  });
}

export async function steerAgent(agentId: string, content: string) {
  return request<JsonValue>(`/agents/${agentId}/messages`, {
    method: "POST",
    headers: { "idempotency-key": `web:message-agent:${crypto.randomUUID()}` },
    body: JSON.stringify({ content }),
  });
}

export async function postCommand(input: {
  type: CommandType;
  payload: JsonValue;
  idempotencyKey: string;
  actorId?: string | null;
}) {
  return request<CommandReceipt>("/commands", {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: input.idempotencyKey,
      type: input.type,
      payload: input.payload,
      actor: { type: "user", id: input.actorId ?? null },
    }),
  });
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function normalizeCost(value: JsonValue): CostSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { amount: 0, currency: "USD", provenance: "unavailable" };
  }
  const record = value as Record<string, JsonValue>;
  const known = typeof record.knownTotal === "number" ? record.knownTotal : 0;
  const unknown = typeof record.unknownEvents === "number" ? record.unknownEvents : 0;
  const eventCount = typeof record.eventCount === "number" ? record.eventCount : 0;
  const byBasis =
    record.byBasis && typeof record.byBasis === "object" && !Array.isArray(record.byBasis)
      ? Object.fromEntries(
          Object.entries(record.byBasis).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
        )
      : {};
  return {
    amount: known,
    currency: typeof record.currency === "string" ? record.currency : "USD",
    provenance: unknown > 0 ? "pending" : eventCount > 0 ? "measured" : "unavailable",
    knownTotal: known,
    unknownEvents: unknown,
    eventCount,
    byBasis,
  };
}

function normalizeCostMap(value: Record<string, JsonValue> | undefined): Record<string, CostSummary> {
  return Object.fromEntries(Object.entries(value ?? {}).map(([id, cost]) => [id, normalizeCost(cost)]));
}

export function subscribeToRuntime(
  cursor: number | string,
  onEvent: (event: EventEnvelope) => void,
  onReset: () => void,
  onConnection: (state: "connecting" | "live" | "stale") => void,
) {
  const controller = new AbortController();
  let currentCursor = Number(cursor) || 0;
  let delay: number = symphonyConfig.reconnect.minDelayMs;
  let staleTimer: number | undefined;
  let stopped = false;

  const markLive = () => {
    onConnection("live");
    delay = symphonyConfig.reconnect.minDelayMs;
    if (staleTimer) window.clearTimeout(staleTimer);
    staleTimer = window.setTimeout(() => onConnection("stale"), symphonyConfig.staleAfterMs);
  };

  const connect = async () => {
    if (stopped) return;
    onConnection("connecting");
    try {
      const url = `${symphonyConfig.apiBasePath}/events?after=${currentCursor}&projection=ui`;
      const response = await fetch(url, {
        signal: controller.signal,
        credentials: "same-origin",
        headers: {
          Accept: "text/event-stream",
          "Last-Event-ID": String(currentCursor),
        },
      });
      if (!response.ok || !response.body) throw new Error(`SSE failed with ${response.status}`);
      markLive();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replaceAll("\r\n", "\n");
        let separator = buffer.indexOf("\n\n");
        while (separator >= 0) {
          const raw = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf("\n\n");
          if (!raw.trim() || raw.startsWith(":")) {
            markLive();
            continue;
          }
          const parsed = parseSse(raw);
          if (parsed.event === "reset") {
            onReset();
            return;
          }
          if (!parsed.data) continue;
          const envelope = JSON.parse(parsed.data) as EventEnvelope;
          if (typeof envelope.cursor === "number") currentCursor = envelope.cursor;
          onEvent(envelope);
          markLive();
        }
      }
      throw new Error("SSE stream closed");
    } catch (error) {
      if (stopped || controller.signal.aborted) return;
      onConnection("stale");
      window.setTimeout(() => {
        void connect();
      }, delay);
      delay = Math.min(delay * 2, symphonyConfig.reconnect.maxDelayMs);
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  };

  void connect();

  return () => {
    stopped = true;
    if (staleTimer) window.clearTimeout(staleTimer);
    controller.abort();
  };
}

function parseSse(raw: string): { event?: string; data?: string; id?: string } {
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { event, id, data: data.length ? data.join("\n") : undefined };
}

export async function resolveMode(requested: typeof symphonyConfig.dataMode, signal?: AbortSignal): Promise<RuntimeMode> {
  if (requested === "preview") return "preview";
  if (requested === "runtime") return "runtime";
  return (await getHealth(signal)) ? "runtime" : "preview";
}
