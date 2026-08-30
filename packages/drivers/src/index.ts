import type { LoadedConfig, SecretStore } from "@symphony/config";
import { AcpDriver } from "./acp.js";
import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";
import { CursorDriver } from "./cursor.js";
import { OpenCodeDriver } from "./opencode.js";
import { PiDriver } from "./pi.js";
import { DriverRegistry } from "./registry.js";

export * from "./acp.js";
export * from "./claude.js";
export * from "./codex.js";
export * from "./common.js";
export * from "./cursor.js";
export * from "./opencode.js";
export * from "./pi.js";
export * from "./process.js";
export * from "./prompt.js";
export * from "./registry.js";

export function createDriverRegistry(loaded: LoadedConfig, secrets: SecretStore): DriverRegistry {
  const registry = new DriverRegistry();
  if (loaded.config.harnesses.codex.enabled) registry.register(new CodexDriver(loaded.config.harnesses.codex));
  if (loaded.config.harnesses.claude.enabled) registry.register(new ClaudeDriver(loaded.config.harnesses.claude));
  if (loaded.config.harnesses.cursor.enabled) registry.register(new CursorDriver(loaded.config.harnesses.cursor, secrets));
  if (loaded.config.harnesses.opencode.enabled) registry.register(new OpenCodeDriver(loaded.config.harnesses.opencode));
  if (loaded.config.harnesses.pi.enabled) registry.register(new PiDriver(loaded.config.harnesses.pi));
  if (loaded.config.harnesses.acp.some((agent) => agent.enabled)) registry.register(new AcpDriver(loaded.config.harnesses.acp));
  return registry;
}
