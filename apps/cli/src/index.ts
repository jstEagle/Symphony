#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, SecretStore, writeDefaultConfig } from "@symphony/config";
import { startDaemon, SymphonyDaemon } from "@symphony/daemon";

const args = process.argv.slice(2);
while (args[0] === "--") args.shift();
const command = args[0] && !args[0].startsWith("-") ? args.shift() as string : "start";

async function request(path: string, options: RequestInit = {}): Promise<unknown> {
  const loaded = loadConfig();
  const url = `http://${loaded.config.server.host}:${loaded.config.server.port}${path}`;
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...options.headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return text ? JSON.parse(text) as unknown : null;
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  if (command === "start") {
    const daemon = await startDaemon({ noPlugins: args.includes("--no-plugins") });
    const url = `http://${daemon.loaded.config.server.host}:${daemon.loaded.config.server.port}`;
    print(`Symphony is running at ${url}`);
    if (daemon.loaded.config.server.openBrowser && !args.includes("--no-open")) spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    const close = async (): Promise<void> => { await daemon.close(); process.exit(0); };
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
    return;
  }
  if (command === "init") {
    print({ configPath: writeDefaultConfig(resolve(option("--root") ?? process.cwd()), args.includes("--force")) });
    return;
  }
  if (command === "doctor") {
    const daemon = new SymphonyDaemon({ noPlugins: true });
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
  if (command === "models") return print(await request("/v1/models"));
  if (command === "plugins") return print(await request("/v1/plugins"));
  if (command === "costs") return print(await request("/v1/costs"));
  if (command === "agents") return print(await request(`/v1/agents${args.includes("--active") ? "?active=true" : ""}`));
  if (command === "observe") {
    const id = args[0];
    if (!id) throw new Error("Usage: symphony observe <agent-id> [--level tldr|paragraph|full]");
    return print(await request(`/v1/agents/${encodeURIComponent(id)}/observe?level=${option("--level") ?? "tldr"}`));
  }
  if (command === "message") {
    const [id, ...content] = args;
    if (!id || !content.length) throw new Error("Usage: symphony message <agent-id> <message>");
    return print(await request(`/v1/agents/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ content: content.join(" ") }) }));
  }
  if (command === "cancel") {
    const id = args[0];
    if (!id) throw new Error("Usage: symphony cancel <agent-id>");
    return print(await request(`/v1/agents/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }));
  }
  if (command === "workflows") return print(await request("/v1/workflows"));
  if (command === "run") {
    const id = args[0];
    if (!id) throw new Error("Usage: symphony run <workflow-id> [--input JSON | --input-file path]");
    const inputFile = option("--input-file");
    const input = inputFile ? JSON.parse(readFileSync(resolve(inputFile), "utf8")) : JSON.parse(option("--input") ?? "{}");
    return print(await request(`/v1/workflows/${encodeURIComponent(id)}/runs`, { method: "POST", body: JSON.stringify(input) }));
  }
  if (command === "secret") {
    const [operation, key, value] = args;
    if (!operation || !key) throw new Error("Usage: symphony secret <set|delete|status> <key> [value]");
    const secrets = new SecretStore();
    if (operation === "set") {
      if (!value) throw new Error("A secret value is required.");
      secrets.set(key, value);
      return print({ key, location: secrets.describeLocation(key) });
    }
    if (operation === "delete") return print({ key, deleted: secrets.delete(key) });
    if (operation === "status") return print({ key, location: secrets.describeLocation(key) });
    throw new Error(`Unknown secret operation: ${operation}`);
  }
  print(`Symphony commands:
  symphony [start] [--no-open] [--no-plugins]
  symphony doctor | status | models | plugins | costs
  symphony agents [--active]
  symphony observe <agent-id> [--level tldr|paragraph|full]
  symphony message <agent-id> <message>
  symphony cancel <agent-id>
  symphony workflows
  symphony run <workflow-id> [--input JSON | --input-file path]
  symphony secret <set|delete|status> <key> [value]`);
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
