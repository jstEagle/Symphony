#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  environmentWithoutDaemonSecret,
  isDaemonSecretKey,
  loadConfig,
  SecretStore,
  writeDefaultConfig,
} from "@symphony/config";
import { startDaemon, SymphonyDaemon } from "@symphony/daemon";
import { parseSecretInputSource, readSecretInput, SECRET_SET_USAGE } from "./secret-input.js";
import { CliClient } from "./client.js";
import { ObjectiveClient, runObjectiveCommand } from "./objective-cli.js";
import { OperatorClient, operatorHelp, runOperatorCommand } from "./operator-cli.js";

const args = process.argv.slice(2);
while (args[0] === "--") args.shift();
const command = args[0] && !args[0].startsWith("-") ? args.shift() as string : "start";

async function request(path: string, options: RequestInit = {}): Promise<unknown> {
  const loaded = loadConfig();
  // Legacy read commands still pass RequestInit for compatibility with this
  // small dispatcher; mutations below use CliClient.mutate so their retry key
  // and unknown outcome handling are centralized.
  if (options.method && options.method !== "GET") throw new Error("Mutations must use the CLI client.");
  return new CliClient({ config: loaded }).get(path, options.signal ?? undefined);
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function mutationKey(prefix: string): string {
  const explicit = option("--idempotency-key") ?? option("--key");
  if (explicit) return explicit;
  if (args.includes("--idempotency-key") || args.includes("--key")) {
    throw new Error("--idempotency-key requires a value.");
  }
  return `cli:${prefix}:${randomUUID()}`;
}

function withoutMutationKey(values: readonly string[]): string[] {
  const positional: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--idempotency-key" || value === "--key") {
      index += 1;
      continue;
    }
    positional.push(value as string);
  }
  return positional;
}

async function main(): Promise<void> {
  if (command === "start") {
    const daemon = await startDaemon({ noPlugins: args.includes("--no-plugins") });
    const url = `http://${daemon.loaded.config.server.host}:${daemon.loaded.config.server.port}`;
    print(`Symphony is running at ${url}`);
    if (daemon.loaded.config.server.openBrowser && !args.includes("--no-open")) {
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
        detached: true,
        env: environmentWithoutDaemonSecret(),
        stdio: "ignore",
      }).unref();
    }
    let closePromise: Promise<void> | null = null;
    const close = (): Promise<void> => {
      // Package managers can forward the same terminal signal that the
      // foreground process group already received. Keep permanent handlers
      // installed while cleanup runs so a duplicate SIGINT/SIGTERM cannot
      // restore Node's default immediate-exit behavior halfway through lease
      // release and native process shutdown.
      closePromise ??= daemon.close().finally(() => process.exit(0));
      return closePromise;
    };
    process.on("SIGINT", () => void close());
    process.on("SIGTERM", () => void close());
    return;
  }
  if (command === "init") {
    print({ configPath: writeDefaultConfig(resolve(option("--root") ?? process.cwd()), args.includes("--force")) });
    return;
  }
  if (command === "doctor") {
    const daemon = new SymphonyDaemon({ noPlugins: true, acquireLease: true });
    try {
      print({
        config: daemon.loaded.configPath,
        dataDirectory: daemon.loaded.dataDirectory,
        drivers: await Promise.all(daemon.drivers.list().map((driver) => driver.doctor())),
        secrets: ["openrouter.apiKey", "cursor.apiKey", "anthropic.apiKey", "openai.apiKey"].map((key) => ({ key, location: daemon.secrets.describeLocation(key) })),
      });
    } finally {
      await daemon.close();
    }
    return;
  }
  if (command === "status") return print(await request("/health"));
  if (command === "objective") {
    const configPath = option("--config");
    const loaded = loadConfig(configPath ? { configPath } : {});
    return runObjectiveCommand(args, new ObjectiveClient({ config: loaded }));
  }
  if (command === "capability" || command === "capabilities" || command === "messages" || command === "agent-messages" || command === "diagnostics" || command === "session") {
    const configPath = option("--config");
    const loaded = loadConfig(configPath ? { configPath } : {});
    if ((command === "diagnostics" || command === "session") && args[0] === "help") {
      print(operatorHelp());
      return;
    }
    return runOperatorCommand([command, ...args], new OperatorClient({ config: loaded }));
  }
  if (command === "models") return print(await request("/v1/models"));
  if (command === "plugins") return print(await request("/v1/plugins"));
  if (command === "costs") return print(await request("/v1/costs"));
  if (command === "agents") return print(await request(`/v1/agents${args.includes("--active") ? "?active=true" : ""}`));
  if (command === "observe") {
    const id = args[0];
    if (!id) throw new Error("Usage: symphony observe <agent-id> [--level tldr|paragraph|full]");
    return print(await request(`/v1/agents/${encodeURIComponent(id)}/observe?level=${option("--level") ?? "tldr"}`));
  }
  if (command === "logs") {
    const id = args[0];
    if (!id) throw new Error("Usage: symphony logs <agent-id> [--after cursor] [--limit count]");
    const search = new URLSearchParams({ after: option("--after") ?? "0", limit: option("--limit") ?? "500" });
    return print(await request(`/v1/agents/${encodeURIComponent(id)}/logs?${search}`));
  }
  if (command === "message") {
    const [id, ...content] = withoutMutationKey(args);
    if (!id || !content.length) throw new Error("Usage: symphony message <agent-id> <message>");
    const client = new CliClient({ config: loadConfig() });
    return print(await client.mutate(`/v1/agents/${encodeURIComponent(id)}/messages`, { content: content.join(" ") }, mutationKey("message")));
  }
  if (command === "cancel") {
    const id = args[0];
    if (!id) throw new Error("Usage: symphony cancel <agent-id>");
    const client = new CliClient({ config: loadConfig() });
    return print(await client.mutate(`/v1/agents/${encodeURIComponent(id)}/cancel`, {}, mutationKey("cancel-agent")));
  }
  if (command === "workflows") return print(await request("/v1/workflows"));
  if (command === "run") {
    const id = args[0];
    if (!id) throw new Error("Usage: symphony run <workflow-id> [--input JSON | --input-file path]");
    const inputFile = option("--input-file");
    const input = inputFile ? JSON.parse(readFileSync(resolve(inputFile), "utf8")) : JSON.parse(option("--input") ?? "{}");
    const client = new CliClient({ config: loadConfig() });
    return print(await client.mutate(`/v1/workflows/${encodeURIComponent(id)}/runs`, input, mutationKey("run-workflow")));
  }
  if (command === "secret") {
    const [operation, key, ...operationArgs] = args;
    if (!operation || !key) {
      throw new Error("Usage: symphony secret set <key> (--stdin | --file <path>) | symphony secret <delete|status> <key>");
    }
    if (isDaemonSecretKey(key)) {
      throw new Error("The daemon root credential is managed during daemon startup and cannot be read, written, or deleted through the generic CLI secret command.");
    }
    const secrets = new SecretStore();
    if (operation === "set") {
      const value = readSecretInput(parseSecretInputSource(operationArgs));
      secrets.set(key, value);
      return print({ key, location: secrets.describeLocation(key) });
    }
    if (operationArgs.length) throw new Error(`Usage: symphony secret ${operation} <key>`);
    if (operation === "delete") return print({ key, deleted: secrets.delete(key) });
    if (operation === "status") return print({ key, location: secrets.describeLocation(key) });
    throw new Error(`Unknown secret operation: ${operation}`);
  }
  print(`Symphony commands:
  symphony [start] [--no-open] [--no-plugins]
  symphony doctor | status | models | plugins | costs
  symphony objective <list|snapshot|frontier|runline|attentions|artifacts|checkpoints|strategy|follow|...> [--json]
  symphony capability <list|show|create|activate|deprecate|prepare> [--json]
  symphony messages <send|list|show|receipts|cancel|expire> [--json]
  symphony diagnostics export <agent-id> [--json]
  symphony session diagnostics <agent-id> [--json]
  symphony agents [--active]
  symphony observe <agent-id> [--level tldr|paragraph|full]
  symphony logs <agent-id> [--after cursor] [--limit count]
  symphony message <agent-id> <message> [--idempotency-key KEY]
  symphony cancel <agent-id> [--idempotency-key KEY]
  symphony workflows
  symphony run <workflow-id> [--input JSON | --input-file path] [--idempotency-key KEY]
  ${SECRET_SET_USAGE}
  symphony secret <delete|status> <key>`);
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
