import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const CommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

const HarnessUpdateSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  latest: z.discriminatedUnion("source", [
    z.object({ source: z.literal("npm"), packageName: z.string().min(1) }),
    z.object({ source: z.literal("installer"), url: z.string().url(), versionPattern: z.string().min(1) }),
    z.object({ source: z.literal("none") }),
  ]),
});

export const SymphonyConfigSchema = z.object({
  version: z.literal(1).default(1),
  dataDirectory: z.string().min(1).default(".symphony"),
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65_535).default(3210),
      openBrowser: z.boolean().default(true),
      webDirectory: z.string().default("apps/web/out"),
    })
    .prefault({}),
  conductor: z
    .object({
      harness: z.enum(["pi", "codex", "claude", "cursor", "opencode", "acp"]).default("pi"),
      model: z.string().default("auto"),
    })
    .prefault({}),
  agents: z
    .object({
      maxDepth: z.number().int().min(0).max(16).nullable().default(3),
      maxConcurrent: z.number().int().min(1).max(128).nullable().default(8),
      defaultPermissions: z.enum(["read-only", "full-access"]).default("full-access"),
    })
    .prefault({}),
  harnesses: z
    .object({
      codex: z
        .object({
          enabled: z.boolean().default(true),
          process: CommandSchema.default({ command: "codex", args: ["app-server"] }),
        })
        .prefault({}),
      claude: z
        .object({
          enabled: z.boolean().default(true),
          process: CommandSchema.default({ command: "claude", args: [] }),
        })
        .prefault({}),
      cursor: z
        .object({
          enabled: z.boolean().default(true),
          process: CommandSchema.default({ command: "cursor-agent", args: [] }),
          autoCreatePR: z.boolean().default(false),
        })
        .prefault({}),
      opencode: z
        .object({
          enabled: z.boolean().default(true),
          process: CommandSchema.default({ command: "opencode", args: ["serve"] }),
          baseUrl: z.string().url().default("http://127.0.0.1:4096"),
          autoStart: z.boolean().default(true),
        })
        .prefault({}),
      pi: z
        .object({
          enabled: z.boolean().default(true),
          process: CommandSchema.default({ command: "pi", args: ["--mode", "rpc"] }),
        })
        .prefault({}),
      acp: z
        .array(
          z.object({
            id: z.string().min(1),
            enabled: z.boolean().default(true),
            process: CommandSchema,
          }),
        )
        .default([]),
    })
    .prefault({}),
  harnessUpdates: z
    .object({
      checkIntervalMinutes: z.number().int().positive().default(10),
      harnesses: z.record(z.enum(["codex", "claude", "cursor", "opencode", "pi"]), HarnessUpdateSchema).default({
        codex: { command: "codex", args: ["update"], latest: { source: "npm", packageName: "@openai/codex" } },
        claude: { command: "claude", args: ["update"], latest: { source: "npm", packageName: "@anthropic-ai/claude-code" } },
        cursor: { command: "cursor-agent", args: ["update"], latest: { source: "installer", url: "https://cursor.com/install", versionPattern: "TEMP_EXTRACT_DIR=.*?\\.tmp-([0-9]{4}\\.[0-9]{2}\\.[0-9]{2}-[A-Za-z0-9]+)-" } },
        opencode: { command: "opencode", args: ["upgrade"], latest: { source: "npm", packageName: "opencode-ai" } },
        pi: { command: "pnpm", args: ["--filter", "@symphony/drivers", "update", "@earendil-works/pi-coding-agent", "--latest"], latest: { source: "npm", packageName: "@earendil-works/pi-coding-agent" } },
      }),
    })
    .prefault({}),
  observer: z
    .object({
      provider: z.enum(["openrouter", "deterministic"]).default("openrouter"),
      model: z.string().default("z-ai/glm-5.3-flash"),
      maxInputCharacters: z.number().int().positive().default(400_000),
      cache: z.boolean().default(true),
      baseUrl: z.string().url().default("https://openrouter.ai/api/v1"),
    })
    .prefault({}),
  uiUtilities: z
    .object({
      provider: z.enum(["openrouter", "deterministic"]).default("openrouter"),
      model: z.string().default("z-ai/glm-5.3-flash"),
      baseUrl: z.string().url().default("https://openrouter.ai/api/v1"),
      chatTitles: z.boolean().default(true),
      maxInputCharacters: z.number().int().positive().default(12_000),
    })
    .prefault({}),
  router: z
    .object({
      provider: z.enum(["openrouter", "neutral-lexical"]).default("openrouter"),
      reranker: z.string().default("cohere/rerank-v3.5"),
      baseUrl: z.string().url().default("https://openrouter.ai/api/v1"),
      catalogRefreshMinutes: z.number().int().positive().default(60),
      localCatalogFiles: z.array(z.string()).default([]),
      fallbackHarnessOrder: z
        .array(z.enum(["codex", "claude", "cursor", "opencode", "pi", "acp"]))
        .default(["codex", "claude", "cursor", "opencode", "pi", "acp"]),
    })
    .prefault({}),
  workflows: z
    .object({
      directory: z.string().default(".symphony/workflows"),
      maxLoopIterations: z.number().int().positive().default(100),
      triggersEnabled: z.boolean().default(true),
    })
    .prefault({}),
  plugins: z
    .object({
      roots: z.array(z.string()).default([".symphony/plugins"]),
      trusted: z.array(z.string()).default([]),
      watch: z.boolean().default(true),
      debounceMs: z.number().int().positive().default(250),
      keepBuilds: z.number().int().positive().default(3),
    })
    .prefault({}),
  telemetry: z
    .object({
      enabled: z.boolean().default(false),
      includeContent: z.boolean().default(false),
    })
    .prefault({}),
});

export type SymphonyConfig = z.infer<typeof SymphonyConfigSchema>;

export type LoadedConfig = {
  rootDirectory: string;
  configPath: string;
  config: SymphonyConfig;
  dataDirectory: string;
  webDirectory: string;
  workflowDirectory: string;
  pluginRoots: string[];
};

export const defaultConfig: SymphonyConfig = SymphonyConfigSchema.parse({});

function absoluteFrom(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

export function findProjectRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "symphony.config.json")) || existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function loadConfig(options: { rootDirectory?: string; configPath?: string } = {}): LoadedConfig {
  const rootDirectory = resolve(options.rootDirectory ?? findProjectRoot());
  const configPath = resolve(options.configPath ?? join(rootDirectory, "symphony.config.json"));
  const raw = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8")) as unknown
    : {};
  const config = SymphonyConfigSchema.parse(raw);
  return {
    rootDirectory,
    configPath,
    config,
    dataDirectory: absoluteFrom(rootDirectory, config.dataDirectory),
    webDirectory: absoluteFrom(rootDirectory, config.server.webDirectory),
    workflowDirectory: absoluteFrom(rootDirectory, config.workflows.directory),
    pluginRoots: config.plugins.roots.map((path) => absoluteFrom(rootDirectory, path)),
  };
}

export function writeDefaultConfig(rootDirectory: string, force = false): string {
  const path = resolve(rootDirectory, "symphony.config.json");
  if (existsSync(path) && !force) return path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(defaultConfig, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  return path;
}

export function writeConfig(path: string, value: SymphonyConfig): void {
  const config = SymphonyConfigSchema.parse(value);
  const target = resolve(path);
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  renameSync(temporary, target);
}

const secretEnvironmentNames: Record<string, string> = {
  "openrouter.apiKey": "OPENROUTER_API_KEY",
  "cursor.apiKey": "CURSOR_API_KEY",
  "anthropic.apiKey": "ANTHROPIC_API_KEY",
  "openai.apiKey": "OPENAI_API_KEY",
  "opencode.apiKey": "OPENCODE_API_KEY",
};

export class SecretStore {
  readonly servicePrefix: string;

  constructor(servicePrefix = "dev.symphony") {
    this.servicePrefix = servicePrefix;
  }

  get(key: string): string | null {
    const environmentName = secretEnvironmentNames[key];
    if (environmentName && process.env[environmentName]) return process.env[environmentName] ?? null;
    if (process.platform !== "darwin") return null;
    try {
      return execFileSync(
        "security",
        ["find-generic-password", "-a", userInfo().username, "-s", `${this.servicePrefix}.${key}`, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    if (process.platform !== "darwin") {
      const environmentName = secretEnvironmentNames[key] ?? key.toUpperCase().replaceAll(".", "_");
      throw new Error(`No OS keychain adapter is available. Supply the secret as ${environmentName}.`);
    }
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-a",
        userInfo().username,
        "-s",
        `${this.servicePrefix}.${key}`,
        "-w",
        value,
      ],
      { stdio: "ignore" },
    );
  }

  delete(key: string): boolean {
    if (process.platform !== "darwin") return false;
    try {
      execFileSync(
        "security",
        ["delete-generic-password", "-a", userInfo().username, "-s", `${this.servicePrefix}.${key}`],
        { stdio: "ignore" },
      );
      return true;
    } catch {
      return false;
    }
  }

  describeLocation(key: string): string {
    const environmentName = secretEnvironmentNames[key];
    if (environmentName && process.env[environmentName]) return `environment:${environmentName}`;
    if (process.platform === "darwin" && this.get(key)) return `keychain:${this.servicePrefix}.${key}`;
    return "missing";
  }
}

export function defaultRuntimeHome(): string {
  return join(homedir(), ".symphony");
}
