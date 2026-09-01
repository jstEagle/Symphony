import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CliClient, type CliClientOptions } from "./client.js";

/** The durable message API is deliberately separate from the legacy
 * `/v1/agents/:id/messages` native steering route. */
export const DURABLE_MESSAGES_PATH = "/v1/agent-messages";
export const CAPABILITIES_PATH = "/v1/capabilities";

export type OperatorCliOptions = {
  json: boolean;
  configPath?: string;
  body?: string;
  bodyFile?: string;
  idempotencyKey?: string;
  actorId?: string;
  actorType?: "agent" | "user" | "system";
  after?: number;
  before?: number;
  limit?: number;
  senderId?: string;
  recipientId?: string;
  objectiveId?: string;
  runId?: string;
  kind?: string;
  recordedAt?: string;
  reason?: string;
  decision?: string;
  now?: string;
};

export type OperatorCliArgs = {
  resource: "capability" | "messages" | "diagnostics" | "session";
  action: string;
  positional: string[];
  options: OperatorCliOptions;
};

function positiveInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function nonNegativeInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

/** Parse only operator command options. No shell or local persistence is
 * involved, which keeps this contract safe for scripts and other agents. */
export function parseOperatorArgs(argv: readonly string[]): OperatorCliArgs {
  const [resourceToken = "help", actionToken = "help", ...rest] = argv;
  const resource = resourceToken === "capabilities" || resourceToken === "capability" ? "capability"
    : resourceToken === "messages" || resourceToken === "agent-messages" ? "messages"
      : resourceToken === "diagnostics" ? "diagnostics"
        : resourceToken === "session" ? "session" : "diagnostics";
  const action = resourceToken === "session" ? actionToken : resourceToken === "help" ? "help" : actionToken;
  const positional: string[] = [];
  const options: OperatorCliOptions = { json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) continue;
    if (!token.startsWith("-")) { positional.push(token); continue; }
    if (token === "--json") { options.json = true; continue; }
    const next = (): string => {
      const value = rest[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${token} requires a value.`);
      index += 1;
      return value;
    };
    if (token === "--config") { options.configPath = next(); continue; }
    if (token === "--body" || token === "--input") { options.body = next(); continue; }
    if (token === "--body-file" || token === "--input-file") { options.bodyFile = next(); continue; }
    if (token === "--idempotency-key" || token === "--key") { options.idempotencyKey = next(); continue; }
    if (token === "--actor-id") { options.actorId = next(); continue; }
    if (token === "--actor-type") {
      const value = next();
      if (!(value === "agent" || value === "user" || value === "system")) throw new Error("--actor-type must be agent, user, or system.");
      options.actorType = value;
      continue;
    }
    if (token === "--after") { options.after = nonNegativeInt(token, next()); continue; }
    if (token === "--before") { options.before = nonNegativeInt(token, next()); continue; }
    if (token === "--limit") { options.limit = positiveInt(token, next()); continue; }
    if (token === "--sender-id") { options.senderId = next(); continue; }
    if (token === "--recipient-id") { options.recipientId = next(); continue; }
    if (token === "--objective-id") { options.objectiveId = next(); continue; }
    if (token === "--run-id") { options.runId = next(); continue; }
    if (token === "--kind") { options.kind = next(); continue; }
    if (token === "--recorded-at") { options.recordedAt = next(); continue; }
    if (token === "--reason") { options.reason = next(); continue; }
    if (token === "--decision") { options.decision = next(); continue; }
    if (token === "--now") { options.now = next(); continue; }
    throw new Error(`Unknown operator option: ${token}`);
  }
  return { resource, action, positional, options };
}

export type OperatorClientOptions = CliClientOptions;

export class OperatorClient extends CliClient {

  async get(path: string): Promise<unknown> {
    return super.get(path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bodyValue(options: OperatorCliOptions, required = false): unknown {
  if (options.body !== undefined && options.bodyFile !== undefined) throw new Error("Choose only one of --body and --body-file.");
  if (options.body === undefined && options.bodyFile === undefined) {
    if (required) throw new Error("A JSON request body is required (--body JSON or --body-file PATH).");
    return {};
  }
  const raw = options.bodyFile ? readFileSync(resolve(options.bodyFile), "utf8") : options.body as string;
  try { return JSON.parse(raw) as unknown; } catch (error) {
    throw new Error(`Request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function pathId(value: string): string { return encodeURIComponent(value); }

function requiredPositional(parsed: OperatorCliArgs, index: number, usage: string): string {
  const value = parsed.positional[index];
  if (!value) throw new Error(`Usage: ${usage}`);
  return value;
}

function mutationKey(options: OperatorCliOptions, prefix: string, body: unknown): string {
  if (options.idempotencyKey) return options.idempotencyKey;
  if (isRecord(body) && typeof body.requestKey === "string" && body.requestKey.length > 0) return body.requestKey;
  return `cli:${prefix}:${randomUUID()}`;
}

function withRequestKey(body: unknown, key: string): unknown {
  if (!isRecord(body)) throw new Error("Mutation body must be a JSON object.");
  if (typeof body.requestKey === "string" && body.requestKey.length > 0) {
    if (body.requestKey !== key) throw new Error(`Request body requestKey (${body.requestKey}) does not match --idempotency-key (${key}).`);
    return body;
  }
  return { ...body, requestKey: key };
}

function withActor(body: unknown, options: OperatorCliOptions): unknown {
  if (!isRecord(body)) throw new Error("Mutation body must be a JSON object.");
  if (body.actor !== undefined || (options.actorId === undefined && options.actorType === undefined)) return body;
  if (!options.actorId || !options.actorType) throw new Error("Provide both --actor-id and --actor-type when actor is not in the request body.");
  return { ...body, actor: { type: options.actorType, id: options.actorId } };
}

function withActorId(body: unknown, options: OperatorCliOptions): unknown {
  if (!isRecord(body)) throw new Error("Mutation body must be a JSON object.");
  if (body.actorId !== undefined || options.actorId === undefined) return body;
  return { ...body, actorId: options.actorId };
}

function query(options: OperatorCliOptions, fields: readonly (keyof OperatorCliOptions)[]): string {
  const params = new URLSearchParams();
  for (const field of fields) {
    const value = options[field];
    if (typeof value === "string" || typeof value === "number") {
      const wireName = field === "after" ? "afterCursor" : field === "before" ? "beforeCursor" : field;
      params.set(wireName, String(value));
    }
  }
  return params.toString() ? `?${params}` : "";
}

function renderHuman(resource: string, action: string, value: unknown): string {
  if (resource === "capability" && action === "list" && Array.isArray(value)) {
    return value.map((item) => {
      const record = isRecord(item) ? item : {};
      return `${String(record.capabilityId ?? record.id ?? "capability")}\t${String(record.version ?? "-")}\t${String(record.state ?? record.status ?? "unknown")}\t${String(record.definition && isRecord(record.definition) ? record.definition.name ?? "" : "")}`;
    }).join("\n") || "No capabilities.";
  }
  if (!isRecord(value)) return String(value);
  if (resource === "capability" && action === "list" && Array.isArray(value.capabilities)) {
    return value.capabilities.map((item) => {
      const record = isRecord(item) ? item : {};
      return `${String(record.capabilityId ?? record.id ?? "capability")}\t${String(record.version ?? "-")}\t${String(record.state ?? record.status ?? "unknown")}\t${String(record.definition && isRecord(record.definition) ? record.definition.name ?? "" : "")}`;
    }).join("\n") || "No capabilities.";
  }
  if (resource === "messages" && action === "list" && (Array.isArray(value) || Array.isArray(value.messages))) {
    const messages: unknown[] = Array.isArray(value) ? value : value.messages as unknown[];
    return messages.map((item) => {
      const record = isRecord(item) ? item : {};
      return `${String(record.cursor ?? "-")}\t${String(record.id ?? "message")}\t${String(record.kind ?? "unknown")}\t${String(record.summary ?? "")}`;
    }).join("\n") || "No messages.";
  }
  if (resource === "diagnostics") {
    const identity = isRecord(value.identity) ? value.identity : {};
    return `Session diagnostic\t${String(value.termination ?? "unknown")}\t${String(identity.agentId ?? identity.nativeSessionId ?? "unknown")}\t${String(value.contentHash ?? "")}`;
  }
  return JSON.stringify(value, null, 2);
}

export async function runOperatorCommand(
  argv: readonly string[],
  client: OperatorClient,
  write: (value: string) => void = (value) => process.stdout.write(value),
): Promise<void> {
  const parsed = parseOperatorArgs(argv);
  const { resource, action, positional, options } = parsed;
  const show = (value: unknown): void => write(`${options.json ? JSON.stringify(value) : renderHuman(resource, action, value)}\n`);
  const keyFor = (body: unknown, prefix: string): string => mutationKey(options, prefix, body);

  if (action === "help" || resource === "diagnostics" && action === "help") { write(`${operatorHelp()}\n`); return; }

  if (resource === "capability") {
    if (action === "list") {
      const capabilityId = positional[0];
      const suffix = capabilityId ? `?capabilityId=${encodeURIComponent(capabilityId)}` : "";
      show(await client.get(`${CAPABILITIES_PATH}${suffix}`));
      return;
    }
    if (action === "show") {
      const id = requiredPositional(parsed, 0, "symphony capability show <capability-id> <version>");
      const version = requiredPositional(parsed, 1, "symphony capability show <capability-id> <version>");
      show(await client.get(`${CAPABILITIES_PATH}/${pathId(id)}/${pathId(version)}`));
      return;
    }
    if (action === "create") {
      let body = bodyValue(options, true);
      const key = keyFor(body, "capability-create");
      body = withRequestKey(withActor(body, options), key);
      show(await client.mutate(CAPABILITIES_PATH, body, key));
      return;
    }
    if (action === "activate" || action === "deprecate" || action === "prepare") {
      const id = requiredPositional(parsed, 0, `symphony capability ${action} <capability-id> <version>`);
      const version = requiredPositional(parsed, 1, `symphony capability ${action} <capability-id> <version>`);
      let body = bodyValue(options, action === "prepare");
      const key = keyFor(body, `capability-${action}`);
      if (action !== "prepare") body = withActor(body, options);
      if (action !== "prepare") body = withRequestKey(body, key);
      show(await client.mutate(`${CAPABILITIES_PATH}/${pathId(id)}/${pathId(version)}/${action}`, body, key));
      return;
    }
  }

  if (resource === "messages") {
    if (action === "send") {
      let body = bodyValue(options, true);
      const key = keyFor(body, "message-send");
      body = withRequestKey(body, key);
      show(await client.mutate(DURABLE_MESSAGES_PATH, body, key));
      return;
    }
    if (action === "list") {
      show(await client.get(`${DURABLE_MESSAGES_PATH}${query(options, ["after", "before", "senderId", "recipientId", "objectiveId", "runId", "kind", "limit"])}`));
      return;
    }
    if (action === "show") {
      show(await client.get(`${DURABLE_MESSAGES_PATH}/${pathId(requiredPositional(parsed, 0, "symphony messages show <message-id>"))}`));
      return;
    }
    if (action === "receipts") {
      const id = requiredPositional(parsed, 0, "symphony messages receipts <message-id> [--body JSON]");
      if (options.body !== undefined || options.bodyFile !== undefined) {
        let body = withActorId(bodyValue(options, true), options);
        const key = keyFor(body, "message-receipt");
        body = withRequestKey(body, key);
        show(await client.mutate(`${DURABLE_MESSAGES_PATH}/${pathId(id)}/receipts`, body, key));
      } else show(await client.get(`${DURABLE_MESSAGES_PATH}/${pathId(id)}/receipts`));
      return;
    }
    if (action === "cancel" || action === "expire") {
      const id = requiredPositional(parsed, 0, `symphony messages ${action} <message-id> --actor-id ID`);
      let body = withActorId(bodyValue(options), options);
      if (options.recordedAt !== undefined) body = { ...(body as Record<string, unknown>), recordedAt: options.recordedAt };
      if (options.reason !== undefined) body = { ...(body as Record<string, unknown>), reason: options.reason };
      const key = keyFor(body, `message-${action}`);
      body = withRequestKey(body, key);
      show(await client.mutate(`${DURABLE_MESSAGES_PATH}/${pathId(id)}/${action}`, body, key));
      return;
    }
  }

  if (resource === "diagnostics" && action === "export") {
    const id = requiredPositional(parsed, 0, "symphony diagnostics export <agent-id>");
    show(await client.get(`/v1/diagnostics?agentId=${pathId(id)}`));
    return;
  }
  if (resource === "session" && action === "diagnostics") {
    const id = positional[0] === "export"
      ? requiredPositional(parsed, 1, "symphony session diagnostics export <agent-id>")
      : requiredPositional(parsed, 0, "symphony session diagnostics <agent-id>");
    show(await client.get(`/v1/diagnostics?agentId=${pathId(id)}`));
    return;
  }
  throw new Error(`Unknown operator command: ${resource} ${action}. Run 'symphony capability help', 'symphony messages help', or 'symphony diagnostics help'.`);
}

export function operatorHelp(): string {
  return `Operator commands (daemon is authoritative):
  symphony capability list [capability-id]
  symphony capability show <capability-id> <version>
  symphony capability create --body JSON [--idempotency-key KEY]
  symphony capability activate|deprecate <capability-id> <version> --body JSON
  symphony capability prepare <capability-id> <version> --body JSON
  symphony messages send --body JSON [--idempotency-key KEY]
  symphony messages list [--after N] [--limit N] [filters]
  symphony messages show <message-id>
  symphony messages receipts <message-id> [--body JSON]
  symphony messages cancel|expire <message-id> --actor-id ID
  symphony diagnostics export <agent-id>
  symphony session diagnostics <agent-id>`;
}
