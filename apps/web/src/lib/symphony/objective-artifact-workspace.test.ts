import { describe, expect, it } from "vitest";
import type { ObjectiveArtifactRecord, ObjectiveArtifactReviewRecord } from "../../../../../packages/protocol/src/index.js";
import { projectObjectiveArtifactWorkspace } from "./objective-artifact-workspace";

const now = "2026-09-01T00:00:00.000Z";
function artifact(overrides: Partial<ObjectiveArtifactRecord>): ObjectiveArtifactRecord {
  return {
    version: 1,
    id: "artifact-1",
    objectiveId: "objective-1",
    runId: "run-1",
    planRevision: 2,
    taskId: "task-1",
    producerAgentId: "agent-1",
    attemptId: "attempt-1",
    controlNodeId: "node-1",
    kind: "code.diff",
    name: "changes.diff",
    mediaType: "text/x-diff",
    content: { files: [{ path: "src/app.ts", additions: 4, deletions: 2, status: "modified", content: "export const app = true;" }] },
    hash: "a".repeat(64),
    sizeBytes: 128,
    evidence: { eventCursor: 18, eventIds: ["event-18"], observationIds: ["observation-1"] },
    lineage: ["artifact-old"],
    supersedes: "artifact-old",
    reviewState: "pending",
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    publishedBy: { type: "agent", id: "agent-1" },
    publishedAt: now,
    ...overrides,
  };
}

describe("objective artifact workspace projection", () => {
  it("keeps daemon provenance and exposes changed-file churn", () => {
    const projection = projectObjectiveArtifactWorkspace({ artifacts: [artifact({})], reviews: [], eventCursor: 20 });
    expect(projection.counts).toMatchObject({ total: 1, diff: 1, pending: 1, superseded: 1 });
    expect(projection.items[0]).toMatchObject({
      kind: "diff",
      supersededBy: null,
      artifact: { producerAgentId: "agent-1", attemptId: "attempt-1", hash: "a".repeat(64) },
      files: [{ path: "src/app.ts", additions: 4, deletions: 2 }],
    });
    expect(projection.items[0]?.validation.state).toBe("pending");
    expect(projection.items[0]?.artifact.evidence.eventCursor).toBe(18);
  });

  it("parses unified diff files without treating headers as churn", () => {
    const value = artifact({ id: "artifact-2", kind: "diff", name: "patch.diff", content: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line\n" });
    const projection = projectObjectiveArtifactWorkspace({ artifacts: [value], reviews: [], eventCursor: 7 });
    expect(projection.items[0]?.files).toEqual([{ path: "a.ts", additions: 2, deletions: 1 }]);
    expect(projection.items[0]?.previewText).toContain("diff --git");
  });

  it("attaches review history and explicit unavailable validation", () => {
    const value = artifact({ id: "artifact-3", kind: "report", name: "report.json", content: { summary: "ready" }, reviewState: "verified" });
    const review: ObjectiveArtifactReviewRecord = {
      version: 1,
      id: "review-1",
      artifactId: value.id,
      objectiveId: value.objectiveId,
      runId: value.runId,
      fromState: "pending",
      state: "verified",
      actor: { type: "user", id: "web-ui" },
      reason: "Reviewed",
      requestKey: "request-review-1",
      createdAt: now,
    };
    const projection = projectObjectiveArtifactWorkspace({ artifacts: [value], reviews: [review], eventCursor: 9 });
    expect(projection.items[0]?.latestReview).toEqual(review);
    expect(projection.items[0]?.validation).toEqual({ state: "verified", detail: "Artifact review verified" });
  });
});
