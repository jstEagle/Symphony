import type { AgentWorkOrder } from "@symphony/protocol";

/**
 * The coordination bridge is deliberately described as data.  Drivers can
 * render this manifest into a system/developer prompt without coupling to
 * the MCP server (or to any optional capability/message-bus implementation).
 */
export type CoordinationToolAccess = "read-only" | "full-access";
export type CoordinationToolCategory =
  | "inspection"
  | "delegation"
  | "control"
  | "workflow"
  | "objective"
  | "attention"
  | "checkpoint"
  | "handoff"
  | "artifact"
  | "capability"
  | "message"
  | "diagnostic"
  | "presentation"
  | "extension";

export type CoordinationToolDefinition = {
  readonly name: string;
  readonly category: CoordinationToolCategory;
  /** A tool with this requirement is not advertised to a read-only worker. */
  readonly minimumAccess: CoordinationToolAccess;
  /** A tool with this flag is omitted when the daemon denies child creation. */
  readonly requiresCreationAuthority?: boolean;
};

/** Canonical names are the names registered by Symphony's MCP bridge. */
export const SYMPHONY_COORDINATION_TOOLS = [
  { name: "list_agents", category: "inspection", minimumAccess: "read-only" },
  { name: "create_agent", category: "delegation", minimumAccess: "read-only", requiresCreationAuthority: true },
  { name: "send_message", category: "control", minimumAccess: "read-only" },
  { name: "observe_agent", category: "inspection", minimumAccess: "read-only" },
  { name: "get_session_logs", category: "inspection", minimumAccess: "read-only" },
  { name: "cancel_agent", category: "control", minimumAccess: "full-access" },
  { name: "present_ui", category: "presentation", minimumAccess: "read-only" },
  { name: "list_workflows", category: "inspection", minimumAccess: "read-only" },
  { name: "register_workflow", category: "workflow", minimumAccess: "full-access" },
  { name: "run_workflow", category: "workflow", minimumAccess: "full-access" },
  { name: "cancel_run", category: "workflow", minimumAccess: "full-access" },
  { name: "list_plugin_tools", category: "inspection", minimumAccess: "read-only" },
  { name: "call_plugin_tool", category: "extension", minimumAccess: "full-access" },
  { name: "list_objectives", category: "objective", minimumAccess: "read-only" },
  { name: "get_objective", category: "objective", minimumAccess: "read-only" },
  { name: "get_objective_strategy", category: "control", minimumAccess: "read-only" },
  { name: "preview_objective_strategy", category: "control", minimumAccess: "full-access" },
  { name: "revise_objective_strategy", category: "control", minimumAccess: "full-access" },
  { name: "create_objective", category: "objective", minimumAccess: "read-only", requiresCreationAuthority: true },
  { name: "commit_objective_plan", category: "objective", minimumAccess: "read-only", requiresCreationAuthority: true },
  { name: "checkpoint_objective", category: "checkpoint", minimumAccess: "read-only", requiresCreationAuthority: true },
  { name: "request_objective_approval", category: "objective", minimumAccess: "read-only", requiresCreationAuthority: true },
  { name: "list_objective_attentions", category: "attention", minimumAccess: "read-only" },
  { name: "get_objective_attention", category: "attention", minimumAccess: "read-only" },
  { name: "resolve_objective_attention", category: "attention", minimumAccess: "read-only" },
  { name: "deliver_objective_signal", category: "control", minimumAccess: "read-only" },
  { name: "get_objective_checkpoint", category: "checkpoint", minimumAccess: "read-only" },
  { name: "list_objective_checkpoints", category: "checkpoint", minimumAccess: "read-only" },
  { name: "resume_objective_checkpoint", category: "checkpoint", minimumAccess: "full-access" },
  { name: "retry_objective_checkpoint_activity", category: "checkpoint", minimumAccess: "full-access" },
  { name: "fork_objective_checkpoint", category: "checkpoint", minimumAccess: "full-access" },
  { name: "list_objective_handoffs", category: "handoff", minimumAccess: "read-only" },
  { name: "get_objective_handoff", category: "handoff", minimumAccess: "read-only" },
  { name: "offer_objective_handoff", category: "handoff", minimumAccess: "full-access" },
  { name: "accept_objective_handoff", category: "handoff", minimumAccess: "full-access" },
  { name: "list_objective_artifacts", category: "artifact", minimumAccess: "read-only" },
  { name: "get_objective_artifact", category: "artifact", minimumAccess: "read-only" },
  { name: "publish_objective_artifact", category: "artifact", minimumAccess: "read-only" },
  { name: "list_capabilities", category: "capability", minimumAccess: "read-only" },
  { name: "get_capability", category: "capability", minimumAccess: "read-only" },
  { name: "prepare_capability_execution", category: "capability", minimumAccess: "read-only" },
  { name: "create_capability", category: "capability", minimumAccess: "read-only", requiresCreationAuthority: true },
  { name: "activate_capability", category: "capability", minimumAccess: "full-access" },
  { name: "deprecate_capability", category: "capability", minimumAccess: "full-access" },
  { name: "list_agent_messages", category: "message", minimumAccess: "read-only" },
  { name: "replay_agent_messages", category: "message", minimumAccess: "read-only" },
  { name: "get_agent_message_cursor", category: "message", minimumAccess: "read-only" },
  { name: "get_agent_message", category: "message", minimumAccess: "read-only" },
  { name: "send_agent_message", category: "message", minimumAccess: "read-only" },
  { name: "deliver_agent_message", category: "message", minimumAccess: "read-only" },
  { name: "mark_agent_message_unknown", category: "message", minimumAccess: "read-only" },
  { name: "read_agent_message", category: "message", minimumAccess: "read-only" },
  { name: "handle_agent_message", category: "message", minimumAccess: "read-only" },
  { name: "cancel_agent_message", category: "message", minimumAccess: "read-only" },
  { name: "expire_agent_message", category: "message", minimumAccess: "read-only" },
  { name: "get_session_diagnostics", category: "diagnostic", minimumAccess: "read-only" },
] as const satisfies readonly CoordinationToolDefinition[];

export type SymphonyCoordinationToolName = typeof SYMPHONY_COORDINATION_TOOLS[number]["name"];

export type CoordinationManifestTool = {
  readonly canonicalName: string;
  /** Exact name the native harness should call, including any MCP prefix. */
  readonly name: string;
  readonly category: CoordinationToolCategory;
  readonly available: boolean;
  readonly reason?: string;
};

export type CoordinationManifestExtension = {
  readonly name: string;
  readonly category: "capability-library" | "message-bus" | "extension";
};

export type CoordinationCapabilityManifest = {
  readonly access: CoordinationToolAccess;
  readonly depth: number;
  readonly maxDepth: number | null;
  readonly canCreate: boolean;
  readonly prefix: string | null;
  /** Every prefix observed when a session exposes more than one bridge. */
  readonly prefixes: readonly string[];
  readonly source: "discovered" | "prefix" | "canonical";
  readonly tools: readonly CoordinationManifestTool[];
  readonly extensions: readonly CoordinationManifestExtension[];
};

export type CoordinationContractOptions = {
  agentId?: string;
  canCreate?: boolean;
  maxDepth?: number | null;
  /** Names returned by the native tool inventory, including provider prefixes. */
  availableTools?: readonly string[];
  /** Alias useful to callers that preserve the tool-discovery vocabulary. */
  discoveredToolNames?: readonly string[];
  /** Prefix used by an adapter when discovery occurs before prompt creation. */
  toolPrefix?: string;
};

const knownByName = new Map(SYMPHONY_COORDINATION_TOOLS.map((tool) => [tool.name, tool]));

function asMaxDepth(workOrder: AgentWorkOrder, options: CoordinationContractOptions): number | null {
  if (options.maxDepth !== undefined) return options.maxDepth;
  const candidate = workOrder.metadata.maxDepth;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 ? candidate : null;
}

function discoveredNames(options: CoordinationContractOptions): readonly string[] | undefined {
  return options.availableTools ?? options.discoveredToolNames;
}

function canonicalName(name: string): string | null {
  if (knownByName.has(name as SymphonyCoordinationToolName)) return name as SymphonyCoordinationToolName;
  for (const tool of SYMPHONY_COORDINATION_TOOLS) {
    if (name.endsWith(`.${tool.name}`) || name.endsWith(`__${tool.name}`)) return tool.name;
  }
  return null;
}

function prefixFor(name: string, canonical: string): string | null {
  if (name === canonical) return "";
  if (name.endsWith(`.${canonical}`)) return name.slice(0, -canonical.length);
  if (name.endsWith(`__${canonical}`)) return name.slice(0, -canonical.length);
  return null;
}

function inaccessibleReason(tool: CoordinationToolDefinition, workOrder: AgentWorkOrder, manifest: Pick<CoordinationCapabilityManifest, "canCreate" | "maxDepth" | "access">): string | undefined {
  if (tool.requiresCreationAuthority && !manifest.canCreate) {
    if (manifest.maxDepth !== null && workOrder.depth >= manifest.maxDepth) {
      return `unavailable at delegation depth ${workOrder.depth}: configured maximum depth is ${manifest.maxDepth}`;
    }
    return "unavailable: Symphony did not grant creation authority to this work order";
  }
  if (tool.minimumAccess === "full-access" && manifest.access === "read-only") {
    return "unavailable: this work order has read-only access";
  }
  return undefined;
}

function extensionCategory(name: string): CoordinationManifestExtension["category"] {
  if (/(?:^|[._-])capabilit(?:y|ies)(?:$|[._-])/iu.test(name)) return "capability-library";
  if (/(?:^|[._-])message(?:s|[-_.])?(?:bus)?(?:$|[._-])/iu.test(name) || name.includes("message-bus")) return "message-bus";
  return "extension";
}

/** Build a prompt-safe, typed view of the powers granted to one work order. */
export function buildCoordinationCapabilityManifest(
  workOrder: AgentWorkOrder,
  options: CoordinationContractOptions = {},
): CoordinationCapabilityManifest {
  const names = discoveredNames(options);
  const maxDepth = asMaxDepth(workOrder, options);
  const canCreate = options.canCreate ?? (maxDepth === null || workOrder.depth < maxDepth);
  const access = workOrder.permissions;
  const source = names ? "discovered" : options.toolPrefix !== undefined ? "prefix" : "canonical";
  const discoveredPrefixes = names
    ? [...new Set(names.flatMap((name) => {
      const canonical = canonicalName(name);
      if (!canonical) return [];
      const prefix = prefixFor(name, canonical);
      return prefix === null ? [] : [prefix];
    }))]
    : [];
  const prefixes = options.toolPrefix !== undefined ? [options.toolPrefix] : discoveredPrefixes;
  const prefix = options.toolPrefix ?? (prefixes.length === 1 ? prefixes[0] ?? null : null);
  const allowedDiscovered = names
    ? names.filter((name) => canonicalName(name) !== null)
    : SYMPHONY_COORDINATION_TOOLS.map((tool) => `${options.toolPrefix ?? ""}${tool.name}`);
  const discoveredSet = new Set(allowedDiscovered);
  const tools = SYMPHONY_COORDINATION_TOOLS.map((tool): CoordinationManifestTool => {
    const exact = names?.find((candidate) => canonicalName(candidate) === tool.name)
      ?? `${options.toolPrefix ?? ""}${tool.name}`;
    const unavailable = inaccessibleReason(tool, workOrder, { canCreate, maxDepth, access });
    const discovered = names ? discoveredSet.has(exact) || names.some((name) => canonicalName(name) === tool.name) : true;
    return {
      canonicalName: tool.name,
      name: exact,
      category: tool.category,
      available: discovered && unavailable === undefined,
      ...(unavailable ? { reason: unavailable } : !discovered ? { reason: "not present in the discovered Symphony tool inventory" } : {}),
    };
  });
  const extensions = (names ?? []).filter((name) => canonicalName(name) === null).map((name) => ({ name, category: extensionCategory(name) }));
  return { access, depth: workOrder.depth, maxDepth, canCreate, prefix, prefixes, source, tools, extensions };
}

/** Deterministic text rendering shared by every native driver's prompt. */
export function renderCoordinationCapabilityManifest(manifest: CoordinationCapabilityManifest): string {
  const available = manifest.tools.filter((tool) => tool.available);
  const unavailable = manifest.tools.filter((tool) => !tool.available);
  const lines = [
    "Symphony coordination capability manifest (derived from this work order):",
    `- access: ${manifest.access}`,
    `- delegation depth: ${manifest.depth}${manifest.maxDepth === null ? " (unlimited)" : ` of ${manifest.maxDepth}`}`,
    `- child creation: ${manifest.canCreate ? "available when create_agent is exposed" : "unavailable"}`,
    `- tool-name source: ${manifest.source}${manifest.prefix === null ? "" : `; exact prefix: ${manifest.prefix || "(none)"}`}`,
    ...(manifest.prefixes.length > 1 ? [`- discovered prefixes: ${manifest.prefixes.join(", ")}`] : []),
    "- available Symphony tools (call the exact names below):",
    ...(available.length ? available.map((tool) => `  - ${tool.name} [${tool.category}]`) : ["  - none discovered"]),
  ];
  if (unavailable.length) {
    lines.push("- unavailable Symphony tools (do not claim they exist):");
    lines.push(...unavailable.map((tool) => `  - ${tool.name}: ${tool.reason ?? "unavailable"}`));
  }
  if (manifest.extensions.length) {
    lines.push("- detected optional extensions (use only their exact discovered names; no implementation is assumed):");
    lines.push(...manifest.extensions.map((extension) => `  - ${extension.name} [${extension.category}]`));
  }
  return lines.join("\n");
}
