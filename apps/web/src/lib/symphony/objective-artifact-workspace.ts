import type {
  ObjectiveArtifactRecord,
  ObjectiveArtifactReviewRecord,
} from "../../../../../packages/protocol/src/index.js";

export type ArtifactFileChange = {
  path: string;
  additions: number;
  deletions: number;
  status?: string;
  oldPath?: string;
  content?: string | null;
  diff?: string | null;
};

export type ObjectiveArtifactViewKind = "code" | "diff" | "test" | "log" | "other";

export type ObjectiveArtifactWorkspaceItem = {
  artifact: ObjectiveArtifactRecord;
  reviews: ObjectiveArtifactReviewRecord[];
  latestReview: ObjectiveArtifactReviewRecord | null;
  kind: ObjectiveArtifactViewKind;
  files: ArtifactFileChange[];
  previewText: string | null;
  validation: { state: "verified" | "rejected" | "pending" | "unavailable"; detail: string };
  supersededBy: string | null;
};

export type ObjectiveArtifactWorkspaceProjection = {
  items: ObjectiveArtifactWorkspaceItem[];
  files: ArtifactFileChange[];
  eventCursor: number;
  counts: { total: number; code: number; diff: number; test: number; log: number; pending: number; superseded: number };
};

/**
 * Adapt daemon-owned artifact records into a presentation model. This only
 * reads inline content already present in the snapshot; it never searches the
 * local filesystem or infers a workspace diff from a chat transcript.
 */
export function projectObjectiveArtifactWorkspace(input: {
  artifacts: readonly ObjectiveArtifactRecord[];
  reviews: readonly ObjectiveArtifactReviewRecord[];
  eventCursor: number;
}): ObjectiveArtifactWorkspaceProjection {
  const reviewsByArtifact = new Map<string, ObjectiveArtifactReviewRecord[]>();
  for (const review of input.reviews) {
    const current = reviewsByArtifact.get(review.artifactId) ?? [];
    current.push(review);
    reviewsByArtifact.set(review.artifactId, current);
  }
  const supersededBy = new Map<string, string>();
  for (const artifact of input.artifacts) if (artifact.supersedes) supersededBy.set(artifact.supersedes, artifact.id);

  const items = [...input.artifacts]
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt) || right.id.localeCompare(left.id))
    .map((artifact) => {
      const reviews = [...(reviewsByArtifact.get(artifact.id) ?? [])].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      const files = extractArtifactFiles(artifact);
      const kind = artifactViewKind(artifact);
      return {
        artifact,
        reviews,
        latestReview: reviews[0] ?? null,
        kind,
        files,
        previewText: extractPreviewText(artifact, kind, files),
        validation: validationFor(artifact),
        supersededBy: supersededBy.get(artifact.id) ?? null,
      };
    });
  const files = items.flatMap((item) => item.files);
  return {
    items,
    files,
    eventCursor: input.eventCursor,
    counts: {
      total: items.length,
      code: items.filter((item) => item.kind === "code").length,
      diff: items.filter((item) => item.kind === "diff").length,
      test: items.filter((item) => item.kind === "test").length,
      log: items.filter((item) => item.kind === "log").length,
      pending: items.filter((item) => item.artifact.reviewState === "pending").length,
      superseded: items.filter((item) => item.supersededBy !== null || item.artifact.supersedes !== null || item.artifact.reviewState === "superseded").length,
    },
  };
}

export const projectObjectiveArtifacts = projectObjectiveArtifactWorkspace;

function artifactViewKind(artifact: ObjectiveArtifactRecord): ObjectiveArtifactViewKind {
  const value = `${artifact.kind} ${artifact.mediaType} ${artifact.name}`.toLocaleLowerCase();
  if (/(^|[.:/_-])(test|tests|junit|coverage|vitest|jest)([.:/_-]|$)/u.test(value)) return "test";
  if (/(^|[.:/_-])(log|logs|stderr|stdout)([.:/_-]|$)/u.test(value) || artifact.mediaType.startsWith("text/log")) return "log";
  if (/(diff|patch|change)/u.test(value) || hasDiffContent(artifact.content)) return "diff";
  if (/(code|file|source|workspace)/u.test(value) || extractArtifactFiles(artifact).length > 0) return "code";
  return "other";
}

function extractArtifactFiles(artifact: ObjectiveArtifactRecord): ArtifactFileChange[] {
  const content = artifact.content;
  const candidates: unknown[] = [];
  if (Array.isArray(content)) candidates.push(content);
  if (record(content)) for (const key of ["files", "changedFiles", "changes", "fileChanges"]) if (Array.isArray(content[key])) candidates.push(content[key]);
  const nestedDiff = record(content) ? content.diff : null;
  if (record(nestedDiff) && Array.isArray(nestedDiff.files)) candidates.push(nestedDiff.files);
  const files = candidates.flatMap((candidate) => Array.isArray(candidate) ? candidate : []).flatMap(fileChange).filter(Boolean) as ArtifactFileChange[];
  if (files.length > 0) return uniqueFiles(files);
  if (typeof content === "string") return uniqueFiles(parseUnifiedDiff(content));
  return [];
}

function fileChange(value: unknown): ArtifactFileChange | null {
  if (!record(value) || typeof value.path !== "string" || !value.path.trim()) return null;
  return {
    path: value.path,
    additions: number(value.additions ?? value.added ?? value.insertions),
    deletions: number(value.deletions ?? value.deleted ?? value.removals),
    status: typeof value.status === "string" ? value.status : typeof value.kind === "string" ? value.kind : undefined,
    oldPath: typeof value.oldPath === "string" ? value.oldPath : typeof value.previousPath === "string" ? value.previousPath : undefined,
    content: typeof value.content === "string" ? value.content : null,
    diff: typeof value.diff === "string" ? value.diff : null,
  };
}

function parseUnifiedDiff(content: string): ArtifactFileChange[] {
  const files: ArtifactFileChange[] = [];
  let current: ArtifactFileChange | null = null;
  for (const line of content.split("\n")) {
    if (line.startsWith("+++ b/")) {
      current = { path: line.slice(6).trim(), additions: 0, deletions: 0 };
      files.push(current);
      continue;
    }
    if (!current || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) current.additions += 1;
    if (line.startsWith("-")) current.deletions += 1;
  }
  return files;
}

function extractPreviewText(artifact: ObjectiveArtifactRecord, kind: ObjectiveArtifactViewKind, files: ArtifactFileChange[]): string | null {
  if (typeof artifact.content === "string") return artifact.content;
  if (files.length === 1 && files[0]?.content) return files[0].content;
  if (record(artifact.content)) {
    for (const key of kind === "log" ? ["text", "output", "stdout", "stderr", "content", "lines"] : ["diff", "patch", "text", "output"]) {
      const value = artifact.content[key];
      if (typeof value === "string") return value;
      if (Array.isArray(value) && value.every((line) => typeof line === "string")) return value.join("\n");
    }
  }
  return null;
}

function validationFor(artifact: ObjectiveArtifactRecord): ObjectiveArtifactWorkspaceItem["validation"] {
  const content = record(artifact.content) ? artifact.content : null;
  const state = content && typeof content.validation === "string" ? content.validation : content && typeof content.status === "string" ? content.status : null;
  if (state && /pass|valid|success|verified/iu.test(state)) return { state: "verified", detail: state };
  if (state && /fail|invalid|error|reject/iu.test(state)) return { state: "rejected", detail: state };
  if (artifact.reviewState === "verified") return { state: "verified", detail: "Artifact review verified" };
  if (artifact.reviewState === "rejected") return { state: "rejected", detail: artifact.reviewReason ?? "Artifact review rejected" };
  if (artifact.reviewState === "pending") return { state: "pending", detail: "Validation has not been recorded" };
  return { state: "unavailable", detail: "No validation result published" };
}

function hasDiffContent(content: unknown): boolean {
  return typeof content === "string" && /^(diff --git|--- .+\n\+\+\+ )/mu.test(content) || record(content) && typeof content.diff === "string";
}
function uniqueFiles(files: ArtifactFileChange[]): ArtifactFileChange[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.path}\u0000${file.oldPath ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0; }
