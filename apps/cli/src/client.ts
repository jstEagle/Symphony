import { randomUUID } from "node:crypto";
import type { LoadedConfig } from "@symphony/config";

/**
 * A mutation can have been accepted by the daemon even when its response is
 * lost. Keep the key on the error so a caller can retry the exact request.
 */
export class UnknownMutationOutcomeError extends Error {
  readonly idempotencyKey: string;

  constructor(message: string, idempotencyKey: string, options?: { cause?: unknown }) {
    super(`${message} The outcome is UNKNOWN; retry with --idempotency-key ${idempotencyKey}.`, options);
    this.name = "UnknownMutationOutcomeError";
    this.idempotencyKey = idempotencyKey;
  }
}

export type CliClientOptions = {
  config?: LoadedConfig;
  baseUrl?: string;
  fetchFn?: typeof fetch;
};

/** Shared daemon HTTP transport for CLI reads and idempotent mutations. */
export class CliClient {
  protected readonly baseUrl: string;
  protected readonly fetchFn: typeof fetch;

  constructor(options: CliClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? `http://${options.config?.config.server.host ?? "127.0.0.1"}:${options.config?.config.server.port ?? 3210}`).replace(/\/$/u, "");
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async get(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, signal ? { signal } : {});
  }

  async mutate(path: string, body: unknown, idempotencyKey = `cli:mutation:${randomUUID()}`): Promise<unknown> {
    const serializedBody = JSON.stringify(body);
    let response: Response;
    try {
      // Only failures before a Response exists are unknown outcomes. HTTP
      // errors are known daemon responses and must retain their status.
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: serializedBody,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new UnknownMutationOutcomeError(message, idempotencyKey, { cause: error });
    }
    return this.parseResponse(response);
  }

  protected async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: { accept: "application/json", "content-type": "application/json", ...init.headers },
    });
    return this.parseResponse(response);
  }

  private async parseResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try { payload = JSON.parse(text) as unknown; } catch { payload = text; }
    }
    if (!response.ok) {
      const detail = typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: unknown }).error)
        : String(payload);
      throw new Error(`${response.status} ${response.statusText}: ${detail}`);
    }
    return payload;
  }
}
