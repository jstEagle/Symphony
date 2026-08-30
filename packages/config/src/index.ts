import { spawnSync } from "node:child_process";
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
      shutdownTimeoutMs: z.number().int().min(100).max(120_000).default(10_000),
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
      routingTimeoutMs: z.number().int().min(10).max(600_000).default(30_000),
      startupTimeoutMs: z.number().int().min(10).max(600_000).default(60_000),
      recoveryTimeoutMs: z.number().int().min(10).max(600_000).default(30_000),
      recoveryConcurrency: z.number().int().min(1).max(32).default(4),
      cancellationAcknowledgementTimeoutMs: z.number().int().min(10).max(600_000).default(3_000),
      cancellationTerminationGraceMs: z.number().int().min(10).max(600_000).default(5_000),
    })
    .prefault({}),
  workerHosts: z
    .object({
      enabled: z.boolean().default(true),
      maxSpoolBytes: z.number().int().min(1_048_576).max(1_073_741_824).default(67_108_864),
      maxSpoolFrames: z.number().int().min(1_000).max(1_000_000).default(100_000),
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
      chatSearch: z
        .object({
          rerankEnabled: z.boolean().default(false),
          reranker: z.string().min(1).default("cohere/rerank-v3.5"),
          prefilterLimit: z.number().int().min(1).max(100).default(30),
          maxDocumentCharacters: z.number().int().min(256).max(50_000).default(4_000),
          cacheTtlSeconds: z.number().int().min(1).max(3_600).default(300),
          requestTimeoutMs: z.number().int().min(250).max(60_000).default(10_000),
        })
        .prefault({}),
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
  "opencode.serverMasterKey": "SYMPHONY_OPENCODE_SERVICE_KEY",
};

export const DAEMON_SECRET_KEY_PREFIX = "daemon.secret";
export const DAEMON_SECRET_ENVIRONMENT_VARIABLE = "SYMPHONY_DAEMON_SECRET";

export function isDaemonSecretKey(key: string): boolean {
  return key === DAEMON_SECRET_KEY_PREFIX || key.startsWith(`${DAEMON_SECRET_KEY_PREFIX}.`);
}

export function environmentWithoutDaemonSecret(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  for (const key of Object.keys(childEnvironment)) {
    if (key.toUpperCase() === DAEMON_SECRET_ENVIRONMENT_VARIABLE) delete childEnvironment[key];
  }
  return childEnvironment;
}

export function removeDaemonSecretFromProcessEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === DAEMON_SECRET_ENVIRONMENT_VARIABLE) delete process.env[key];
  }
}

function secretEnvironmentName(key: string): string | undefined {
  return isDaemonSecretKey(key) ? DAEMON_SECRET_ENVIRONMENT_VARIABLE : secretEnvironmentNames[key];
}

export interface NativeSecretBackend {
  get(service: string, account: string): string | null;
  set(service: string, account: string, value: string): void;
  delete(service: string, account: string): boolean;
}

export type KeychainCommandRunner = (
  args: string[],
  options: { input?: string; output: "capture" | "capture-error" | "ignore"; timeoutMs: number },
) => string;

const KEYCHAIN_COMMAND_TIMEOUT_MS = 5_000;
const MAX_KEYCHAIN_INTERACTIVE_COMMAND_BYTES = 4_095;

const runKeychainCommand: KeychainCommandRunner = (args, options) => {
  const result = spawnSync(
    "/usr/bin/security",
    args,
    {
      encoding: "utf8",
      ...(options.input === undefined ? {} : { input: options.input }),
      stdio: [
        "pipe",
        options.output === "capture" ? "pipe" : "ignore",
        options.output === "capture-error" ? "pipe" : "ignore",
      ],
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    throw new Error(timedOut ? "macOS Keychain operation timed out." : "macOS Keychain operation failed.");
  }
  const output = options.output === "capture-error" ? result.stderr : result.stdout;
  return typeof output === "string" ? output : "";
};

function quoteKeychainInteractiveArgument(value: string, label: string): string {
  if (/[\u0000\r\n]/u.test(value)) throw new Error(`macOS Keychain ${label} contains an unsupported control character.`);
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function decodeKeychainPassword(output: string): string {
  const line = output.replace(/\r?\n$/u, "");
  const quotedPrefix = "password: \"";
  if (line.startsWith(quotedPrefix) && line.endsWith("\"")) {
    return line.slice(quotedPrefix.length, -1);
  }
  const hexMatch = /^password: 0x([0-9a-fA-F]*)(?: {2}".*")?$/us.exec(line);
  if (!hexMatch || hexMatch[1]!.length % 2 !== 0) {
    throw new Error("macOS Keychain returned an unsupported password representation.");
  }
  const bytes = Buffer.from(hexMatch[1]!, "hex");
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    throw new Error("macOS Keychain password is not valid UTF-8 text.");
  }
  return value;
}

export class MacOsKeychainBackend implements NativeSecretBackend {
  constructor(
    private readonly run: KeychainCommandRunner = runKeychainCommand,
    private readonly keychainPath?: string,
  ) {}

  get(service: string, account: string): string | null {
    const output = this.run(
      ["find-generic-password", "-a", account, "-s", service, "-g", ...this.keychainArgs()],
      { output: "capture-error", timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS },
    );
    return decodeKeychainPassword(output);
  }

  set(service: string, account: string, value: string): void {
    const command = [
      "add-generic-password",
      "-U",
      "-a",
      quoteKeychainInteractiveArgument(account, "account"),
      "-s",
      quoteKeychainInteractiveArgument(service, "service"),
      "-X",
      quoteKeychainInteractiveArgument(Buffer.from(value, "utf8").toString("hex"), "password bytes"),
      ...this.keychainArgs().map((path) => quoteKeychainInteractiveArgument(path, "path")),
    ].join(" ") + "\n";
    if (Buffer.byteLength(command, "utf8") > MAX_KEYCHAIN_INTERACTIVE_COMMAND_BYTES) {
      throw new Error("macOS Keychain interactive command exceeds the supported length.");
    }
    // Interactive mode reads the complete command from stdin. Only the
    // non-secret `-i` selector appears in the child process argument vector.
    this.run(
      ["-i"],
      { input: command, output: "ignore", timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS },
    );
  }

  delete(service: string, account: string): boolean {
    this.run(
      ["delete-generic-password", "-a", account, "-s", service, ...this.keychainArgs()],
      { output: "ignore", timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS },
    );
    return true;
  }

  private keychainArgs(): string[] {
    return this.keychainPath ? [this.keychainPath] : [];
  }
}

export type SecretStoreOptions = {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  nativeBackend?: NativeSecretBackend;
  account?: string;
};

export class SecretStore {
  readonly servicePrefix: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly nativeBackend: NativeSecretBackend | null;
  private readonly account: string;
  private readonly platform: NodeJS.Platform;

  constructor(servicePrefix = "dev.symphony", options: SecretStoreOptions = {}) {
    this.servicePrefix = servicePrefix;
    const platform = options.platform ?? process.platform;
    this.platform = platform;
    this.environment = { ...(options.environment ?? process.env) };
    this.nativeBackend = options.nativeBackend ?? (platform === "darwin" ? new MacOsKeychainBackend() : null);
    this.account = options.account ?? userInfo().username;
  }

  get(key: string): string | null {
    const environmentName = secretEnvironmentName(key);
    if (environmentName) {
      const environmentValue = this.environment[environmentName]
        ?? (this.platform === "win32"
          ? Object.entries(this.environment).find(([name]) => name.toUpperCase() === environmentName)?.[1]
          : undefined);
      if (environmentValue) return environmentValue;
    }
    if (!this.nativeBackend) return null;
    try {
      return this.nativeBackend.get(`${this.servicePrefix}.${key}`, this.account);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    if (!this.nativeBackend) {
      const environmentName = secretEnvironmentName(key) ?? key.toUpperCase().replaceAll(".", "_");
      throw new Error(`No OS keychain adapter is available. Supply the secret as ${environmentName}.`);
    }
    this.nativeBackend.set(`${this.servicePrefix}.${key}`, this.account, value);
  }

  delete(key: string): boolean {
    if (!this.nativeBackend) return false;
    try {
      return this.nativeBackend.delete(`${this.servicePrefix}.${key}`, this.account);
    } catch {
      return false;
    }
  }

  describeLocation(key: string): string {
    const environmentName = secretEnvironmentName(key);
    if (environmentName && this.environment[environmentName]) return `environment:${environmentName}`;
    if (this.nativeBackend && this.get(key)) return `keychain:${this.servicePrefix}.${key}`;
    return "missing";
  }
}

export function defaultRuntimeHome(): string {
  return join(homedir(), ".symphony");
}
