"use client";

import { Check, Code, FileText, GitDiff, ListBullets, WarningCircle, X, XCircle } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileChanges, type FileChange } from "@/components/assistant-ui/elements/file-changes";
import type { ObjectiveWorkspaceProjection } from "@/lib/symphony/objective-snapshot";
import { fetchObjectiveArtifact } from "@/lib/symphony/runtime-client";
import { projectObjectiveArtifactWorkspace, type ArtifactFileChange, type ObjectiveArtifactWorkspaceItem } from "@/lib/symphony/objective-artifact-workspace";
import { cn } from "@/lib/utils";

type ReviewState = "verified" | "rejected";

export type ObjectiveArtifactWorkspaceProps = {
  workspace: ObjectiveWorkspaceProjection;
  onReviewArtifact?: (artifactId: string, state: ReviewState, reason: string) => void | Promise<void>;
};

/** Live, objective-scoped artifact shelf. It is intentionally not a filesystem browser. */
export function ObjectiveArtifactWorkspace({ workspace, onReviewArtifact }: ObjectiveArtifactWorkspaceProps) {
  const projection = useMemo(() => projectObjectiveArtifactWorkspace({ artifacts: workspace.artifacts, reviews: workspace.artifactReviews, eventCursor: workspace.eventCursor }), [workspace.artifactReviews, workspace.artifacts, workspace.eventCursor]);
  const [selectedId, setSelectedId] = useState<string | null>(projection.items[0]?.artifact.id ?? null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "code" | "diff" | "test" | "log">("all");
  const selected = projection.items.find((item) => item.artifact.id === selectedId) ?? projection.items[0] ?? null;
  const detailQuery = useQuery({
    queryKey: ["symphony", "objective-artifact", selected?.artifact.runId ?? null, selected?.artifact.id ?? null],
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchObjectiveArtifact(selected!.artifact.runId, selected!.artifact.id, signal),
    enabled: selected !== null,
    retry: false,
    staleTime: 5_000,
  });
  const detailStale = Boolean(detailQuery.data && detailQuery.data.artifact.hash !== selected?.artifact.hash);
  const visible = filter === "all" ? projection.items : projection.items.filter((item) => item.kind === filter);
  const selectedFile = selected?.files.find((file) => file.path === filePath) ?? null;

  if (projection.items.length === 0) {
    return <section className="mt-6 rounded-xl border border-dashed border-border/60 bg-card/20 px-5 py-8" aria-label="Objective artifact workspace"><WorkspaceHeading projection={projection} /><EmptyArtifactState /></section>;
  }

  return (
    <section className="mt-6 rounded-xl border border-border/60 bg-card/20" aria-label="Objective artifact workspace">
      <WorkspaceHeading projection={projection} />
      <div className="grid min-w-0 divide-y divide-border/45 border-t border-border/45 xl:grid-cols-[minmax(15rem,0.38fr)_minmax(0,1fr)] xl:divide-x xl:divide-y-0">
        <aside className="min-w-0 p-3" aria-label="Published artifacts">
          <div className="mb-2 flex gap-1 overflow-x-auto" role="group" aria-label="Filter artifacts">
            {(["all", "code", "diff", "test", "log"] as const).map((value) => <button type="button" key={value} onClick={() => setFilter(value)} className={cn("rounded-md px-2 py-1 font-mono text-[9px] capitalize", filter === value ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted/40")}>{value}</button>)}
          </div>
          <div className="space-y-1.5">
            {visible.length === 0 ? <p className="px-2 py-5 text-[10px] text-muted-foreground">No artifacts match this filter.</p> : visible.map((item) => <ArtifactListItem key={item.artifact.id} item={item} selected={selected?.artifact.id === item.artifact.id} onSelect={() => { setSelectedId(item.artifact.id); setFilePath(null); }} />)}
          </div>
        </aside>
        <div className="min-w-0 p-4 md:p-5">
          {selected ? <ArtifactPreview item={selected} detailError={detailQuery.error} detailStale={detailStale} loading={detailQuery.isPending} selectedFile={selectedFile} onSelectFile={(file) => setFilePath(file.path)} onReview={onReviewArtifact} /> : <EmptyArtifactState />}
        </div>
      </div>
    </section>
  );
}

function WorkspaceHeading({ projection }: { projection: ReturnType<typeof projectObjectiveArtifactWorkspace> }) {
  return <header className="flex flex-col gap-2 px-4 py-4 md:flex-row md:items-start md:justify-between md:px-5"><div><div className="flex items-center gap-2"><GitDiff className="size-4 text-info" aria-hidden="true" /><h2 className="text-[13px] font-medium text-foreground/90">Artifact workspace</h2><span className="font-mono text-[9px] text-muted-foreground">{projection.counts.total}</span></div><p className="mt-1 text-[10px] text-muted-foreground">Daemon-published code, diffs, test results, and logs at fence {projection.eventCursor}.</p></div><div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground/75"><span>{projection.counts.code} code</span><span>{projection.counts.diff} diffs</span><span>{projection.counts.test} tests</span><span>{projection.counts.log} logs</span><span className={projection.counts.pending ? "text-warning" : "text-success"}>{projection.counts.pending} pending review</span></div></header>;
}

function ArtifactListItem({ item, selected, onSelect }: { item: ObjectiveArtifactWorkspaceItem; selected: boolean; onSelect: () => void }) {
  const artifact = item.artifact;
  return <button type="button" onClick={onSelect} className={cn("group w-full rounded-lg border px-3 py-2.5 text-left transition-colors", selected ? "border-foreground/20 bg-card/60" : "border-border/35 hover:bg-muted/25")} aria-pressed={selected}><span className="flex min-w-0 items-start gap-2"><ArtifactIcon kind={item.kind} /><span className="min-w-0 flex-1"><span className="block truncate text-[10px] font-medium text-foreground/90" title={artifact.name}>{artifact.name}</span><span className="mt-1 block truncate font-mono text-[8px] text-muted-foreground">{artifact.kind} · {artifact.reviewState}</span><span className="mt-1 block font-mono text-[8px] text-muted-foreground/65">cursor {artifact.evidence.eventCursor} · r{artifact.planRevision}</span></span>{item.supersededBy ? <X className="size-3 shrink-0 text-muted-foreground" aria-label="Superseded" /> : null}</span></button>;
}

function ArtifactPreview({ item, detailError, detailStale, loading, selectedFile, onSelectFile, onReview }: { item: ObjectiveArtifactWorkspaceItem; detailError: unknown; detailStale: boolean; loading: boolean; selectedFile: ArtifactFileChange | null; onSelectFile: (file: FileChange) => void; onReview?: ObjectiveArtifactWorkspaceProps["onReviewArtifact"] }) {
  const artifact = item.artifact;
  const changes: FileChange[] = item.files;
  const canReview = artifact.reviewState === "pending" && !item.supersededBy && !detailStale;
  return <div className="min-w-0"><div className="flex flex-col gap-3 border-b border-border/45 pb-4 md:flex-row md:items-start md:justify-between"><div className="min-w-0"><div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><ArtifactIcon kind={item.kind} /><h3 className="min-w-0 truncate text-[13px] font-medium text-foreground/95" title={artifact.name}>{artifact.name}</h3><span className={cn("font-mono text-[9px] capitalize", reviewTone(artifact.reviewState))}>{artifact.reviewState}</span></div><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground/75"><span>{artifact.kind}</span><span>{artifact.mediaType}</span><span>{formatBytes(artifact.sizeBytes)}</span><span>hash {artifact.hash.slice(0, 12)}…</span></div></div><div className="flex shrink-0 gap-1.5">{canReview && onReview ? <><button type="button" className="inline-flex items-center gap-1 rounded-md bg-foreground px-2 py-1.5 font-mono text-[9px] text-background hover:opacity-85" onClick={() => void onReview(artifact.id, "verified", "Verified from the objective artifact workspace.")}><Check className="size-3" weight="bold" /> Verify</button><button type="button" className="inline-flex items-center gap-1 rounded-md border border-border/65 px-2 py-1.5 font-mono text-[9px] text-muted-foreground hover:bg-muted/35" onClick={() => void onReview(artifact.id, "rejected", "Rejected from the objective artifact workspace.")}><XCircle className="size-3" /> Reject</button></> : <span className="font-mono text-[9px] text-muted-foreground">{item.supersededBy ? "Superseded" : onReview ? "No review action" : "Review unavailable"}</span>}</div></div><Provenance item={item} />{detailError ? <Notice tone="warning">Artifact detail unavailable; showing the last snapshot projection.</Notice> : null}{detailStale ? <Notice tone="danger">Artifact detail hash differs from the snapshot. Preview is stale until the objective refreshes.</Notice> : null}{loading ? <p className="mt-3 font-mono text-[9px] text-muted-foreground">Refreshing artifact detail…</p> : null}{item.files.length > 0 ? <div className="mt-4"><FileChanges files={changes} onFileSelect={onSelectFile} /><FilePreview file={selectedFile ?? item.files[0] ?? null} /></div> : <InlinePreview item={item} />}</div>;
}

function Provenance({ item }: { item: ObjectiveArtifactWorkspaceItem }) {
  const artifact = item.artifact;
  return <dl className="mt-4 grid gap-x-4 gap-y-2 border-b border-border/45 pb-4 text-[9px] sm:grid-cols-2 lg:grid-cols-4"><Fact label="Producer" value={artifact.producerAgentId ?? artifact.publishedBy.id} /><Fact label="Attempt" value={artifact.attemptId ?? "unattributed"} /><Fact label="Evidence cursor" value={`#${artifact.evidence.eventCursor}`} /><Fact label="Validation" value={item.validation.detail} /><Fact label="Task / node" value={`${artifact.taskId ?? "—"} / ${artifact.controlNodeId ?? "—"}`} /><Fact label="Lineage" value={artifact.lineage.length ? artifact.lineage.join(", ") : "none recorded"} /><Fact label="Supersession" value={item.supersededBy ?? artifact.supersedes ?? "current"} /><Fact label="Published" value={`${artifact.publishedBy.type} · ${formatDate(artifact.publishedAt)}`} /></dl>;
}

function InlinePreview({ item }: { item: ObjectiveArtifactWorkspaceItem }) {
  if (!item.previewText && item.kind === "other") return <Notice tone="warning">Preview unavailable for this media type. The immutable hash and provenance remain available above.</Notice>;
  if (item.kind === "test") return <div className="mt-4 rounded-lg border border-border/45 bg-muted/15 p-3"><p className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">Test result</p><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-5 text-foreground/80">{item.previewText ?? JSON.stringify(item.artifact.content, null, 2)}</pre></div>;
  return <div className="mt-4 rounded-lg border border-border/45 bg-muted/15 p-3"><p className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">{item.kind} preview</p><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-5 text-foreground/80">{item.previewText ?? JSON.stringify(item.artifact.content, null, 2)}</pre></div>;
}

function FilePreview({ file }: { file: ArtifactFileChange | null }) { return <div className="mt-3 rounded-lg border border-border/45 bg-muted/15 p-3"><div className="flex items-center justify-between gap-3"><p className="truncate font-mono text-[9px] text-foreground/80" title={file?.path}>{file ? file.path : "Select a changed file"}</p>{file ? <span className="font-mono text-[9px] text-muted-foreground">+{file.additions} −{file.deletions}</span> : null}</div>{file?.content || file?.diff ? <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-5 text-foreground/80">{file.content ?? file.diff}</pre> : <p className="mt-2 text-[10px] text-muted-foreground">File preview unavailable; the artifact only published churn metadata for this path.</p>}</div>; }
function EmptyArtifactState() { return <div className="grid min-h-24 place-items-center text-center"><div><ListBullets className="mx-auto size-5 text-muted-foreground/60" aria-hidden="true" /><p className="mt-2 text-[11px] text-muted-foreground">No objective artifacts have been published yet.</p></div></div>; }
function Notice({ children, tone }: { children: string; tone: "warning" | "danger" }) { return <p className={cn("mt-3 rounded-md border px-3 py-2 text-[10px]", tone === "danger" ? "border-destructive/30 bg-destructive/[0.06] text-destructive" : "border-warning/30 bg-warning/[0.06] text-warning")} role="status"><WarningCircle className="mr-1.5 inline size-3" aria-hidden="true" />{children}</p>; }
function Fact({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><dt className="font-mono text-[8px] uppercase tracking-[0.08em] text-muted-foreground/60">{label}</dt><dd className="mt-0.5 truncate font-mono text-[9px] text-foreground/75" title={value}>{value}</dd></div>; }
function ArtifactIcon({ kind }: { kind: ObjectiveArtifactWorkspaceItem["kind"] }) { const Icon = kind === "diff" ? GitDiff : kind === "code" ? Code : kind === "test" ? Check : kind === "log" ? FileText : ListBullets; return <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />; }
function reviewTone(state: string) { return state === "verified" ? "text-success" : state === "rejected" || state === "superseded" ? "text-destructive" : "text-warning"; }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / (1024 * 1024)).toFixed(1)} MB`; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toISOString().slice(0, 16).replace("T", " "); }
