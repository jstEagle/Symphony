import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import chokidar, { type FSWatcher } from "chokidar";
import { build } from "esbuild";
import { createJiti } from "jiti";
import { z } from "zod";
import type { LoadedConfig } from "@symphony/config";
import { JsonValueSchema, nowIso, type EventEnvelope, type JsonValue } from "@symphony/protocol";
import type { PluginStateRecord, SymphonyStore } from "@symphony/storage";

const PluginManifestSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/u),
  name: z.string().min(1),
  version: z.string().min(1),
  apiVersion: z.literal(1).default(1),
  entry: z.string().default("index.ts"),
  piCompatible: z.boolean().default(true),
  description: z.string().default(""),
  contributes: z.object({
    webEntry: z.string().optional(),
    workflows: z.array(z.string()).default([]),
    modelCatalogs: z.array(z.string()).default([]),
  }).prefault({}),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export type SymphonyPluginTool = {
  name: string;
  label?: string;
  description: string;
  parameters?: unknown;
  outputSchema?: unknown;
  execute: (...args: unknown[]) => unknown | Promise<unknown>;
};

export type SymphonyPluginCommand = {
  name: string;
  description: string;
  handler: (args: string, context: PluginCommandContext) => unknown | Promise<unknown>;
};

export type PluginCommandContext = { emit(type: string, payload: JsonValue): void };
export type PluginEventHandler = (event: EventEnvelope, context: PluginContext) => void | Promise<void>;
export type PluginContext = {
  pluginId: string;
  root: string;
  emit(type: string, payload: JsonValue): void;
};

export type LoadedPlugin = {
  manifest: PluginManifest;
  root: string;
  buildPath: string;
  hash: string;
  tools: Map<string, SymphonyPluginTool>;
  commands: Map<string, SymphonyPluginCommand>;
  handlers: Map<string, PluginEventHandler[]>;
  webEntry: string | null;
  workflowPaths: string[];
  modelCatalogPaths: string[];
};

type PluginFactory = (api: PluginApi) => void | Promise<void>;

export class PluginApi {
  readonly tools = new Map<string, SymphonyPluginTool>();
  readonly commands = new Map<string, SymphonyPluginCommand>();
  readonly handlers = new Map<string, PluginEventHandler[]>();

  registerTool(tool: SymphonyPluginTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Plugin tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  registerCommand(name: string, command: Omit<SymphonyPluginCommand, "name">): void {
    if (this.commands.has(name)) throw new Error(`Plugin command already registered: ${name}`);
    this.commands.set(name, { name, ...command });
  }

  on(event: string, handler: PluginEventHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  // Pi extensions can call these without failing when loaded by Symphony. They
  // are intentionally declarative; terminal-only presentation remains Pi's job.
  registerShortcut(): void {}
  registerFlag(): void {}
  registerProvider(): void {}
}

export class PluginHost {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private watcher: FSWatcher | null = null;
  private readonly jiti = createJiti(pathToFileURL(resolve(process.cwd(), "symphony.plugin-loader.mjs")).href, { interopDefault: true, moduleCache: false });

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly store: SymphonyStore,
    private readonly noPlugins = false,
  ) {}

  list(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  getTool(name: string): { plugin: LoadedPlugin; tool: SymphonyPluginTool } | null {
    for (const plugin of this.plugins.values()) {
      const tool = plugin.tools.get(name);
      if (tool) return { plugin, tool };
    }
    return null;
  }

  async start(): Promise<void> {
    if (this.noPlugins) return;
    for (const candidate of this.discover()) await this.reload(candidate).catch(() => undefined);
    if (this.loaded.config.plugins.watch) {
      this.watcher = chokidar.watch(this.loaded.pluginRoots, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: this.loaded.config.plugins.debounceMs, pollInterval: 50 } });
      const reload = (path: string): void => {
        const root = this.pluginRoot(path);
        if (root) void this.reload(root).catch(() => undefined);
      };
      this.watcher.on("add", reload).on("change", reload).on("unlink", reload);
    }
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
    for (const plugin of this.plugins.values()) await this.dispatchFor(plugin, "session_shutdown", this.syntheticEvent("session_shutdown", {}));
    this.plugins.clear();
  }

  async dispatch(event: EventEnvelope): Promise<void> {
    await Promise.allSettled(this.list().flatMap((plugin) => [
      this.dispatchFor(plugin, event.type, event),
      this.dispatchFor(plugin, "*", event),
    ]));
  }

  private discover(): string[] {
    const roots: string[] = [];
    for (const configuredRoot of this.loaded.pluginRoots) {
      if (!existsSync(configuredRoot)) continue;
      for (const entry of readdirSync(configuredRoot, { withFileTypes: true })) {
        const path = resolve(configuredRoot, entry.name);
        if (entry.isDirectory() && existsSync(join(path, "symphony.plugin.json"))) roots.push(path);
        else if (entry.isFile() && [".ts", ".mts", ".js", ".mjs"].includes(extname(entry.name))) roots.push(path);
      }
    }
    return roots;
  }

  private pluginRoot(path: string): string | null {
    for (const root of this.loaded.pluginRoots) {
      if (!resolve(path).startsWith(resolve(root))) continue;
      let current = path;
      while (current.startsWith(root)) {
        if (existsSync(join(current, "symphony.plugin.json"))) return current;
        if (dirname(current) === resolve(root)) return [".ts", ".mts", ".js", ".mjs"].includes(extname(path)) ? path : null;
        current = dirname(current);
      }
    }
    return null;
  }

  private async reload(rootOrFile: string): Promise<LoadedPlugin> {
    const manifest = this.readManifest(rootOrFile);
    const root = existsSync(rootOrFile) && extname(rootOrFile) ? dirname(rootOrFile) : rootOrFile;
    if (!this.loaded.config.plugins.trusted.includes(manifest.id)) {
      const state = this.state(manifest, root, "quarantined", null, null, `Plugin ${manifest.id} is not listed in plugins.trusted.`);
      this.store.savePluginState(state);
      throw new Error(state.error as string);
    }
    const entry = extname(rootOrFile) ? rootOrFile : resolve(root, manifest.entry);
    const hash = await this.hashPlugin(rootOrFile, entry);
    const previous = this.plugins.get(manifest.id);
    if (previous?.hash === hash) return previous;
    const buildDirectory = resolve(this.loaded.dataDirectory, "plugins", "builds", manifest.id, hash);
    const buildPath = resolve(buildDirectory, "index.mjs");
    mkdirSync(buildDirectory, { recursive: true });
    this.store.savePluginState(this.state(manifest, root, "building", hash, previous?.hash ?? null, null));
    try {
      await build({ entryPoints: [entry], outfile: buildPath, bundle: true, format: "esm", platform: "node", target: "node24", sourcemap: "inline", packages: "external" });
      const imported = await this.jiti.import(buildPath, { default: true }) as PluginFactory;
      if (typeof imported !== "function") throw new Error("Plugin must default-export a Pi-compatible factory function.");
      const api = new PluginApi();
      await imported(api);
      const plugin: LoadedPlugin = {
        manifest, root, buildPath, hash, tools: api.tools, commands: api.commands, handlers: api.handlers,
        webEntry: manifest.contributes.webEntry ? resolve(root, manifest.contributes.webEntry) : null,
        workflowPaths: manifest.contributes.workflows.map((path) => resolve(root, path)),
        modelCatalogPaths: manifest.contributes.modelCatalogs.map((path) => resolve(root, path)),
      };
      this.plugins.set(manifest.id, plugin);
      this.store.savePluginState(this.state(manifest, root, "active", hash, previous?.hash ?? null, null));
      this.prune(manifest.id);
      await this.dispatchFor(plugin, "session_start", this.syntheticEvent("session_start", { reason: previous ? "reload" : "startup" }));
      return plugin;
    } catch (error) {
      this.store.savePluginState(this.state(manifest, root, "failed", previous?.hash ?? null, previous?.hash ?? null, error instanceof Error ? error.message : String(error)));
      if (previous) this.plugins.set(manifest.id, previous);
      throw error;
    }
  }

  private readManifest(rootOrFile: string): PluginManifest {
    if (extname(rootOrFile)) {
      const id = basename(rootOrFile, extname(rootOrFile)).toLowerCase().replace(/[^a-z0-9._-]+/gu, "-");
      return PluginManifestSchema.parse({ id, name: id, version: "0.0.0-local", entry: basename(rootOrFile), piCompatible: true });
    }
    return PluginManifestSchema.parse(JSON.parse(readFileSync(join(rootOrFile, "symphony.plugin.json"), "utf8")));
  }

  private async hashPlugin(rootOrFile: string, entry: string): Promise<string> {
    const hash = createHash("sha256");
    if (extname(rootOrFile)) hash.update(readFileSync(rootOrFile));
    else {
      for (const path of this.sourceFiles(rootOrFile).sort()) {
        hash.update(path.slice(rootOrFile.length));
        hash.update(readFileSync(path));
      }
    }
    return hash.digest("hex").slice(0, 20);
  }

  private sourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist", ".next"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) files.push(...this.sourceFiles(path));
      else if ([".ts", ".mts", ".js", ".mjs", ".json", ".css"].includes(extname(entry.name))) files.push(path);
    }
    return files;
  }

  private state(manifest: PluginManifest, path: string, status: PluginStateRecord["status"], activeHash: string | null, previousHash: string | null, error: string | null): PluginStateRecord {
    return { id: manifest.id, version: manifest.version, path, status, activeHash, previousHash, error, manifest: manifest as unknown as JsonValue, updatedAt: nowIso() };
  }

  private async dispatchFor(plugin: LoadedPlugin, type: string, event: EventEnvelope): Promise<void> {
    const handlers = plugin.handlers.get(type) ?? [];
    const context: PluginContext = {
      pluginId: plugin.manifest.id,
      root: plugin.root,
      emit: (eventType, payload) => this.store.appendEvent({ type: `plugin.${plugin.manifest.id}.${eventType}`, workflowId: event.workflowId, runId: event.runId, agentId: event.agentId, occurredAt: nowIso(), payload, provenance: { source: "plugin" } }),
    };
    for (const handler of handlers) await handler(event, context);
  }

  private syntheticEvent(type: string, payload: JsonValue): EventEnvelope {
    return { id: `synthetic-${type}`, cursor: Math.max(1, this.store.latestCursor() + 1), type, workflowId: null, runId: null, agentId: null, occurredAt: nowIso(), payload, provenance: { source: "plugin" } };
  }

  private prune(pluginId: string): void {
    const root = resolve(this.loaded.dataDirectory, "plugins", "builds", pluginId);
    if (!existsSync(root)) return;
    const entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries.slice(this.loaded.config.plugins.keepBuilds)) rmSync(resolve(root, entry.name), { recursive: true, force: true });
  }
}

export { PluginManifestSchema };
