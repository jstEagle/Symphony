"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PluginSlot } from "@/components/symphony/plugin-slots";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { useSymphony } from "@/components/symphony/context";
import { SelectControl, type SelectOption } from "@/components/ui/select";
import { harnessTitle } from "@/lib/symphony/format";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { AgentAccess, HarnessId } from "@/lib/symphony/contracts";

const ACCESS_OPTIONS: SelectOption[] = [
  { value: "full-access", label: "Full access" },
  { value: "read-only", label: "Read only" },
];
const DEPTH_PRESETS = [0, 1, 2, 3, 4, 5, 8, 12, 16];
const CONCURRENCY_PRESETS = [1, 2, 4, 8, 16, 32, 64, 128];

export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen, envelope, connection, saveSettings, updateHarness } = useSymphony();
  const [harness, setHarness] = useState<Exclude<HarnessId, "auto">>(envelope.settings.conductor.harness);
  const [model, setModel] = useState(envelope.settings.conductor.model);
  const [permissions, setPermissions] = useState<AgentAccess>(envelope.settings.agents.defaultPermissions);
  const [maxDepth, setMaxDepth] = useState(envelope.settings.agents.maxDepth);
  const [maxConcurrent, setMaxConcurrent] = useState(envelope.settings.agents.maxConcurrent);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);

  useEffect(() => {
    setHarness(envelope.settings.conductor.harness);
    setModel(envelope.settings.conductor.model);
    setPermissions(envelope.settings.agents.defaultPermissions);
    setMaxDepth(envelope.settings.agents.maxDepth);
    setMaxConcurrent(envelope.settings.agents.maxConcurrent);
  }, [
    envelope.settings.conductor.harness,
    envelope.settings.conductor.model,
    envelope.settings.agents.defaultPermissions,
    envelope.settings.agents.maxDepth,
    envelope.settings.agents.maxConcurrent,
  ]);

  const harnessModels = useMemo(
    () => envelope.models.filter((item) => item.harness === harness),
    [envelope.models, harness],
  );
  const harnessOptions = useMemo<SelectOption[]>(
    () => envelope.drivers.map((driver) => ({
      value: driver.driver,
      label: harnessTitle(driver.driver),
      description: driver.available
        ? driver.authenticated === false ? "Authentication required" : "Available"
        : "Not installed",
      disabled: !driver.available || driver.authenticated === false,
    })),
    [envelope.drivers],
  );
  const modelOptions = useMemo<SelectOption[]>(() => {
    const options = harnessModels.map((item) => ({
      value: item.model ?? "auto",
      label: item.name,
      ...(item.description ? { description: item.description } : {}),
    }));
    if (!options.some((option) => option.value === model)) {
      options.unshift({ value: model, label: model === "auto" ? "Native default" : model });
    }
    return options.length ? options : [{ value: "auto", label: "Native default" }];
  }, [harnessModels, model]);
  const depthOptions = useMemo(() => limitOptions(maxDepth, DEPTH_PRESETS, "No nesting"), [maxDepth]);
  const concurrencyOptions = useMemo(() => limitOptions(maxConcurrent, CONCURRENCY_PRESETS), [maxConcurrent]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await saveSettings({
        conductor: { harness, model },
        agents: { defaultPermissions: permissions, maxDepth, maxConcurrent },
      });
      setNotice("Saved. New chats and replacement conductors will use these settings.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="max-h-[min(40rem,calc(100dvh-2rem))] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Conductor</h3>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Native harness">
                <SelectControl
                  value={harness}
                  options={harnessOptions}
                  ariaLabel="Native harness"
                  onValueChange={(value) => {
                    const next = value as Exclude<HarnessId, "auto">;
                    setHarness(next);
                    const first = envelope.models.find((item) => item.harness === next);
                    setModel(first?.model ?? "auto");
                  }}
                />
              </Field>
              <Field label="Model">
                <SelectControl
                  value={model}
                  options={modelOptions}
                  ariaLabel="Conductor model"
                  onValueChange={setModel}
                />
              </Field>
              <Field label="Default access">
                <SelectControl
                  value={permissions}
                  options={ACCESS_OPTIONS}
                  ariaLabel="Default agent access"
                  onValueChange={(value) => setPermissions(value as AgentAccess)}
                />
              </Field>
              <Field label="Maximum depth">
                <SelectControl
                  value={limitValue(maxDepth)}
                  options={depthOptions}
                  ariaLabel="Maximum agent depth"
                  onValueChange={(value) => setMaxDepth(parseLimit(value))}
                />
              </Field>
              <Field label="Concurrent agents">
                <SelectControl
                  value={limitValue(maxConcurrent)}
                  options={concurrencyOptions}
                  ariaLabel="Maximum concurrent agents"
                  onValueChange={(value) => setMaxConcurrent(parseLimit(value))}
                />
              </Field>
            </div>
            <p className="text-[11px] leading-4 text-muted-foreground">
              Existing healthy chats keep their native session. A failed chat automatically starts a replacement conductor using the saved selection.
            </p>
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[10px] text-muted-foreground">{notice}</span>
              <Button type="submit" size="sm" disabled={busy || envelope.mode === "preview"}>
                {busy ? <AgentLoader kind="square" size={14} label="Saving settings" /> : null}
                {busy ? "Saving…" : "Save settings"}
              </Button>
            </div>
          </section>

        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="text-xs font-medium text-muted-foreground">Daemon</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Fact label="Connection" value={connection} />
            <Fact label="Version" value={envelope.daemon.version} />
            <Fact label="Plugins" value={envelope.daemon.noPlugins ? "Disabled (--no-plugins)" : "Trusted host"} />
            <Fact label="Projection" value={envelope.mode === "preview" ? "Preview data" : "Live bootstrap"} />
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-muted-foreground">Native harnesses</h3>
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              {connection === "connecting" || connection === "stale" ? <AgentLoader kind="circular" size={12} label="Refreshing harnesses" /> : null}
              Live · refreshes every 5s
            </span>
          </div>
          <ul className="space-y-1.5">
            {envelope.drivers.map((driver) => (
            <li key={driver.driver} className="flex items-start justify-between gap-3 px-1 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium">{harnessTitle(driver.driver)}</p>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{driver.detail}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {driver.version ? `Installed ${driver.version}` : "Version unavailable"}
                    {driver.latestVersion && driver.latestVersion !== driver.version ? ` · Latest ${driver.latestVersion}` : ""}
                    {driver.updateDetail ? ` · ${driver.updateDetail}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <StatusDot
                    ok={driver.available && driver.authenticated !== false && driver.updateAvailable !== true}
                    label={driver.available
                      ? driver.authenticated === false
                        ? "Needs auth"
                        : driver.updateAvailable
                          ? "Update available"
                          : "Ready"
                      : "Missing"}
                  />
                  {driver.updateSupported && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={updating !== null || driver.updateAvailable === false}
                      onClick={() => {
                        setUpdating(driver.driver);
                        setNotice(null);
                        void updateHarness(driver.driver)
                          .then(() => setNotice(`${harnessTitle(driver.driver)} updated.`))
                          .catch((error) => setNotice(error instanceof Error ? error.message : "Update failed."))
                          .finally(() => setUpdating(null));
                      }}
                    >
                      {updating === driver.driver ? <AgentLoader kind="triangle" size={14} label={`Updating ${harnessTitle(driver.driver)}`} /> : null}
                      {updating === driver.driver ? "Updating…" : "Update"}
                    </Button>
                  )}
                </div>
              </li>
            ))}
            {envelope.drivers.length === 0 && (
              <p className="text-xs text-muted-foreground">Driver doctor reports appear once the daemon is connected.</p>
            )}
          </ul>
          {notice && <p className="text-[11px] text-muted-foreground" aria-live="polite">{notice}</p>}
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Plugins</h3>
          <ul className="space-y-1.5">
            {envelope.plugins.map((plugin) => (
              <li key={plugin.id} className="flex items-center justify-between px-1 py-2 text-xs">
                <span className="truncate">{plugin.id}</span>
                <span className="text-[10px] text-muted-foreground">{plugin.status}</span>
              </li>
            ))}
            {envelope.plugins.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No trusted plugins. Copy a plugin into .symphony/plugins and list its id in plugins.trusted.
              </p>
            )}
          </ul>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Secrets</h3>
          <p className="text-xs leading-5 text-muted-foreground">
            Store keys with <span className="font-mono text-[11px] text-foreground">pnpm symphony -- secret set openrouter.apiKey</span> or <span className="font-mono text-[11px] text-foreground">CURSOR_API_KEY</span>. The browser never persists credentials.
          </p>
          <Button variant="outline" size="sm" disabled>
            Keychain is managed by the daemon
          </Button>
        </section>

        <PluginSlot name="settings.panel" />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function limitValue(value: number | null): string {
  return value === null ? "unlimited" : String(value);
}

function parseLimit(value: string): number | null {
  return value === "unlimited" ? null : Number(value);
}

function limitOptions(current: number | null, presets: number[], zeroLabel?: string): SelectOption[] {
  const values = current === null || presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
  return [
    ...values.map((value) => ({
      value: String(value),
      label: value === 0 && zeroLabel ? zeroLabel : String(value),
    })),
    { value: "unlimited", label: "Unlimited", description: "No runtime limit" },
  ];
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-1">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-1 capitalize">{value}</p>
    </div>
  );
}

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("shrink-0 text-[10px]", ok ? "text-foreground" : "text-muted-foreground")}>{label}</span>
  );
}
