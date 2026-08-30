"use client";

import { useEffect, useMemo, useState } from "react";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { PluginSlot } from "@/components/symphony/plugin-slots";
import { useSymphony } from "@/components/symphony/context";
import { SelectControl, type SelectOption } from "@/components/ui/select";
import { harnessTitle, loaderForHarness } from "@/lib/symphony/format";
import type { HarnessId } from "@/lib/symphony/contracts";

type ConductorSelection = {
  harness: Exclude<HarnessId, "auto">;
  model: string;
};

export function ConductorSelector() {
  const { envelope, mode, saveSettings } = useSymphony();
  const saved = envelope.settings.conductor;
  const [selection, setSelection] = useState<ConductorSelection>(saved);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelection(saved);
  }, [saved.harness, saved.model]);

  const harnessOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = envelope.drivers
      .filter((driver) => (driver.available && driver.authenticated !== false) || driver.driver === selection.harness)
      .map((driver) => ({
        value: driver.driver,
        label: harnessTitle(driver.driver),
        description: driver.authenticated === false ? "Authentication required" : "Native harness",
        disabled: !driver.available || driver.authenticated === false,
      }));
    if (!options.some((option) => option.value === selection.harness)) {
      options.unshift({ value: selection.harness, label: harnessTitle(selection.harness) });
    }
    return options;
  }, [envelope.drivers, selection.harness]);

  const modelOptions = useMemo<SelectOption[]>(() => {
    const byValue = new Map<string, SelectOption>();
    for (const model of envelope.models) {
      if (model.harness !== selection.harness) continue;
      const value = model.model ?? "auto";
      if (!byValue.has(value)) byValue.set(value, { value, label: model.name });
    }
    if (!byValue.has(selection.model)) {
      byValue.set(selection.model, {
        value: selection.model,
        label: selection.model === "auto" ? "Native default" : selection.model,
      });
    }
    return [...byValue.values()];
  }, [envelope.models, selection.harness, selection.model]);

  const persist = async (next: ConductorSelection) => {
    const previous = selection;
    setSelection(next);
    setSaving(true);
    try {
      await saveSettings({ conductor: next });
    } catch {
      setSelection(previous);
    } finally {
      setSaving(false);
    }
  };

  const selectHarness = (value: string) => {
    const harness = value as ConductorSelection["harness"];
    const firstModel = envelope.models.find((model) => model.harness === harness)?.model ?? "auto";
    void persist({ harness, model: firstModel });
  };

  return (
    <div className="flex min-w-0 items-center gap-0.5" title="Default orchestrator for new and replacement conductors">
      {saving ? (
        <AgentLoader
          kind={loaderForHarness(selection.harness)}
          size={12}
          label="Saving conductor selection"
        />
      ) : null}
      <SelectControl
        value={selection.harness}
        options={harnessOptions}
        ariaLabel="Default conductor harness"
        disabled={saving || mode === "preview"}
        onValueChange={selectHarness}
        triggerClassName="h-7 w-auto max-w-32 border-transparent bg-transparent px-1.5 text-[11px] text-muted-foreground hover:border-transparent hover:bg-muted hover:text-foreground"
        popupClassName="min-w-44"
      />
      <span className="text-[10px] text-muted-foreground/45">/</span>
      <SelectControl
        value={selection.model}
        options={modelOptions}
        ariaLabel="Default conductor model"
        disabled={saving || mode === "preview"}
        onValueChange={(model) => void persist({ ...selection, model })}
        triggerClassName="h-7 w-auto max-w-48 border-transparent bg-transparent px-1.5 text-[11px] text-muted-foreground hover:border-transparent hover:bg-muted hover:text-foreground"
        popupClassName="min-w-64 max-w-[min(28rem,calc(100vw-1rem))]"
      />
      <PluginSlot name="composer.action" />
    </div>
  );
}
