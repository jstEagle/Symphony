import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CliClient, type CliClientOptions } from "./client.js";

export { UnknownMutationOutcomeError } from "./client.js";

export type ObjectiveCliOptions = {
  json: boolean;
  configPath?: string;
  after?: number;
  limit?: number;
  state: string[];
  idempotencyKey?: string;
  body?: string;
  bodyFile?: string;
  noReconnect: boolean;
};

export type ObjectiveCliArgs = {
  action: string;
  positional: string[];
  options: ObjectiveCliOptions;
};

/** Parse only the objective command vocabulary. Keeping this parser separate
 * makes the CLI shell-free and gives scripts a stable, testable contract. */
export function parseObjectiveArgs(argv: readonly string[]): ObjectiveCliArgs {
  const [action = "help", ...rest] = argv;
  const positional: string[] = [];
  const state: string[] = [];
  const options: ObjectiveCliOptions = { json: false, state, noReconnect: false };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) continue;
    if (!token.startsWith("-")) {
      positional.push(token);
      continue;
    }
    if (token === "--json") { options.json = true; continue; }
    if (token === "--no-reconnect") { options.noReconnect = true; continue; }
    const next = (): string => {
      const value = rest[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${token} requires a value.`);
      index += 1;
      return value;
    };
    if (token === "--state") { state.push(next()); continue; }
    if (token === "--config") { options.configPath = next(); continue; }
    if (token === "--after") { options.after = parseNonNegativeInt(token, next()); continue; }
    if (token === "--limit") { options.limit = parsePositiveInt(token, next()); continue; }
    if (token === "--idempotency-key" || token === "--key") { options.idempotencyKey = next(); continue; }
    if (token === "--body") { options.body = next(); continue; }
    if (token === "--body-file") { options.bodyFile = next(); continue; }
    throw new Error(`Unknown objective option: ${token}`);
  }
  return { action, positional, options };
}

function parsePositiveInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseNonNegativeInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

export type ObjectiveSseEvent = { id: number; event: string; data: unknown };

export type ObjectiveClientOptions = CliClientOptions;

export class ObjectiveClient extends CliClient {

  async get(path: string, signal?: AbortSignal): Promise<unknown> {
    return super.get(path, signal);
  }

  async *follow(runId: string, options: { after?: number; signal?: AbortSignal; reconnect?: boolean } = {}): AsyncGenerator<ObjectiveSseEvent> {
    let cursor = options.after ?? 0;
    const reconnect = options.reconnect ?? true;
    while (true) {
      try {
        const response = await this.fetchFn(`${this.baseUrl}/v1/objectives/${encodeURIComponent(runId)}/events?after=${cursor}`, {
          headers: { accept: "text/event-stream" },
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}: unable to open objective event stream`);
        for await (const event of parseSse(response.body)) {
          if (event.id > cursor) cursor = event.id;
          yield event;
        }
        if (!reconnect) return;
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!reconnect) throw error;
      }
      await delay(500, options.signal);
    }
  }

}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<ObjectiveSseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let id = 0;
  let event = "message";
  let data: string[] = [];
  try {
    while (true) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      const frames = buffer.split(/\r?\n\r?\n/u);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split(/\r?\n/u)) {
          if (line.startsWith("id:")) id = Number(line.slice(3).trim()) || id;
          else if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length > 0) {
          const value = data.join("\n");
          let parsed: unknown = value;
          try { parsed = JSON.parse(value) as unknown; } catch { /* plain text SSE is valid */ }
          if (event !== "message" || data.length > 0) yield { id, event, data: parsed };
        }
        event = "message";
        data = [];
      }
      if (next.done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
  });
}

function bodyValue(options: ObjectiveCliOptions): unknown {
  if (options.body !== undefined && options.bodyFile !== undefined) throw new Error("Choose only one of --body and --body-file.");
  const raw = options.bodyFile ? readFileSync(resolve(options.bodyFile), "utf8") : options.body ?? "{}";
  try { return JSON.parse(raw) as unknown; } catch (error) {
    throw new Error(`Objective request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function idAt(args: ObjectiveCliArgs, index: number, usage: string): string {
  const value = args.positional[index];
  if (!value) throw new Error(`Usage: ${usage}`);
  return value;
}

function pathId(value: string): string { return encodeURIComponent(value); }

export async function runObjectiveCommand(
  argv: readonly string[],
  client: ObjectiveClient,
  write: (value: string) => void = (value) => process.stdout.write(value),
): Promise<void> {
  const parsed = parseObjectiveArgs(argv);
  const { action, positional, options } = parsed;
  const json = (value: unknown): void => write(`${JSON.stringify(value)}\n`);
  const show = (value: unknown): void => write(options.json ? `${JSON.stringify(value)}\n` : `${renderObjectiveHuman(action, value)}\n`);
  const key = (): string => options.idempotencyKey ?? `cli:objective:${randomUUID()}`;

  if (action === "help") { write(objectiveHelp()); return; }
  if (action === "list") {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    for (const value of options.state) params.append("state", value);
    show(await client.get(`/v1/objectives${params.toString() ? `?${params}` : ""}`));
    return;
  }
  if (action === "snapshot") {
    show(await client.get(`/v1/objectives/${pathId(idAt(parsed, 0, "symphony objective snapshot <objective-id>"))}/snapshot`));
    return;
  }
  if (action === "frontier" || action === "runline") {
    const snapshot = await client.get(`/v1/objectives/${pathId(idAt(parsed, 0, `symphony objective ${action} <objective-id>`))}/snapshot`);
    if (action === "frontier" && isRecord(snapshot)) show(snapshot.frontierProjection ?? { frontier: snapshot.frontier });
    else if (action === "runline" && isRecord(snapshot)) show(snapshot.runline ?? { entries: [] });
    else show(snapshot);
    return;
  }
  if (action === "attentions") {
    const params = new URLSearchParams();
    if (positional[0]) params.set("objectiveId", positional[0]);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    show(await client.get(`/v1/attentions${params.toString() ? `?${params}` : ""}`));
    return;
  }
  if (action === "artifacts") {
    show(await client.get(`/v1/objectives/${pathId(idAt(parsed, 0, "symphony objective artifacts <run-id>"))}/artifacts${options.limit ? `?limit=${options.limit}` : ""}`));
    return;
  }
  if (action === "artifact") {
    const runId = idAt(parsed, 0, "symphony objective artifact <run-id> <artifact-id>");
    show(await client.get(`/v1/objectives/${pathId(runId)}/artifacts/${pathId(idAt(parsed, 1, "symphony objective artifact <run-id> <artifact-id>"))}`));
    return;
  }
  if (action === "checkpoints") {
    show(await client.get(`/v1/objectives/${pathId(idAt(parsed, 0, "symphony objective checkpoints <run-id>"))}/checkpoints`));
    return;
  }
  if (action === "strategy") {
    show(await client.get(`/v1/objectives/${pathId(idAt(parsed, 0, "symphony objective strategy <run-id>"))}/strategy`));
    return;
  }
  if (action === "strategy-preview" || action === "strategy-revise") {
    const runId = idAt(parsed, 0, `symphony objective ${action} <run-id> --body JSON`);
    const route = `/v1/objectives/${pathId(runId)}/strategy${action === "strategy-preview" ? "/preview" : ""}`;
    show(await client.mutate(route, bodyValue(options), key()));
    return;
  }
  if (action === "signal") {
    const runId = idAt(parsed, 0, "symphony objective signal <run-id> [signal-key] --body JSON");
    const signalKey = positional[1];
    const route = `/v1/objectives/${pathId(runId)}/signals${signalKey ? `/${pathId(signalKey)}` : ""}`;
    show(await client.mutate(route, bodyValue(options), key()));
    return;
  }
  if (action === "attention-resolve") {
    const runId = idAt(parsed, 0, "symphony objective attention-resolve <run-id> <attention-id> --body JSON");
    const attentionId = idAt(parsed, 1, "symphony objective attention-resolve <run-id> <attention-id> --body JSON");
    show(await client.mutate(`/v1/objectives/${pathId(runId)}/attentions/${pathId(attentionId)}/resolve`, bodyValue(options), key()));
    return;
  }
  if (action === "artifact-review") {
    const runId = idAt(parsed, 0, "symphony objective artifact-review <run-id> <artifact-id> --body JSON");
    const artifactId = idAt(parsed, 1, "symphony objective artifact-review <run-id> <artifact-id> --body JSON");
    show(await client.mutate(`/v1/objectives/${pathId(runId)}/artifacts/${pathId(artifactId)}/review`, bodyValue(options), key()));
    return;
  }
  if (action === "checkpoint") {
    const runId = idAt(parsed, 0, "symphony objective checkpoint <run-id> <checkpoint-id> <resume|retry|fork> --body JSON");
    const checkpointId = idAt(parsed, 1, "symphony objective checkpoint <run-id> <checkpoint-id> <resume|retry|fork> --body JSON");
    const operation = idAt(parsed, 2, "symphony objective checkpoint <run-id> <checkpoint-id> <resume|retry|fork> --body JSON");
    if (!(["resume", "retry", "fork"] as const).includes(operation as "resume" | "retry" | "fork")) throw new Error("Checkpoint operation must be resume, retry, or fork.");
    const body = bodyValue(options);
    const payload = isRecord(body) ? { ...body, runId, checkpointId } : body;
    show(await client.mutate(`/v1/objectives/${pathId(runId)}/checkpoints/${pathId(checkpointId)}/${operation}`, payload, key()));
    return;
  }
  if (action === "follow") {
    const runId = idAt(parsed, 0, "symphony objective follow <run-id> [--after cursor]");
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    try {
      for await (const event of client.follow(runId, { ...(options.after === undefined ? {} : { after: options.after }), signal: controller.signal, reconnect: !options.noReconnect })) {
        if (options.json) json(event);
        else write(`${event.id ? `#${event.id} ` : ""}${event.event}${typeof event.data === "string" ? `: ${event.data}\n` : ` ${JSON.stringify(event.data)}\n`}`);
      }
    } finally { process.off("SIGINT", stop); }
    return;
  }
  throw new Error(`Unknown objective command: ${action}. Run \'symphony objective help\'.`);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function renderObjectiveHuman(action: string, value: unknown): string {
  if (!isRecord(value)) return String(value);
  if (action === "list" && Array.isArray(value.objectives)) {
    return value.objectives.length === 0 ? "No objectives." : value.objectives.map((item) => {
      const record = isRecord(item) ? item : {};
      return `${String(record.objectiveId ?? record.id ?? "objective")}\t${String(record.state ?? "unknown")}\t${String(record.latestRunId ?? "-")}\t${String(record.statement ?? "")}`;
    }).join("\n");
  }
  if (action === "frontier" && isRecord(value)) {
    const counts = isRecord(value.counts) ? value.counts : {};
    const items = Array.isArray(value.frontier) ? value.frontier : [];
    return [`Frontier: ${String(value.state ?? "unknown")} — ${String(value.summary ?? "")}`, `runnable ${String(counts.runnable ?? 0)} · running ${String(counts.running ?? 0)} · waiting ${String((counts.waitingAttention ?? 0) as unknown)} · unknown ${String(counts.outcomeUnknown ?? 0)}`, ...items.map((item) => {
      const record = isRecord(item) ? item : {};
      return `  ${String(record.status ?? "unknown")}  ${String(record.label ?? record.id ?? "item")}`;
    })].join("\n");
  }
  if (action === "runline" && Array.isArray(value.entries)) {
    return value.entries.map((item) => {
      const record = isRecord(item) ? item : {};
      return `${String(record.occurredAt ?? "")}  ${String(record.type ?? "event")}  ${String(record.summary ?? "")}`;
    }).join("\n") || "No runline entries.";
  }
  if (action === "follow") return JSON.stringify(value);
  const keys = Object.keys(value);
  if (keys.length === 1 && Array.isArray(value[keys[0] as string])) return `${keys[0]}: ${(value[keys[0] as string] as unknown[]).length}`;
  return JSON.stringify(value, null, 2);
}

export function objectiveHelp(): string {
  return `Objective commands (daemon is authoritative):
  symphony objective list [--state STATE] [--limit N]
  symphony objective snapshot <objective-id>
  symphony objective frontier <objective-id>
  symphony objective runline <objective-id>
  symphony objective attentions [objective-id]
  symphony objective artifacts <run-id> | artifact <run-id> <artifact-id>
  symphony objective checkpoints <run-id>
  symphony objective strategy <run-id>
  symphony objective strategy-preview <run-id> --body JSON
  symphony objective strategy-revise <run-id> --body JSON
  symphony objective checkpoint <run-id> <checkpoint-id> <resume|retry|fork> --body JSON
  symphony objective signal <run-id> [signal-key] --body JSON
  symphony objective attention-resolve <run-id> <attention-id> --body JSON
  symphony objective artifact-review <run-id> <artifact-id> --body JSON
  symphony objective follow <run-id> [--after CURSOR]

Mutation options: --idempotency-key KEY (or --key KEY), --body JSON, --body-file PATH
Output: --json emits one compact JSON record (follow emits NDJSON); otherwise concise human output.
Unknown network outcomes are explicit; retry the command with the same idempotency key.\n`;
}
