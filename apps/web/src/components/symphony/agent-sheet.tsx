"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { AgentDetail, AgentObservation, ObservationLevel } from "@/lib/symphony/contracts";
import { accessLabel, formatCost, statusLabel } from "@/lib/symphony/format";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { loaderForHarness } from "@/lib/symphony/format";
import { isLiveAgentState } from "@/lib/symphony/format";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const levels: ObservationLevel[] = ["tldr", "paragraph", "full"];

export function AgentSheet({
  detail,
  open,
  onOpenChange,
  onObserve,
  onSteer,
  onCancel,
  onOpenChild,
}: {
  detail: AgentDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onObserve: (id: string, level: ObservationLevel) => Promise<AgentObservation>;
  onSteer: (id: string, content: string) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
  onOpenChild: (id: string) => void;
}) {
  const [level, setLevel] = useState<ObservationLevel>("tldr");
  const [observation, setObservation] = useState<AgentObservation | null>(null);
  const [steer, setSteer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setObservation(null);
    setSteer("");
    setLevel("tldr");
    setError(null);
  }, [detail?.id]);

  if (!detail) return null;

  const loadObservation = async (next: ObservationLevel) => {
    setLevel(next);
    const cached = detail.observations[next];
    if (cached) {
      setObservation(cached);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setObservation(await onObserve(detail.id, next));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The observation could not be loaded.");
    } finally {
      setBusy(false);
    }
  };

  const submitSteer = async (event: FormEvent) => {
    event.preventDefault();
    const content = steer.trim();
    if (!content) return;
    setBusy(true);
    setError(null);
    try {
      await onSteer(detail.id, content);
      setSteer("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The steer could not be delivered.");
    } finally {
      setBusy(false);
    }
  };

  const submitCancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCancel(detail.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The agent could not be cancelled.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b border-foreground/8">
          <SheetTitle className="font-display text-pretty">{detail.name}</SheetTitle>
          <SheetDescription>{detail.objective}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <div className="flex items-center gap-2 text-xs">
            {isLiveAgentState(detail.state) ? (
              <AgentLoader kind={loaderForHarness(detail.harness)} size={16} label={`${detail.harness} active`} />
            ) : null}
            <span>{statusLabel(detail.state, detail.nativeStatus)}</span>
            <span className="text-muted-foreground">· {detail.harness}</span>
            <span className="text-muted-foreground">· {accessLabel(detail.access)}</span>
          </div>

          <dl className="grid grid-cols-2 gap-2 text-xs">
            <Meta label="Model" value={detail.model} />
            <Meta label="Depth" value={String(detail.depth)} />
            <Meta label="Elapsed" value={detail.elapsed} />
            <Meta label="Cost" value={formatCost(detail.cost)} />
            <Meta label="Native session" value={detail.nativeSessionId ?? "—"} />
            <Meta label="Native run" value={detail.nativeRunId ?? "—"} />
          </dl>

          {detail.error && (
            <p className="rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">{detail.error}</p>
          )}
          {error && (
            <p className="rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
          )}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-medium text-muted-foreground">Observation</h3>
              <div className="flex gap-1">
                {levels.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => void loadObservation(item)}
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px]",
                      level === item ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {busy && !observation
                ? "Reading recorded evidence…"
                : observation?.summary ?? "Choose a granularity to observe without interrupting the native session."}
            </p>
            {observation?.generatedBy && (
              <p className="mt-2 text-[10px] text-muted-foreground">
                {observation.generatedBy === "model"
                  ? `Observer model · ${observation.model ?? "auto"}`
                  : "Deterministic projection"}
              </p>
            )}
          </section>

          {(detail.parent || detail.children.length > 0) && (
            <section>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">Ownership</h3>
              {detail.parent && (
                <button
                  type="button"
                  className="mb-1 block text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => onOpenChild(detail.parent!.id)}
                >
                  Parent · {detail.parent.name}
                </button>
              )}
              {detail.children.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  className="block text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => onOpenChild(child.id)}
                >
                  Child · {child.name}
                </button>
              ))}
            </section>
          )}

          {detail.files.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">Files</h3>
              <ul className="space-y-1 font-mono text-[11px] text-muted-foreground">
                {detail.files.map((file) => (
                  <li key={file.path}>{file.path}</li>
                ))}
              </ul>
            </section>
          )}

          <form onSubmit={submitSteer} className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Queue a steer</h3>
            <Textarea
              value={steer}
              onChange={(event) => setSteer(event.target.value)}
              placeholder="Delivered at a native safe boundary"
              rows={3}
            />
            <div className="flex justify-between">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={!isLiveAgentState(detail.state) || busy}
                onClick={() => void submitCancel()}
              >
                Cancel agent
              </Button>
              <Button type="submit" size="sm" disabled={!steer.trim() || busy || !detail.nativeSessionId}>
                Steer
              </Button>
            </div>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted/45 p-2.5">
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate">{value}</dd>
    </div>
  );
}
