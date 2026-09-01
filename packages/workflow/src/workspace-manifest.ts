import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  WorkspaceManifestBodySchema,
  WorkspaceManifestCommandEvidenceSchema,
  createWorkspaceManifest,
  isPathWithin,
  parseWorkspaceManifest,
  stableWorkspaceJson,
  type WorkspaceManifest,
  type WorkspaceManifestBody,
  type WorkspaceManifestCheckpoint,
  type WorkspaceManifestCommandEvidence,
  type WorkspaceManifestFile,
} from "@symphony/protocol";
import type { ObjectiveCheckpointRecord, ObjectiveHandoffEnvelope } from "@symphony/protocol";
import { z } from "zod";

/** Runtime observation used for restart-safe manifest revalidation. */
export const WorkspaceManifestObservationSchema = z
  .object({
    cwd: z.string().min(1),
    workspaceRoot: z.string().min(1),
    repository: z.object({
      remote: z.string().min(1).optional(),
      root: z.string().min(1),
      gitDir: z.string().min(1),
      commonGitDir: z.string().min(1).optional(),
      branch: z.string().min(1).nullable(),
      ref: z.string().min(1),
      head: z.string().regex(/^[a-f0-9]{7,64}$/u),
    }).strict(),
    worktree: z.object({ id: z.string().min(1), path: z.string().min(1), gitDir: z.string().min(1), commonGitDir: z.string().min(1).optional() }).strict(),
    dirty: z.object({ clean: z.boolean(), digest: z.string().min(1), trackedCount: z.number().int().nonnegative(), untrackedCount: z.number().int().nonnegative(), ignoredCount: z.number().int().nonnegative(), changedPathsDigest: z.string().min(1).optional() }).strict(),
    files: z.array(z.object({ path: z.string().min(1), sha256: z.string().min(1), exists: z.boolean().default(true) }).strict()).default([]),
    changedPaths: z.array(z.string().min(1)).default([]),
    /** Setup observations contain hashes only; command output is never accepted. */
    commands: z.array(WorkspaceManifestCommandEvidenceSchema).max(1_000).optional(),
    permission: z.enum(["read-only", "full-access"]),
    capabilities: z.object({
      permission: z.enum(["read-only", "full-access"]).optional(),
      allowedPaths: z.array(z.string().min(1)).max(512).optional(),
      deniedPaths: z.array(z.string().min(1)).max(512).optional(),
    }).strict().optional(),
    checkpoint: z.object({ id: z.string().min(1), baseHead: z.string().min(1), diffSha256: z.string().min(1), pathsSha256: z.string().min(1) }).strict().optional(),
  })
  .strict();
export type WorkspaceManifestObservation = z.infer<typeof WorkspaceManifestObservationSchema>;

/** Capture is a pure constructor: all filesystem/git facts must be supplied by the caller. */
export const captureWorkspaceManifest = createWorkspaceManifest;

export type WorkspaceManifestIssueCode =
  | "manifest-invalid"
  | "workspace-root-mismatch"
  | "cwd-mismatch"
  | "cwd-out-of-scope"
  | "repository-mismatch"
  | "stale-ref"
  | "stale-head"
  | "worktree-moved"
  | "worktree-mismatch"
  | "dirty-state-mismatch"
  | "setup-evidence-missing"
  | "setup-mismatch"
  | "missing-file"
  | "missing-ignored-file"
  | "missing-local-setup"
  | "file-digest-mismatch"
  | "out-of-scope-path"
  | "permission-escalation"
  | "permission-mismatch"
  | "checkpoint-missing"
  | "checkpoint-mismatch";

export type WorkspaceManifestIssue = Readonly<{
  code: WorkspaceManifestIssueCode;
  message: string;
  path?: string;
  expected?: unknown;
  actual?: unknown;
}>;

export type WorkspaceManifestValidation = Readonly<{
  ok: boolean;
  manifestHash: string;
  issues: WorkspaceManifestIssue[];
  /** A rebind is required for identity drift; file/setup/permission drift must be repaired in place. */
  rebindRequired: boolean;
  requirements: ReadonlyArray<Readonly<{
    action: "rebind" | "repair" | "setup" | "permission" | "capture";
    code: WorkspaceManifestIssueCode;
    message: string;
    path?: string;
    expected?: unknown;
    actual?: unknown;
  }>>;
}>;

function issue(code: WorkspaceManifestIssueCode, message: string, path?: string, expected?: unknown, actual?: unknown): WorkspaceManifestIssue {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  };
}

const REBIND_ISSUES = new Set<WorkspaceManifestIssueCode>([
  "workspace-root-mismatch", "cwd-mismatch", "cwd-out-of-scope", "repository-mismatch",
  "stale-ref", "stale-head", "worktree-moved", "worktree-mismatch", "checkpoint-mismatch",
]);

function validationResult(manifestHash: string, issues: WorkspaceManifestIssue[]): WorkspaceManifestValidation {
  const requirements = issues.map((entry) => ({
    action: REBIND_ISSUES.has(entry.code)
      ? "rebind" as const
      : entry.code === "permission-escalation" || entry.code === "permission-mismatch"
        ? "permission" as const
        : entry.code === "setup-evidence-missing" || entry.code === "setup-mismatch" || entry.code === "missing-local-setup"
          ? "setup" as const
          : "repair" as const,
    code: entry.code,
    message: entry.message,
    ...(entry.path === undefined ? {} : { path: entry.path }),
    ...(entry.expected === undefined ? {} : { expected: entry.expected }),
    ...(entry.actual === undefined ? {} : { actual: entry.actual }),
  }));
  return { ok: issues.length === 0, manifestHash, issues, rebindRequired: issues.some((entry) => REBIND_ISSUES.has(entry.code)), requirements };
}

export type WorkspaceManifestTransitionOperation = "resume" | "fork" | "accept";
export type WorkspaceManifestTransitionStatus = "validated" | "validated-after-rebind" | "legacy-unbound" | "rebind-required";
export type WorkspaceManifestTransitionValidation = Readonly<WorkspaceManifestValidation & {
  operation: WorkspaceManifestTransitionOperation;
  status: WorkspaceManifestTransitionStatus;
}>;

function legacyTransition(operation: WorkspaceManifestTransitionOperation): WorkspaceManifestTransitionValidation {
  const base = validationResult("", []);
  return {
    ...base,
    operation,
    status: "legacy-unbound",
    requirements: [{ action: "capture", code: "manifest-invalid", message: "No workspace manifest is bound to this checkpoint/handoff; capture one before relying on workspace portability." }],
  };
}

/**
 * Validate a checkpoint/handoff workspace boundary against fresh runtime
 * facts. This is a pure gate: it never changes a manifest or performs a
 * rebind. Callers must explicitly persist an accepted rebind proposal.
 */
export function validateWorkspaceManifestTransition(input: Readonly<{
  operation: WorkspaceManifestTransitionOperation;
  manifest: unknown;
  observation: unknown;
  rebindProposal?: unknown;
}>): WorkspaceManifestTransitionValidation {
  let manifest: WorkspaceManifest;
  try {
    manifest = parseWorkspaceManifest(input.manifest);
  } catch (error) {
    const base = validationResult("", [issue("manifest-invalid", error instanceof Error ? error.message : String(error))]);
    return { ...base, operation: input.operation, status: "rebind-required" };
  }
  const validation = revalidateWorkspaceManifest(manifest, input.observation);
  if (validation.ok) return { ...validation, operation: input.operation, status: "validated" };
  if (input.rebindProposal !== undefined) {
    const rebound = validateWorkspaceRebind(input.rebindProposal, manifest, input.observation);
    if (rebound.ok) {
      const proposal = WorkspaceManifestRebindProposalSchema.parse(input.rebindProposal);
      const target = createWorkspaceManifest(proposal.target);
      return { ...rebound, manifestHash: target.manifestHash, operation: input.operation, status: "validated-after-rebind" };
    }
    return { ...rebound, operation: input.operation, status: "rebind-required" };
  }
  return { ...validation, operation: input.operation, status: "rebind-required" };
}

function checkpointManifest(checkpoint: ObjectiveCheckpointRecord): unknown | null {
  return checkpoint.workspaceManifest ?? checkpoint.workspaceEvidence?.workspaceManifest ?? null;
}

/** Validate resume/fork against the manifest captured at a checkpoint. */
export function validateObjectiveCheckpointWorkspace(
  checkpoint: ObjectiveCheckpointRecord,
  operation: Extract<WorkspaceManifestTransitionOperation, "resume" | "fork">,
  observation: unknown,
  rebindProposal?: unknown,
): WorkspaceManifestTransitionValidation {
  const manifest = checkpointManifest(checkpoint);
  if (!manifest) return legacyTransition(operation);
  return validateWorkspaceManifestTransition({ operation, manifest, observation, ...(rebindProposal === undefined ? {} : { rebindProposal }) });
}

function observationFromManifest(manifest: WorkspaceManifest): WorkspaceManifestObservation {
  return {
    cwd: manifest.cwd,
    workspaceRoot: manifest.workspaceRoot,
    repository: manifest.repository,
    worktree: manifest.worktree,
    dirty: manifest.dirty,
    files: manifest.files.map((file) => ({ path: file.path, sha256: file.sha256, exists: true })),
    changedPaths: [],
    commands: manifest.commands,
    permission: manifest.capabilities.permission,
    capabilities: {
      permission: manifest.capabilities.permission,
      allowedPaths: manifest.capabilities.allowedPaths,
      deniedPaths: manifest.capabilities.deniedPaths,
    },
    ...(manifest.checkpoint === undefined ? {} : {
      checkpoint: {
        id: manifest.checkpoint.id,
        baseHead: manifest.checkpoint.baseHead,
        diffSha256: manifest.checkpoint.diffSha256,
        pathsSha256: manifest.checkpoint.pathsSha256,
      },
    }),
  };
}

/**
 * Validate handoff acceptance against the source boundary and, when supplied,
 * the accepting runtime's target manifest. A changed target is never silently
 * accepted: callers receive a rebind requirement with exact drift issues.
 */
export function validateObjectiveHandoffWorkspace(
  envelope: ObjectiveHandoffEnvelope,
  observation: unknown,
  targetManifestInput?: unknown,
  rebindProposal?: unknown,
): WorkspaceManifestTransitionValidation {
  const source = envelope.workspace?.workspaceManifest;
  if (!source) return legacyTransition("accept");
  let parsedSource: WorkspaceManifest;
  try {
    parsedSource = parseWorkspaceManifest(source);
  } catch (error) {
    const base = validationResult("", [issue("manifest-invalid", error instanceof Error ? error.message : String(error))]);
    return { ...base, operation: "accept", status: "rebind-required" };
  }
  let target: WorkspaceManifest | null = null;
  if (targetManifestInput !== undefined && targetManifestInput !== null) {
    try {
      target = parseWorkspaceManifest(targetManifestInput);
    } catch (error) {
      const base = validationResult(parsedSource.manifestHash, [issue("manifest-invalid", error instanceof Error ? error.message : String(error))]);
      return { ...base, operation: "accept", status: "rebind-required" };
    }
  }
  const validation = validateWorkspaceManifestTransition({ operation: "accept", manifest: parsedSource, observation, ...(rebindProposal === undefined ? {} : { rebindProposal }) });
  if (!target || !validation.ok) return validation;
  const targetValidation = revalidateWorkspaceManifest(target, observation);
  if (!targetValidation.ok) return { ...targetValidation, operation: "accept", status: "rebind-required" };
  if (target.manifestHash === parsedSource.manifestHash) return validation;
  const comparison = revalidateWorkspaceManifest(parsedSource, observationFromManifest(target));
  return {
    ...comparison,
    operation: "accept",
    status: "rebind-required",
    requirements: comparison.requirements.length > 0
      ? comparison.requirements
      : [{ action: "rebind", code: "workspace-root-mismatch", message: `Target workspace manifest ${target.manifestHash} differs from source manifest ${parsedSource.manifestHash}; an explicit rebind proposal is required.` }],
    rebindRequired: true,
  };
}

function absoluteObservedPath(root: string, path: string): string {
  const portableAbsolute = isAbsolute(path) || path.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(path);
  return portableAbsolute ? path : `${root.replace(/[\\/]$/u, "")}/${path.replace(/\\/gu, "/")}`;
}

function capabilityContains(manifest: WorkspaceManifest, path: string): boolean {
  const absolute = absoluteObservedPath(manifest.workspaceRoot, path);
  const { root, allowedPaths, deniedPaths } = manifest.capabilities;
  if (!isPathWithin(root, absolute)) return false;
  if (deniedPaths.some((denied) => isPathWithin(denied, absolute))) return false;
  return allowedPaths.some((allowed) => isPathWithin(allowed, absolute));
}

/**
 * Revalidate a manifest against fresh git/filesystem facts.  This function is
 * deliberately pure; callers obtain facts with their normal git/filesystem
 * adapter and pass them in after a restart.
 */
export function revalidateWorkspaceManifest(input: unknown, observationInput: unknown): WorkspaceManifestValidation {
  const issues: WorkspaceManifestIssue[] = [];
  let manifest: WorkspaceManifest;
  try {
    manifest = parseWorkspaceManifest(input);
  } catch (error) {
    return validationResult("", [issue("manifest-invalid", error instanceof Error ? error.message : String(error))]);
  }
  let observation: WorkspaceManifestObservation;
  try {
    observation = WorkspaceManifestObservationSchema.parse(observationInput);
  } catch (error) {
    return validationResult(manifest.manifestHash, [issue("manifest-invalid", error instanceof Error ? error.message : String(error))]);
  }

  if (observation.workspaceRoot !== manifest.workspaceRoot || observation.repository.root !== manifest.workspaceRoot) {
    issues.push(issue("workspace-root-mismatch", `Workspace root mismatch: expected ${manifest.workspaceRoot}, got ${observation.workspaceRoot}.`, "workspaceRoot", manifest.workspaceRoot, observation.workspaceRoot));
  }
  if (observation.cwd !== manifest.cwd) issues.push(issue("cwd-mismatch", `cwd mismatch: expected ${manifest.cwd}, got ${observation.cwd}.`, observation.cwd, manifest.cwd, observation.cwd));
  if (!isPathWithin(manifest.workspaceRoot, observation.cwd)) issues.push(issue("cwd-out-of-scope", `cwd ${observation.cwd} is outside workspace root ${manifest.workspaceRoot}.`, observation.cwd, manifest.workspaceRoot, observation.cwd));

  if (observation.repository.remote !== manifest.repository.remote || observation.repository.gitDir !== manifest.repository.gitDir || observation.repository.commonGitDir !== manifest.repository.commonGitDir) {
    issues.push(issue("repository-mismatch", "Repository identity mismatch: root, remote, or git directory differs from the manifest.", "repository", manifest.repository, observation.repository));
  }
  if (observation.repository.branch !== manifest.repository.branch || observation.repository.ref !== manifest.repository.ref) {
    issues.push(issue("stale-ref", `Git ref mismatch: expected ${manifest.repository.ref} (${manifest.repository.branch ?? "detached"}), got ${observation.repository.ref} (${observation.repository.branch ?? "detached"}).`, "repository.ref", manifest.repository.ref, observation.repository.ref));
  }
  if (!observation.repository.head.startsWith(manifest.repository.head) && !manifest.repository.head.startsWith(observation.repository.head)) {
    issues.push(issue("stale-head", `Git HEAD mismatch: expected ${manifest.repository.head}, got ${observation.repository.head}.`, "repository.head", manifest.repository.head, observation.repository.head));
  }
  if (observation.worktree.path !== manifest.worktree.path) issues.push(issue("worktree-moved", `Worktree moved: expected ${manifest.worktree.path}, got ${observation.worktree.path}.`, "worktree.path", manifest.worktree.path, observation.worktree.path));
  if (observation.worktree.id !== manifest.worktree.id || observation.worktree.gitDir !== manifest.worktree.gitDir || observation.worktree.commonGitDir !== manifest.worktree.commonGitDir) {
    issues.push(issue("worktree-mismatch", "Worktree identity mismatch: id, git directory, or common git directory differs from the manifest.", "worktree", manifest.worktree, observation.worktree));
  }

  if (observation.dirty.clean !== manifest.dirty.clean || observation.dirty.digest !== manifest.dirty.digest || observation.dirty.trackedCount !== manifest.dirty.trackedCount || observation.dirty.untrackedCount !== manifest.dirty.untrackedCount || observation.dirty.ignoredCount !== manifest.dirty.ignoredCount || (observation.dirty.changedPathsDigest !== undefined && observation.dirty.changedPathsDigest !== manifest.dirty.changedPathsDigest)) {
    issues.push(issue("dirty-state-mismatch", "Dirty-state mismatch: clean flag, digest, changed-path digest, or file counts changed.", "dirty", manifest.dirty, observation.dirty));
  }

  if (manifest.commands.length > 0) {
    if (!observation.commands) issues.push(issue("setup-evidence-missing", "Setup/dependency command evidence is required to revalidate this manifest.", "commands"));
    else {
      const actualCommands = new Map(observation.commands.map((entry) => [`${entry.purpose}\u0000${entry.command}`, entry]));
      for (const expected of manifest.commands) {
        const actual = actualCommands.get(`${expected.purpose}\u0000${expected.command}`);
        if (!actual || actual.evidenceSha256 !== expected.evidenceSha256) issues.push(issue("setup-mismatch", `Setup evidence changed or is missing for command: ${expected.command}`, "commands", expected.evidenceSha256, actual?.evidenceSha256));
      }
    }
  }

  const observedFiles = new Map(observation.files.map((file) => [file.path.replace(/\\/gu, "/"), file]));
  for (const expected of manifest.files) {
    const actual = observedFiles.get(expected.path);
    if (!actual || !actual.exists) {
      issues.push(issue(expected.kind === "local-setup" ? "missing-local-setup" : expected.kind === "ignored" ? "missing-ignored-file" : "missing-file", `Manifest file is missing: ${expected.path}`, expected.path));
    } else if (actual.sha256 !== expected.sha256) {
      issues.push(issue("file-digest-mismatch", `Manifest file digest changed: ${expected.path}`, expected.path));
    }
    if (!capabilityContains(manifest, expected.path)) issues.push(issue("out-of-scope-path", `Manifest file is outside the capability boundary: ${expected.path}`, expected.path));
  }
  for (const changedPath of observation.changedPaths) {
    if (!capabilityContains(manifest, changedPath)) issues.push(issue("out-of-scope-path", `Observed changed path is outside the capability boundary: ${changedPath}`, changedPath));
  }
  if (manifest.capabilities.permission === "read-only" && observation.permission === "full-access") {
    issues.push(issue("permission-escalation", `Permission escalation: manifest allows ${manifest.capabilities.permission}, current ceiling is full-access.`, "capabilities.permission", manifest.capabilities.permission, observation.permission));
  } else if (manifest.capabilities.permission !== observation.permission) {
    issues.push(issue("permission-mismatch", `Permission mismatch: expected ${manifest.capabilities.permission}, got ${observation.permission}.`, "capabilities.permission", manifest.capabilities.permission, observation.permission));
  }
  if (observation.capabilities?.allowedPaths && stableWorkspaceJson(observation.capabilities.allowedPaths) !== stableWorkspaceJson(manifest.capabilities.allowedPaths)) {
    issues.push(issue("permission-mismatch", "Allowed capability paths differ from the manifest.", "capabilities.allowedPaths", manifest.capabilities.allowedPaths, observation.capabilities.allowedPaths));
  }
  if (observation.capabilities?.deniedPaths && stableWorkspaceJson(observation.capabilities.deniedPaths) !== stableWorkspaceJson(manifest.capabilities.deniedPaths)) {
    issues.push(issue("permission-mismatch", "Denied capability paths differ from the manifest.", "capabilities.deniedPaths", manifest.capabilities.deniedPaths, observation.capabilities.deniedPaths));
  }
  if (manifest.checkpoint) {
    const checkpoint = observation.checkpoint;
    if (!checkpoint) issues.push(issue("checkpoint-missing", "The checkpoint bound by the manifest is unavailable."));
    else if (checkpoint.id !== manifest.checkpoint.id || checkpoint.baseHead !== manifest.checkpoint.baseHead || checkpoint.diffSha256 !== manifest.checkpoint.diffSha256 || checkpoint.pathsSha256 !== manifest.checkpoint.pathsSha256) {
      issues.push(issue("checkpoint-mismatch", "The checkpoint/diff binding differs from the manifest."));
    }
  }
  return validationResult(manifest.manifestHash, issues);
}

export type WorkspaceManifestCommandEvidenceInput = Readonly<{
  command: string;
  purpose: "dependency" | "setup" | "verification";
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
}>;

/** Record evidence supplied by a caller; this never executes the command. */
export function recordWorkspaceCommandEvidence(input: WorkspaceManifestCommandEvidenceInput): WorkspaceManifestCommandEvidence {
  const stdoutSha256 = sha256(input.stdout ?? "");
  const stderrSha256 = sha256(input.stderr ?? "");
  const evidenceSha256 = sha256({ command: input.command, purpose: input.purpose, startedAt: input.startedAt, finishedAt: input.finishedAt, exitCode: input.exitCode, stdoutSha256, stderrSha256 });
  return WorkspaceManifestCommandEvidenceSchema.parse({
    command: input.command,
    purpose: input.purpose,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    exitCode: input.exitCode,
    stdoutSha256,
    stderrSha256,
    evidenceSha256,
  });
}

export function appendWorkspaceCommandEvidence(manifestInput: unknown, evidenceInput: WorkspaceManifestCommandEvidenceInput | WorkspaceManifestCommandEvidence): WorkspaceManifest {
  const manifest = parseWorkspaceManifest(manifestInput);
  const evidence = WorkspaceManifestCommandEvidenceSchema.parse("stdout" in evidenceInput || "stderr" in evidenceInput ? recordWorkspaceCommandEvidence(evidenceInput as WorkspaceManifestCommandEvidenceInput) : evidenceInput);
  const { manifestHash: _ignored, ...body } = manifest;
  return createWorkspaceManifest({ ...body, commands: [...manifest.commands, evidence] });
}

export const WorkspaceManifestRebindProposalSchema = z
  .object({ version: z.literal(1), sourceManifestHash: z.string().regex(/^[a-f0-9]{64}$/u), target: WorkspaceManifestBodySchema, proposedAt: z.string().min(1), proposalHash: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
export type WorkspaceManifestRebindProposal = z.infer<typeof WorkspaceManifestRebindProposalSchema>;

function proposalHash(proposal: Omit<WorkspaceManifestRebindProposal, "proposalHash">): string {
  return sha256(proposal);
}

/** Build an immutable proposal. Applying it is a separate validated operation. */
export function proposeWorkspaceRebind(manifestInput: unknown, targetInput: unknown, proposedAt: string): WorkspaceManifestRebindProposal {
  const manifest = parseWorkspaceManifest(manifestInput);
  const parsedTarget = WorkspaceManifestBodySchema.parse(targetInput);
  const target = WorkspaceManifestBodySchema.parse({ ...parsedTarget, provenance: { ...parsedTarget.provenance, source: "rebind" } });
  const unsigned = { version: 1 as const, sourceManifestHash: manifest.manifestHash, target, proposedAt };
  return WorkspaceManifestRebindProposalSchema.parse({ ...unsigned, proposalHash: proposalHash(unsigned) });
}

export function validateWorkspaceRebind(proposalInput: unknown, currentManifestInput: unknown, observationInput: unknown): WorkspaceManifestValidation {
  const issues: WorkspaceManifestIssue[] = [];
  let proposal: WorkspaceManifestRebindProposal;
  let current: WorkspaceManifest;
  try {
    proposal = WorkspaceManifestRebindProposalSchema.parse(proposalInput);
    current = parseWorkspaceManifest(currentManifestInput);
  } catch (error) {
    return validationResult("", [issue("manifest-invalid", error instanceof Error ? error.message : String(error))]);
  }
  const { proposalHash: _ignored, ...unsigned } = proposal;
  if (proposal.proposalHash !== proposalHash(unsigned)) issues.push(issue("manifest-invalid", "Rebind proposal hash mismatch."));
  if (proposal.sourceManifestHash !== current.manifestHash) issues.push(issue("manifest-invalid", "Rebind proposal is based on a stale manifest."));
  const target = createWorkspaceManifest(proposal.target);
  const validation = revalidateWorkspaceManifest(target, observationInput);
  issues.push(...validation.issues);
  return validationResult(current.manifestHash, issues);
}

/** Atomically return the target manifest only after every rebind check passes. */
export function applyWorkspaceRebind(proposalInput: unknown, currentManifestInput: unknown, observationInput: unknown): WorkspaceManifest {
  const validation = validateWorkspaceRebind(proposalInput, currentManifestInput, observationInput);
  if (!validation.ok) throw new Error(`Workspace rebind rejected: ${validation.issues.map((entry) => entry.message).join("; ")}`);
  const proposal = WorkspaceManifestRebindProposalSchema.parse(proposalInput);
  return createWorkspaceManifest(proposal.target);
}

function sha256(value: string | unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableWorkspaceJson(value)).digest("hex");
}

export type { WorkspaceManifest, WorkspaceManifestBody, WorkspaceManifestCheckpoint, WorkspaceManifestFile };
export { isPathWithin } from "../../protocol/src/workspace-manifest.js";
