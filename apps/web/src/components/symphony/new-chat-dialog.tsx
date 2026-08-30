"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowUp,
  Check,
  FolderSimple,
  GitBranch,
  Plus,
} from "@phosphor-icons/react";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSymphony } from "@/components/symphony/context";
import type { DirectoryListing } from "@/lib/symphony/contracts";
import { cn } from "@/lib/utils";

type NewChatDialogProps = {
  open: boolean;
  initialProjectId?: string;
  onOpenChange: (open: boolean) => void;
};

export function NewChatDialog({ open, initialProjectId, onOpenChange }: NewChatDialogProps) {
  const symphony = useSymphony();
  const [view, setView] = useState<"projects" | "browse">("projects");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialProjectId ?? null);
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loadingPath, setLoadingPath] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => symphony.projects.find((project) => project.id === selectedProjectId) ?? null,
    [selectedProjectId, symphony.projects],
  );

  useEffect(() => {
    if (!open) return;
    const fallbackId = initialProjectId && symphony.projects.some((project) => project.id === initialProjectId)
      ? initialProjectId
      : symphony.projects[0]?.id ?? null;
    setSelectedProjectId(fallbackId);
    setView(symphony.projects.length ? "projects" : "browse");
    setError(null);
    if (!symphony.projects.length) void browse();
    // The open transition is the reset boundary; project changes should not reset a user's in-progress selection.
  }, [open]);

  const browse = async (nextPath?: string) => {
    setLoadingPath(true);
    setError(null);
    try {
      const next = await symphony.browseDirectories(nextPath);
      setListing(next);
      setPath(next.currentPath);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoadingPath(false);
    }
  };

  const submitPath = (event: FormEvent) => {
    event.preventDefault();
    void browse(path);
  };

  const createInProject = async () => {
    if (!selectedProject) return;
    setCreating(true);
    setError(null);
    try {
      await symphony.createConversation({ projectId: selectedProject.id });
      onOpenChange(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCreating(false);
    }
  };

  const createFromFolder = async () => {
    if (!listing) return;
    setCreating(true);
    setError(null);
    try {
      const project = await symphony.createProject({ workspacePath: listing.currentPath });
      await symphony.createConversation({ projectId: project.id });
      onOpenChange(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New chat</DialogTitle>
          <DialogDescription>
            Choose the local project Symphony should give the conductor and every agent in this chat.
          </DialogDescription>
        </DialogHeader>

        <div className="flex w-fit rounded-lg bg-muted/55 p-0.5" role="tablist" aria-label="Project source">
          <button
            type="button"
            role="tab"
            aria-selected={view === "projects"}
            onClick={() => setView("projects")}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-xs transition-colors",
              view === "projects" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Projects
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "browse"}
            onClick={() => {
              setView("browse");
              if (!listing) void browse(selectedProject?.workspacePath);
            }}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-xs transition-colors",
              view === "browse" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Add folder
          </button>
        </div>

        {view === "projects" ? (
          <div className="space-y-3">
            <div className="max-h-72 space-y-1 overflow-y-auto pr-1" role="radiogroup" aria-label="Local projects">
              {symphony.projects.map((project) => {
                const selected = project.id === selectedProjectId;
                return (
                  <button
                    key={project.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setSelectedProjectId(project.id)}
                    onDoubleClick={() => {
                      setSelectedProjectId(project.id);
                      void symphony.createConversation({ projectId: project.id }).then(() => onOpenChange(false));
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                      selected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/55 hover:text-foreground",
                    )}
                  >
                    <FolderSimple className="size-4 shrink-0" weight={selected ? "fill" : "regular"} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-sm">
                        <span className="truncate">{project.title}</span>
                        {project.isGitRepository ? <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-label="Git repository" /> : null}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground" title={project.workspacePath}>
                        {project.workspacePath}
                      </span>
                    </span>
                    {selected ? <Check className="size-4 shrink-0" /> : null}
                  </button>
                );
              })}
              {!symphony.projects.length ? (
                <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
                  No local projects yet. Add a folder to create the first one.
                </div>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <Button variant="ghost" onClick={() => {
                setView("browse");
                if (!listing) void browse();
              }}>
                <Plus /> Add folder
              </Button>
              <Button disabled={!selectedProject || creating} onClick={() => void createInProject()}>
                {creating ? <AgentLoader kind="square" size={14} label="Creating chat" /> : null}
                {creating ? "Creating…" : "Create chat"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <form className="flex gap-2" onSubmit={submitPath}>
              <Input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/Users/you/Programming/project or ~/project"
                aria-label="Folder path"
                className="font-mono text-xs"
              />
              <Button type="submit" variant="secondary" disabled={loadingPath || !path.trim()}>
                {loadingPath ? <AgentLoader kind="circular" size={14} label="Opening folder" /> : "Open"}
              </Button>
            </form>

            <div className="min-h-52 overflow-hidden rounded-lg border border-border bg-muted/15">
              {loadingPath ? (
                <div className="grid min-h-52 place-items-center text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <AgentLoader kind="circular" size={18} label="Loading folders" />
                    <span>Reading folders…</span>
                  </div>
                </div>
              ) : listing ? (
                <div className="max-h-72 overflow-y-auto p-1">
                  {listing.parentPath ? (
                    <button
                      type="button"
                      onClick={() => void browse(listing.parentPath ?? undefined)}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-muted-foreground hover:bg-muted/55 hover:text-foreground"
                    >
                      <ArrowUp className="size-3.5" />
                      <span>Parent folder</span>
                    </button>
                  ) : null}
                  {listing.entries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => void browse(entry.path)}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-muted-foreground hover:bg-muted/55 hover:text-foreground"
                    >
                      <FolderSimple className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {entry.isGitRepository ? <GitBranch className="size-3.5 shrink-0" aria-label="Git repository" /> : null}
                    </button>
                  ))}
                  {!listing.entries.length ? (
                    <p className="px-3 py-8 text-center text-xs text-muted-foreground">No subfolders</p>
                  ) : null}
                </div>
              ) : (
                <div className="grid min-h-52 place-items-center p-6 text-center text-xs text-muted-foreground">
                  Enter a path or browse from your home folder. Symphony only exposes directories to this local interface.
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Working directory</p>
                <p className="truncate font-mono text-[11px]" title={listing?.currentPath}>{listing?.currentPath ?? "Choose a folder"}</p>
              </div>
              <Button disabled={!listing || creating || loadingPath} onClick={() => void createFromFolder()}>
                {creating ? <AgentLoader kind="square" size={14} label="Adding project" /> : <Plus />}
                {creating ? "Creating…" : "Use this folder"}
              </Button>
            </div>
          </div>
        )}

        {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
