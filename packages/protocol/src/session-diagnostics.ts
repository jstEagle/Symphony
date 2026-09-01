import { z } from "zod";

const IdSchema = z.string().min(1).max(256);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const IsoDateSchema = z.iso.datetime({ offset: true });

/** A reference is intentionally opaque: diagnostics never embed the referenced payload. */
export const SessionDiagnosticReferenceSchema = z.object({
  kind: z.enum(["attention", "artifact", "checkpoint", "trace", "observation", "workspace-manifest", "other"]),
  id: IdSchema,
  hash: HashSchema.optional(),
  label: z.string().max(500).optional(),
}).strict();
export type SessionDiagnosticReference = z.infer<typeof SessionDiagnosticReferenceSchema>;

export const SessionDiagnosticIdentitySchema = z.object({
  objectiveId: IdSchema.nullable(),
  runId: IdSchema.nullable(),
  agentId: IdSchema.nullable(),
  attemptId: IdSchema.nullable(),
  nativeSessionId: IdSchema.nullable(),
  nativeRunId: IdSchema.nullable(),
}).strict();
export type SessionDiagnosticIdentity = z.infer<typeof SessionDiagnosticIdentitySchema>;

/** Inclusive, monotonically ordered ranges over the durable event cursor. */
export const SessionDiagnosticEventCursorRangeSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
}).strict().refine((range) => range.to >= range.from, { message: "Event cursor range must end at or after its start" });
export type SessionDiagnosticEventCursorRange = z.infer<typeof SessionDiagnosticEventCursorRangeSchema>;

export const SessionDiagnosticAuthReadinessSchema = z.enum(["ready", "missing", "expired", "rejected", "unknown", "not-required"]);
export type SessionDiagnosticAuthReadiness = z.infer<typeof SessionDiagnosticAuthReadinessSchema>;

export const SessionDiagnosticHarnessReadinessSchema = z.object({
  harness: z.string().min(1).max(100),
  model: z.string().min(1).max(256).nullable(),
  version: z.string().max(256).nullable(),
  available: z.boolean(),
  auth: SessionDiagnosticAuthReadinessSchema,
  detail: z.string().max(2_000).optional(),
}).strict();
export type SessionDiagnosticHarnessReadiness = z.infer<typeof SessionDiagnosticHarnessReadinessSchema>;

export const SessionDiagnosticExitStateSchema = z.enum(["exited", "signaled", "not-started", "running", "unknown"]);
export type SessionDiagnosticExitState = z.infer<typeof SessionDiagnosticExitStateSchema>;

export const SessionDiagnosticExitSchema = z.object({
  process: z.string().min(1).max(100),
  state: SessionDiagnosticExitStateSchema,
  code: z.number().int().nullable(),
  signal: z.string().max(100).nullable(),
  stderr: z.string().max(16_384),
  stderrTruncated: z.boolean(),
  at: IsoDateSchema.nullable(),
}).strict();
export type SessionDiagnosticExit = z.infer<typeof SessionDiagnosticExitSchema>;

export const SessionDiagnosticCommandReceiptSchema = z.object({
  id: IdSchema,
  command: z.string().min(1).max(4_096),
  purpose: z.string().max(500),
  status: z.enum(["succeeded", "failed", "timed-out", "not-run", "unknown"]),
  exitCode: z.number().int().nullable(),
  stdout: z.string().max(8_192),
  stderr: z.string().max(8_192),
  outputTruncated: z.boolean(),
  cwd: z.string().max(1_000).nullable(),
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
}).strict();
export type SessionDiagnosticCommandReceipt = z.infer<typeof SessionDiagnosticCommandReceiptSchema>;

export const SessionDiagnosticLivenessSchema = z.enum(["alive", "stale", "dead", "unknown"]);
export type SessionDiagnosticLiveness = z.infer<typeof SessionDiagnosticLivenessSchema>;
export const SessionDiagnosticRecoveryEligibilitySchema = z.enum(["eligible", "ineligible", "unknown"]);
export type SessionDiagnosticRecoveryEligibility = z.infer<typeof SessionDiagnosticRecoveryEligibilitySchema>;
export const SessionDiagnosticLivenessSchemaRecord = z.object({
  state: SessionDiagnosticLivenessSchema,
  recovery: SessionDiagnosticRecoveryEligibilitySchema,
  reason: z.string().max(2_000),
}).strict();
export type SessionDiagnosticLivenessRecord = z.infer<typeof SessionDiagnosticLivenessSchemaRecord>;

export const SessionDiagnosticEnvironmentValueSchema = z.union([z.string().max(1_000), z.number().finite(), z.boolean(), z.null()]);
export const SessionDiagnosticEnvironmentSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u), SessionDiagnosticEnvironmentValueSchema);
export type SessionDiagnosticEnvironment = z.infer<typeof SessionDiagnosticEnvironmentSchema>;

export const SessionDiagnosticVerificationCommandSchema = z.object({
  command: z.string().min(1).max(4_096),
  purpose: z.string().min(1).max(500),
}).strict();
export type SessionDiagnosticVerificationCommand = z.infer<typeof SessionDiagnosticVerificationCommandSchema>;

export const SessionDiagnosticProvenanceSchema = z.object({
  source: z.string().min(1).max(200),
  generatedAt: IsoDateSchema,
  generatorVersion: z.string().min(1).max(200),
  parentHash: HashSchema.nullable(),
}).strict();
export type SessionDiagnosticProvenance = z.infer<typeof SessionDiagnosticProvenanceSchema>;

export const SessionDiagnosticTerminationSchema = z.enum(["terminal", "unknown", "running"]);
export type SessionDiagnosticTermination = z.infer<typeof SessionDiagnosticTerminationSchema>;

/**
 * A bounded, secret-free evidence envelope. References and excerpts are
 * deliberately separate so consumers can share this record without granting
 * access to the underlying workspace, transcript, or credential store.
 */
export const SessionDiagnosticBundleSchema = z.object({
  version: z.literal(1),
  identity: SessionDiagnosticIdentitySchema,
  termination: SessionDiagnosticTerminationSchema,
  eventCursorRanges: z.array(SessionDiagnosticEventCursorRangeSchema).max(256),
  harness: SessionDiagnosticHarnessReadinessSchema,
  exits: z.array(SessionDiagnosticExitSchema).max(32),
  commandReceipts: z.array(SessionDiagnosticCommandReceiptSchema).max(64),
  attentionRefs: z.array(SessionDiagnosticReferenceSchema).max(128),
  artifactRefs: z.array(SessionDiagnosticReferenceSchema).max(128),
  checkpointRefs: z.array(SessionDiagnosticReferenceSchema).max(128),
  workspaceManifestRef: SessionDiagnosticReferenceSchema.nullable(),
  liveness: SessionDiagnosticLivenessSchemaRecord,
  configHash: HashSchema.nullable(),
  policyHash: HashSchema.nullable(),
  environment: SessionDiagnosticEnvironmentSchema,
  verificationCommands: z.array(SessionDiagnosticVerificationCommandSchema).max(64),
  provenance: SessionDiagnosticProvenanceSchema,
  truncated: z.boolean(),
  contentHash: HashSchema,
}).strict();
export type SessionDiagnosticBundle = z.infer<typeof SessionDiagnosticBundleSchema>;

export const SESSION_DIAGNOSTIC_VERSION = 1 as const;
