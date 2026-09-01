import {
  validateObjectiveHandoffTarget,
  type ObjectiveHandoffAcceptanceRecord,
  type ObjectiveHandoffEnvelope,
} from "@symphony/protocol";
import { validateObjectiveHandoffWorkspace, type WorkspaceManifestTransitionValidation } from "./workspace-manifest.js";

/**
 * Native loops remain owned by their drivers.  This plan is the small bridge
 * the objective supervisor can use after an envelope is accepted: it selects
 * a new native attempt unless same-session continuity was explicitly proven.
 */
export type ObjectiveHandoffExecutionPlan = Readonly<{
  runId: string;
  objectiveId: string;
  taskId: string | null;
  nodeId: string | null;
  sourceAttemptId: string | null;
  targetAgentId: string | null;
  harness: string;
  model: string;
  mode: "new-attempt" | "same-native-session";
  nativeSessionId: string | null;
  nativeRunId: string | null;
  evidenceCheckpointId: string;
  evidenceEventCursor: number;
  workspaceManifestHash: string | null;
  workspaceValidation: WorkspaceManifestTransitionValidation | null;
}>;

export type ObjectiveHandoffExecutionOptions = Readonly<{
  /** Fresh target-side facts captured by the accepting runtime. */
  workspaceObservation?: unknown;
  /** Optional target manifest and explicit daemon-approved rebind proposal. */
  targetWorkspaceManifest?: unknown;
  rebindProposal?: unknown;
}>;

/**
 * Convert an immutable envelope plus an append-only acceptance into a driver-
 * neutral execution decision.  No transcript is returned or implied.
 */
export function objectiveHandoffExecutionPlan(
  envelope: ObjectiveHandoffEnvelope,
  acceptance: ObjectiveHandoffAcceptanceRecord,
  options: ObjectiveHandoffExecutionOptions = {},
): ObjectiveHandoffExecutionPlan {
  if (acceptance.status !== "accepted") throw new Error("A rejected objective handoff cannot be executed.");
  if (acceptance.envelopeId !== envelope.id || acceptance.runId !== envelope.runId || acceptance.objectiveId !== envelope.objectiveId) {
    throw new Error("Objective handoff acceptance lineage does not match its envelope.");
  }
  const compatibility = validateObjectiveHandoffTarget(envelope, {
    harness: acceptance.target.harness,
    permission: acceptance.target.permission,
    requiredCapabilities: acceptance.target.requiredCapabilities,
    capabilities: acceptance.capabilities,
  });
  if (!compatibility.ok) throw new Error(compatibility.reason);
  const sourceWorkspaceManifest = envelope.workspace?.workspaceManifest;
  const acceptedWorkspaceManifest = acceptance.workspaceManifest;
  if (sourceWorkspaceManifest && acceptedWorkspaceManifest
    && sourceWorkspaceManifest.manifestHash !== acceptedWorkspaceManifest.manifestHash
    && options.rebindProposal === undefined) {
    throw new Error(`Objective handoff workspace manifest mismatch: source ${sourceWorkspaceManifest.manifestHash}, target ${acceptedWorkspaceManifest.manifestHash}; explicit rebind required.`);
  }
  const workspaceValidation = options.workspaceObservation === undefined
    ? null
    : validateObjectiveHandoffWorkspace(
        envelope,
        options.workspaceObservation,
        options.targetWorkspaceManifest ?? acceptance.workspaceManifest,
        options.rebindProposal,
      );
  if (workspaceValidation && !workspaceValidation.ok) {
    const requirements = workspaceValidation.requirements.map((entry) => `${entry.action}: ${entry.message}`).join("; ");
    throw new Error(`Objective handoff workspace validation failed${requirements ? ` (${requirements})` : ""}.`);
  }
  const sameNativeSession = envelope.continuity.status === "proven"
    && acceptance.continuityStatus === "proven"
    && acceptance.nativeSessionId !== null
    && acceptance.nativeSessionId === envelope.source.nativeSessionId
    && acceptance.nativeRunId === envelope.source.nativeRunId;
  return {
    runId: envelope.runId,
    objectiveId: envelope.objectiveId,
    taskId: envelope.lineage.taskId,
    nodeId: envelope.lineage.nodeId,
    sourceAttemptId: envelope.lineage.attemptId,
    targetAgentId: acceptance.recipientAgentId,
    harness: acceptance.target.harness,
    model: acceptance.target.model,
    mode: sameNativeSession ? "same-native-session" : "new-attempt",
    nativeSessionId: sameNativeSession ? acceptance.nativeSessionId : null,
    nativeRunId: sameNativeSession ? acceptance.nativeRunId : null,
    evidenceCheckpointId: envelope.evidence.checkpoint.id,
    evidenceEventCursor: envelope.evidence.eventCursor,
    workspaceManifestHash: envelope.workspace?.workspaceManifest?.manifestHash ?? null,
    workspaceValidation,
  };
}
