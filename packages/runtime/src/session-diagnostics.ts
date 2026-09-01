import { createHash } from "node:crypto";
import {
  SessionDiagnosticBundleSchema,
  type SessionDiagnosticBundle,
  type SessionDiagnosticCommandReceipt,
  type SessionDiagnosticEnvironment,
  type SessionDiagnosticEventCursorRange,
  type SessionDiagnosticExit,
  type SessionDiagnosticHarnessReadiness,
  type SessionDiagnosticReference,
  type SessionDiagnosticVerificationCommand,
  isTerminalAgentStatus,
  type AgentStatus,
  type WorkerProcessLeaseState,
} from "@symphony/protocol";

type UnknownRecord = Record<string, unknown>;
type RedactionPattern = RegExp | string;

export interface SessionDiagnosticRuntimeEvidence {
  status: AgentStatus;
  hasReusableSession: boolean;
  nativeSessionId?: string | null;
  leaseState?: WorkerProcessLeaseState | null;
  leaseNativeSessionId?: string | null;
  leaseError?: string | null;
}

export interface SessionDiagnosticRuntimeClassification {
  termination: "terminal" | "unknown" | "running";
  liveness: "alive" | "stale" | "dead" | "unknown";
  recovery: "eligible" | "ineligible" | "unknown";
  reason: string;
}

/**
 * Translate the durable agent projection plus runtime continuity evidence into
 * the diagnostic state. `idle` and `waiting` are reusable agent states, not
 * terminal states; a retained session proves that they are still live while a
 * lease without an attached in-memory session is only stale evidence.
 */
export function classifySessionDiagnosticRuntime(
  evidence: SessionDiagnosticRuntimeEvidence,
): SessionDiagnosticRuntimeClassification {
  const active = ["queued", "routing", "starting", "running", "cancel-requested"].includes(evidence.status);
  const reusable = evidence.status === "idle" || evidence.status === "waiting";
  const terminal = isTerminalAgentStatus(evidence.status);
  const leaseMatches = evidence.leaseState !== null
    && evidence.leaseState !== undefined
    && (!evidence.nativeSessionId
      || !evidence.leaseNativeSessionId
      || evidence.nativeSessionId === evidence.leaseNativeSessionId);
  const leaseActive = leaseMatches && ["reserved", "running", "orphaned"].includes(evidence.leaseState ?? "");
  const leaseUncertain = leaseMatches && evidence.leaseState === "unverified";
  const leaseCleanExit = leaseMatches && evidence.leaseState === "exited" && evidence.leaseError === null;
  const leaseDead = leaseMatches && (evidence.leaseState === "identity-mismatch" || (evidence.leaseState === "exited" && !leaseCleanExit));

  if (reusable) {
    if (evidence.hasReusableSession) {
      return {
        termination: "running",
        liveness: "alive",
        recovery: "eligible",
        reason: "The runtime retains a reusable native session for this idle/waiting agent.",
      };
    }
    if (leaseActive) {
      return {
        termination: "running",
        liveness: "stale",
        recovery: "eligible",
        reason: "A durable native-process lease exists, but this daemon has not attached a reusable session.",
      };
    }
    if (leaseDead) {
      return {
        termination: "unknown",
        liveness: "dead",
        recovery: "eligible",
        reason: "The reusable agent has no attached session and its durable native-process lease is no longer live.",
      };
    }
    return {
      termination: "unknown",
      liveness: "unknown",
      recovery: evidence.nativeSessionId ? "eligible" : "unknown",
      reason: "The agent is idle/waiting, but no current runtime session or conclusive lease evidence is available.",
    };
  }

  if (active) {
    return {
      termination: "running",
      liveness: leaseDead ? "dead" : evidence.hasReusableSession ? "alive" : leaseActive ? "stale" : "alive",
      recovery: "eligible",
      reason: leaseDead
        ? "The agent remains non-terminal, but its durable native-process lease is no longer live."
        : evidence.hasReusableSession
          ? "The runtime retains the agent's native session."
          : leaseActive
            ? "A durable native-process lease is present without an attached in-memory session."
            : "The durable agent projection is still active.",
    };
  }

  if (terminal) {
    return {
      termination: "terminal",
      liveness: evidence.hasReusableSession ? "alive" : leaseActive ? "stale" : leaseUncertain ? "unknown" : "dead",
      recovery: evidence.hasReusableSession || leaseActive ? "eligible" : "unknown",
      reason: evidence.hasReusableSession
        ? "The agent reached a terminal logical state, but the runtime still retains its native session."
        : "The durable agent projection is terminal and no live runtime session is retained.",
    };
  }

  return {
    termination: "unknown",
    liveness: "unknown",
    recovery: "unknown",
    reason: "The agent has an unrecognized runtime status and no safe liveness classification.",
  };
}

export interface SessionDiagnosticBuildInput {
  objectiveId?: unknown;
  runId?: unknown;
  agentId?: unknown;
  attemptId?: unknown;
  nativeSessionId?: unknown;
  nativeRunId?: unknown;
  identity?: Partial<Record<"objectiveId" | "runId" | "agentId" | "attemptId" | "nativeSessionId" | "nativeRunId", unknown>>;
  termination?: "terminal" | "unknown" | "running";
  eventCursorRanges?: unknown;
  eventRanges?: unknown;
  harness?: unknown;
  exits?: unknown;
  commandReceipts?: unknown;
  commands?: unknown;
  attentionRefs?: unknown;
  artifactRefs?: unknown;
  checkpointRefs?: unknown;
  workspaceManifestRef?: unknown;
  liveness?: unknown;
  configHash?: unknown;
  policyHash?: unknown;
  environment?: unknown;
  environmentMetadata?: unknown;
  verificationCommands?: unknown;
  provenance?: Partial<{ source: unknown; generatedAt: unknown; generatorVersion: unknown; parentHash: unknown }>;
}

export interface SessionDiagnosticBuildOptions {
  maxBytes?: number;
  maxExcerptBytes?: number;
  maxOutputBytes?: number;
  maxEventRanges?: number;
  maxReferences?: number;
  maxCommands?: number;
  redactionPatterns?: readonly RedactionPattern[];
  redactionReplacement?: string;
  environmentAllowlist?: readonly string[];
  generatedAt?: string;
  generatorVersion?: string;
  source?: string;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_EXCERPT_BYTES = 4 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024;
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu,
  /\b(Basic|Token)\s+[A-Za-z0-9._~+\/-]+=*/giu,
  /\b(?:api[_-]?key|access[_-]?key|secret|password|passwd|token|authorization)\s*[:=]\s*[^\s,;]+/giu,
  /\b(?:OPENAI|ANTHROPIC|GITHUB|AWS|AZURE|GOOGLE|VERCEL|RAILWAY)[A-Z0-9_]*\s*=\s*[^\s,;]+/gu,
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gu,
  /https?:\/\/[^\s/?#]+[^\s]*[?&](?:token|key|secret|password|sig|signature)=[^\s&#]+[^\s]*/giu,
];

function redactionConfig(options: SessionDiagnosticBuildOptions): Pick<SessionDiagnosticBuildOptions, "redactionPatterns" | "redactionReplacement"> {
  const config: Pick<SessionDiagnosticBuildOptions, "redactionPatterns" | "redactionReplacement"> = {};
  if (options.redactionPatterns !== undefined) config.redactionPatterns = options.redactionPatterns;
  if (options.redactionReplacement !== undefined) config.redactionReplacement = options.redactionReplacement;
  return config;
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function commandText(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => text(entry)).filter(Boolean).join(" ");
  return text(value);
}

function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 256) : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function redactPattern(pattern: RedactionPattern): RegExp {
  if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(escaped, "gu");
}

/** Redact common credential forms plus caller-supplied patterns. */
export function redactSessionDiagnosticText(value: string, options: Pick<SessionDiagnosticBuildOptions, "redactionPatterns" | "redactionReplacement"> = {}): string {
  const replacement = options.redactionReplacement ?? "[REDACTED]";
  const patterns = [...SECRET_PATTERNS, ...(options.redactionPatterns ?? []).map(redactPattern)];
  return patterns.reduce((result, pattern) => result.replace(pattern, replacement), value);
}

function truncateText(value: unknown, maxBytes: number, replacement: string, patterns: Pick<SessionDiagnosticBuildOptions, "redactionPatterns" | "redactionReplacement">): { value: string; truncated: boolean } {
  const safe = redactSessionDiagnosticText(text(value), patterns);
  const bytes = new TextEncoder().encode(safe);
  if (bytes.byteLength <= maxBytes) return { value: safe, truncated: false };
  const marker = `…${replacement}`;
  const markerBytes = new TextEncoder().encode(marker);
  const budget = Math.max(0, maxBytes - markerBytes.byteLength);
  let end = Math.min(safe.length, budget);
  while (end > 0 && new TextEncoder().encode(safe.slice(0, end)).byteLength > budget) end -= 1;
  return { value: `${safe.slice(0, end)}${marker}`.slice(0, Math.max(0, maxBytes)), truncated: true };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as UnknownRecord).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as UnknownRecord)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sessionDiagnosticCanonicalJson(bundle: SessionDiagnosticBundle): string {
  return canonicalJson(bundle);
}

export function sessionDiagnosticContentHash(bundle: Omit<SessionDiagnosticBundle, "contentHash">): string {
  return createHash("sha256").update(canonicalJson(bundle)).digest("hex");
}

function hash(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return /^[a-f0-9]{64}$/iu.test(value) ? value.toLowerCase() : createHash("sha256").update(value).digest("hex");
}

function iso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function normalizeRange(value: unknown): SessionDiagnosticEventCursorRange | null {
  const range = asRecord(value);
  const from = nonNegativeInt(range.from ?? range.start ?? range.startCursor ?? range.cursorStart ?? range.eventCursor);
  const to = nonNegativeInt(range.to ?? range.end ?? range.endCursor ?? range.cursorEnd ?? range.eventCursor);
  return from !== null && to !== null && to >= from ? { from, to } : null;
}

function normalizeReference(value: unknown, kind: SessionDiagnosticReference["kind"], patterns: Pick<SessionDiagnosticBuildOptions, "redactionPatterns" | "redactionReplacement">): SessionDiagnosticReference | null {
  if (typeof value === "string" && value.length > 0) return { kind, id: value.slice(0, 256) };
  const raw = asRecord(value);
  const referenceId = id(raw.id ?? raw.ref ?? raw.reference);
  if (!referenceId) return null;
  const output: SessionDiagnosticReference = { kind, id: referenceId };
  const referenceHash = hash(raw.hash);
  if (referenceHash) output.hash = referenceHash;
  const label = text(raw.label ?? raw.description);
  if (label) output.label = redactSessionDiagnosticText(label.slice(0, 500), patterns);
  return output;
}

function normalizeHarness(value: unknown, patterns: Pick<SessionDiagnosticBuildOptions, "redactionPatterns" | "redactionReplacement">): SessionDiagnosticHarnessReadiness {
  const raw = asRecord(value);
  const harness = redactSessionDiagnosticText(text(raw.harness ?? raw.name, "unknown").slice(0, 100), patterns) || "unknown";
  const modelText = text(raw.model);
  const versionText = text(raw.version ?? raw.harnessVersion ?? raw.runtimeVersion);
  const detailText = text(raw.detail ?? raw.reason);
  return {
    harness,
    model: modelText ? redactSessionDiagnosticText(modelText.slice(0, 256), patterns) : null,
    version: versionText ? redactSessionDiagnosticText(versionText.slice(0, 256), patterns) : null,
    available: typeof raw.available === "boolean" ? raw.available : false,
    auth: ["ready", "missing", "expired", "rejected", "unknown", "not-required"].includes(text(raw.auth ?? raw.authReadiness))
      ? text(raw.auth ?? raw.authReadiness) as SessionDiagnosticHarnessReadiness["auth"] : "unknown",
    ...(detailText ? { detail: redactSessionDiagnosticText(detailText.slice(0, 2_000), patterns) } : {}),
  };
}

function normalizeExit(value: unknown, maxExcerptBytes: number, patterns: Pick<SessionDiagnosticBuildOptions, "redactionPatterns" | "redactionReplacement">): SessionDiagnosticExit | null {
  const raw = asRecord(value);
  const process = text(raw.process ?? raw.name ?? raw.kind, "native").slice(0, 100);
  const code = typeof raw.code === "number" && Number.isInteger(raw.code) ? raw.code : null;
  const signal = typeof raw.signal === "string" ? redactSessionDiagnosticText(raw.signal.slice(0, 100), patterns) : null;
  let state: SessionDiagnosticExit["state"] = ["exited", "signaled", "not-started", "running", "unknown"].includes(text(raw.state))
    ? text(raw.state) as SessionDiagnosticExit["state"] : "unknown";
  if (state === "unknown") state = signal ? "signaled" : code !== null ? "exited" : "unknown";
  const excerpt = truncateText(raw.stderr ?? raw.error, maxExcerptBytes, patterns.redactionReplacement ?? "[REDACTED]", patterns);
  return {
    process,
    state,
    code,
    signal,
    stderr: excerpt.value,
    stderrTruncated: excerpt.truncated,
    at: iso(raw.at ?? raw.finishedAt ?? raw.exitedAt),
  };
}

function normalizeReceipt(value: unknown, maxOutputBytes: number, patterns: Pick<SessionDiagnosticBuildOptions, "redactionPatterns" | "redactionReplacement">, index: number): SessionDiagnosticCommandReceipt | null {
  const raw = asRecord(value);
  const command = commandText(raw.command ?? raw.argv);
  if (!command) return null;
  const stdout = truncateText(raw.stdout, maxOutputBytes, patterns.redactionReplacement ?? "[REDACTED]", patterns);
  const stderr = truncateText(raw.stderr, maxOutputBytes, patterns.redactionReplacement ?? "[REDACTED]", patterns);
  return {
    id: id(raw.id ?? raw.receiptId) ?? `command-${index + 1}`,
    command: redactSessionDiagnosticText(command.slice(0, 4_096), patterns),
    purpose: redactSessionDiagnosticText(text(raw.purpose ?? raw.reason), patterns).slice(0, 500),
    status: ["succeeded", "failed", "timed-out", "not-run", "unknown"].includes(text(raw.status)) ? text(raw.status) as SessionDiagnosticCommandReceipt["status"] : "unknown",
    exitCode: typeof raw.exitCode === "number" && Number.isInteger(raw.exitCode) ? raw.exitCode : null,
    stdout: stdout.value,
    stderr: stderr.value,
    outputTruncated: stdout.truncated || stderr.truncated,
    cwd: raw.cwd === null ? null : (text(raw.cwd) ? redactSessionDiagnosticText(text(raw.cwd).slice(0, 1_000), patterns) : null),
    startedAt: iso(raw.startedAt),
    finishedAt: iso(raw.finishedAt),
  };
}

function normalizeEnvironment(value: unknown, allowlist: readonly string[], patterns: Pick<SessionDiagnosticBuildOptions, "redactionPatterns" | "redactionReplacement">): SessionDiagnosticEnvironment {
  const raw = asRecord(value);
  const allowed = new Set(allowlist);
  const result: SessionDiagnosticEnvironment = {};
  for (const key of Object.keys(raw).sort()) {
    if (!allowed.has(key) || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(key)) continue;
    const entry = raw[key];
    if (typeof entry === "string") result[key] = redactSessionDiagnosticText(entry.slice(0, 1_000), patterns);
    else if (typeof entry === "number" && Number.isFinite(entry)) result[key] = entry;
    else if (typeof entry === "boolean" || entry === null) result[key] = entry;
  }
  return result;
}

function terminationFor(exits: readonly SessionDiagnosticExit[], explicit: SessionDiagnosticBuildInput["termination"]): "terminal" | "unknown" | "running" {
  if (explicit) return explicit;
  if (exits.some((entry) => entry.state === "running")) return "running";
  if (!exits.length || exits.some((entry) => entry.state === "unknown" || entry.state === "not-started")) return "unknown";
  return "terminal";
}

function boundedCandidate(bundle: UnknownRecord, maxBytes: number, options: { maxExcerptBytes: number; maxOutputBytes: number }): { bundle: UnknownRecord; truncated: boolean } {
  let truncated = Boolean(bundle.truncated);
  const byteLength = () => new TextEncoder().encode(canonicalJson(bundle)).byteLength;
  const shorten = (entry: UnknownRecord, field: string, minimum: number): boolean => {
    const value = entry[field];
    if (typeof value !== "string" || value.length <= minimum) return false;
    const next = truncateText(value, Math.max(minimum, Math.floor(new TextEncoder().encode(value).byteLength / 2)), "…", {});
    if (next.value === value) return false;
    entry[field] = next.value;
    return true;
  };
  while (byteLength() > maxBytes) {
    let changed = false;
    for (const exit of (bundle.exits as UnknownRecord[])) changed ||= shorten(exit, "stderr", 0);
    for (const receipt of (bundle.commandReceipts as UnknownRecord[])) {
      changed ||= shorten(receipt, "stdout", 0);
      changed ||= shorten(receipt, "stderr", 0);
    }
    changed ||= shorten(bundle.liveness as UnknownRecord, "reason", 0);
    changed ||= shorten(bundle.harness as UnknownRecord, "detail", 0);
    if (!changed) {
      const arrays: UnknownRecord[][] = [bundle.verificationCommands as UnknownRecord[], bundle.commandReceipts as UnknownRecord[], bundle.exits as UnknownRecord[], bundle.eventCursorRanges as UnknownRecord[], bundle.attentionRefs as UnknownRecord[], bundle.artifactRefs as UnknownRecord[], bundle.checkpointRefs as UnknownRecord[]];
      const target = arrays.find((array) => array.length > 0);
      if (target) { target.pop(); changed = true; }
    }
    if (!changed) {
      const environment = bundle.environment as UnknownRecord;
      const key = Object.keys(environment).sort().pop();
      if (key) { delete environment[key]; changed = true; }
    }
    if (!changed) throw new RangeError(`Session diagnostic bundle cannot fit within ${maxBytes} bytes`);
    truncated = true;
  }
  bundle.truncated = truncated;
  return { bundle, truncated };
}

/** Build a normalized, bounded bundle. No input secret is retained in the result. */
export function buildSessionDiagnosticBundle(input: SessionDiagnosticBuildInput, options: SessionDiagnosticBuildOptions = {}): SessionDiagnosticBundle {
  const patterns = redactionConfig(options);
  const maxExcerptBytes = Math.min(16_384, Math.max(0, options.maxExcerptBytes ?? DEFAULT_MAX_EXCERPT_BYTES));
  const maxOutputBytes = Math.min(8_192, Math.max(0, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES));
  const maxEventRanges = Math.min(256, Math.max(0, options.maxEventRanges ?? 256));
  const maxReferences = Math.min(128, Math.max(0, options.maxReferences ?? 128));
  const maxCommands = Math.min(64, Math.max(0, options.maxCommands ?? 64));
  const rawIdentity = asRecord(input.identity);
  const identity = {
    objectiveId: id(input.objectiveId ?? rawIdentity.objectiveId), runId: id(input.runId ?? rawIdentity.runId),
    agentId: id(input.agentId ?? rawIdentity.agentId), attemptId: id(input.attemptId ?? rawIdentity.attemptId),
    nativeSessionId: id(input.nativeSessionId ?? rawIdentity.nativeSessionId), nativeRunId: id(input.nativeRunId ?? rawIdentity.nativeRunId),
  };
  const rawRanges = input.eventCursorRanges ?? input.eventRanges;
  const rangesInput: unknown[] = Array.isArray(rawRanges) ? rawRanges : [];
  const ranges = (rangesInput as unknown[]).map(normalizeRange).filter((range): range is SessionDiagnosticEventCursorRange => range !== null)
    .sort((left, right) => left.from - right.from || left.to - right.to).slice(0, maxEventRanges);
  const exits = (Array.isArray(input.exits) ? input.exits : []).map((entry) => normalizeExit(entry, maxExcerptBytes, patterns)).filter((entry): entry is SessionDiagnosticExit => entry !== null).slice(0, 32);
  const rawExits = Array.isArray(input.exits) ? input.exits : [];
  const receiptsInput = input.commandReceipts ?? input.commands;
  const rawReceipts = Array.isArray(receiptsInput) ? receiptsInput : [];
  const commandReceipts = rawReceipts.map((entry, index) => normalizeReceipt(entry, maxOutputBytes, patterns, index)).filter((entry): entry is SessionDiagnosticCommandReceipt => entry !== null).slice(0, maxCommands);
  const refs = (value: unknown, kind: SessionDiagnosticReference["kind"]) => (Array.isArray(value) ? value : []).map((entry) => normalizeReference(entry, kind, patterns)).filter((entry): entry is SessionDiagnosticReference => entry !== null).slice(0, maxReferences);
  const workspaceManifestRef = normalizeReference(input.workspaceManifestRef, "workspace-manifest", patterns);
  const livenessRaw = asRecord(input.liveness);
  const livenessState = ["alive", "stale", "dead", "unknown"].includes(text(livenessRaw.state)) ? text(livenessRaw.state) : "unknown";
  const recoveryValue = livenessRaw.recovery ?? livenessRaw.recoveryEligibility;
  const recovery = typeof recoveryValue === "boolean"
    ? (recoveryValue ? "eligible" : "ineligible")
    : ["eligible", "ineligible", "unknown"].includes(text(recoveryValue)) ? text(recoveryValue) : "unknown";
  const rawVerificationCommands = Array.isArray(input.verificationCommands) ? input.verificationCommands : [];
  const verificationCommands: SessionDiagnosticVerificationCommand[] = rawVerificationCommands.map((entry) => {
    const raw = asRecord(entry);
    return { command: redactSessionDiagnosticText(commandText(raw.command ?? raw.argv), patterns).slice(0, 4_096), purpose: redactSessionDiagnosticText(text(raw.purpose), patterns).slice(0, 500) };
  }).filter((entry) => entry.command && entry.purpose).slice(0, maxCommands);
  const provenanceRaw = input.provenance ?? {};
  const provenance = {
    source: redactSessionDiagnosticText(text(provenanceRaw.source, options.source ?? "symphony").slice(0, 200), patterns),
    generatedAt: iso(provenanceRaw.generatedAt ?? options.generatedAt) ?? new Date().toISOString(),
    generatorVersion: redactSessionDiagnosticText(text(provenanceRaw.generatorVersion, options.generatorVersion ?? "unknown").slice(0, 200), patterns),
    parentHash: hash(provenanceRaw.parentHash),
  };
  const candidate: UnknownRecord = {
    version: 1,
    identity,
    termination: terminationFor(exits, input.termination),
    eventCursorRanges: ranges,
    harness: normalizeHarness(input.harness, patterns),
    exits,
    commandReceipts,
    attentionRefs: refs(input.attentionRefs, "attention"),
    artifactRefs: refs(input.artifactRefs, "artifact"),
    checkpointRefs: refs(input.checkpointRefs, "checkpoint"),
    workspaceManifestRef,
    liveness: { state: livenessState, recovery, reason: redactSessionDiagnosticText(text(livenessRaw.reason), patterns).slice(0, 2_000) },
    configHash: hash(input.configHash),
    policyHash: hash(input.policyHash),
    environment: normalizeEnvironment(input.environment ?? input.environmentMetadata, options.environmentAllowlist ?? [], patterns),
    verificationCommands,
    provenance,
    truncated: rangesInput.length > ranges.length || exits.length < rawExits.length || commandReceipts.length < rawReceipts.length || verificationCommands.length < rawVerificationCommands.length,
    contentHash: "0".repeat(64),
  };
  boundedCandidate(candidate, options.maxBytes ?? DEFAULT_MAX_BYTES, { maxExcerptBytes, maxOutputBytes });
  delete candidate.contentHash;
  candidate.contentHash = sessionDiagnosticContentHash(candidate as Omit<SessionDiagnosticBundle, "contentHash">);
  return SessionDiagnosticBundleSchema.parse(candidate);
}

export function sessionDiagnosticJson(bundle: SessionDiagnosticBundle): string {
  return sessionDiagnosticCanonicalJson(SessionDiagnosticBundleSchema.parse(bundle));
}

export function sessionDiagnosticHumanText(bundle: SessionDiagnosticBundle): string {
  const value = SessionDiagnosticBundleSchema.parse(bundle);
  const lines = [
    `Symphony session diagnostic v${value.version}`,
    `identity objective=${value.identity.objectiveId ?? "unknown"} run=${value.identity.runId ?? "unknown"} agent=${value.identity.agentId ?? "unknown"} attempt=${value.identity.attemptId ?? "unknown"} nativeSession=${value.identity.nativeSessionId ?? "unknown"}`,
    `termination=${value.termination} liveness=${value.liveness.state} recovery=${value.liveness.recovery}`,
    `harness=${value.harness.harness} model=${value.harness.model ?? "unknown"} version=${value.harness.version ?? "unknown"} available=${value.harness.available} auth=${value.harness.auth}`,
    `event-cursors=${value.eventCursorRanges.map((range) => `${range.from}-${range.to}`).join(",") || "none"}`,
    `exits=${value.exits.length} command-receipts=${value.commandReceipts.length} attention=${value.attentionRefs.length} artifacts=${value.artifactRefs.length} checkpoints=${value.checkpointRefs.length}`,
    `config-hash=${value.configHash ?? "none"} policy-hash=${value.policyHash ?? "none"} truncated=${value.truncated}`,
    `content-hash=${value.contentHash}`,
  ];
  for (const exit of value.exits) lines.push(`exit ${exit.process}: state=${exit.state} code=${exit.code ?? "none"} signal=${exit.signal ?? "none"}${exit.stderr ? ` stderr=${exit.stderr}` : ""}`);
  for (const receipt of value.commandReceipts) lines.push(`command ${receipt.id}: ${receipt.status} ${receipt.command}`);
  return lines.join("\n");
}

export function isSessionDiagnosticTerminal(bundle: SessionDiagnosticBundle): boolean {
  return SessionDiagnosticBundleSchema.parse(bundle).termination === "terminal";
}

export function verifySessionDiagnosticContentHash(bundle: SessionDiagnosticBundle): boolean {
  const parsed = SessionDiagnosticBundleSchema.parse(bundle);
  const { contentHash: _contentHash, ...content } = parsed;
  return sessionDiagnosticContentHash(content) === parsed.contentHash;
}

/** Compatibility aliases for callers that use the plural domain name. */
export const buildSessionDiagnostics = buildSessionDiagnosticBundle;
export const sessionDiagnosticsJson = sessionDiagnosticJson;
export const sessionDiagnosticsHumanText = sessionDiagnosticHumanText;
