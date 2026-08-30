"use client";

import { CaretDown, File, FolderSimple } from "@phosphor-icons/react";

export type FileChange = {
  path: string;
  additions?: number;
  deletions?: number;
  kind?: string;
};

export function FileChanges({ files, additions, deletions }: { files: FileChange[]; additions?: number; deletions?: number }) {
  const groups = groupFiles(files);
  const totalAdditions = additions ?? files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const totalDeletions = deletions ?? files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return (
    <section className="my-4 overflow-hidden rounded-2xl border border-border/75 bg-card/72 shadow-sm backdrop-blur-xl" aria-label={`${files.length} files changed`}>
      <header className="flex items-center justify-between gap-3 px-4 py-3.5">
        <h3 className="text-[13px] font-medium">{files.length} {files.length === 1 ? "file" : "files"} changed</h3>
        <ChangeCount additions={totalAdditions} deletions={totalDeletions} />
      </header>
      <div className="border-t border-border/45 px-2 py-2">
        {groups.map((group) => (
          <div key={group.directory || "."} className="py-0.5">
            {group.directory ? (
              <div className="flex h-8 items-center gap-2 px-2 text-[11px] text-muted-foreground">
                <CaretDown className="size-3" />
                <FolderSimple className="size-4" />
                <span className="min-w-0 flex-1 truncate font-mono">{group.directory}</span>
              </div>
            ) : null}
            {group.files.map((file) => (
              <div key={file.path} className={`flex h-8 items-center gap-2 rounded-md px-2 text-[11px] hover:bg-muted/40 ${group.directory ? "pl-9" : "pl-3"}`} title={file.path}>
                <File className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">{basename(file.path)}</span>
                <ChangeCount additions={file.additions ?? 0} deletions={file.deletions ?? 0} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function ChangeCount({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] tabular-nums">{additions > 0 ? <span className="text-success">+{additions}</span> : null}{deletions > 0 ? <span className="text-destructive">−{deletions}</span> : null}</span>;
}

function groupFiles(files: FileChange[]) {
  const groups = new Map<string, FileChange[]>();
  for (const file of files) {
    const directory = dirname(file.path);
    groups.set(directory, [...(groups.get(directory) ?? []), file]);
  }
  return [...groups.entries()].map(([directory, entries]) => ({ directory, files: entries }));
}
function dirname(path: string) { const normalized = path.replaceAll("\\", "/"); const index = normalized.lastIndexOf("/"); return index > 0 ? normalized.slice(0, index) : ""; }
function basename(path: string) { const normalized = path.replaceAll("\\", "/"); return normalized.slice(normalized.lastIndexOf("/") + 1); }
