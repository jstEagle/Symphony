"use client";

import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretDown,
  Check,
  ClockCounterClockwise,
  Code,
  GitBranch,
  MagnifyingGlass,
  Minus,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  capabilityParameterLabel,
  capabilityVersionKey,
  diffCapabilityVersions,
  filterCapabilityVersions,
  formatCapabilityVersion,
  groupCapabilityVersions,
  initialCapabilityParameterValues,
  validateCapabilityParameterValues,
  type CapabilityDefaults,
  type CapabilityParameter,
  type CapabilityParameterValues,
  type CapabilityStatus,
  type CapabilityTrigger,
  type CapabilityTriggerType,
  type CapabilityVersionRecord,
} from "@/lib/symphony/capability-library";
import { cn } from "@/lib/utils";
import styles from "./capability-library.module.css";

export type CapabilityAction = "activate" | "deprecate" | "fork";
export type CapabilityActionResult = Readonly<{
  status: "committed" | "replayed" | "conflict" | "rejected";
  reason?: string;
}>;

export type CapabilityLibraryProps = Readonly<{
  records: readonly CapabilityVersionRecord[];
  onActivate?: (record: CapabilityVersionRecord, parameters: CapabilityParameterValues, triggers: readonly CapabilityTrigger[]) => Promise<CapabilityActionResult | void> | CapabilityActionResult | void;
  onDeprecate?: (record: CapabilityVersionRecord) => Promise<CapabilityActionResult | void> | CapabilityActionResult | void;
  onFork?: (record: CapabilityVersionRecord) => Promise<CapabilityActionResult | void> | CapabilityActionResult | void;
  className?: string;
  title?: string;
  description?: string;
}>;

/**
 * A controlled, registry-agnostic capability library. Data comes from the
 * caller so preview and live surfaces never silently substitute fixtures.
 */
export function CapabilityLibrary({ records, onActivate, onDeprecate, onFork, className, title = "Capability library", description = "Reusable workflows with explicit inputs, defaults, and lifecycle history." }: CapabilityLibraryProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<CapabilityStatus | "all">("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [parameters, setParameters] = useState<CapabilityParameterValues>({});
  const [triggers, setTriggers] = useState<readonly CapabilityTrigger[]>([]);
  const [confirming, setConfirming] = useState<{ action: CapabilityAction; record: CapabilityVersionRecord } | null>(null);
  const [busyAction, setBusyAction] = useState<CapabilityAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [parameterErrors, setParameterErrors] = useState<Readonly<Record<string, string>>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => filterCapabilityVersions(records, { text: query, status }), [records, query, status]);
  const selected = records.find((record) => capabilityVersionKey(record) === selectedKey) ?? filtered[0] ?? records[0];
  const selectedVersions = useMemo(() => selected ? records.filter((record) => record.id === selected.id).sort((left, right) => String(left.version).localeCompare(String(right.version), undefined, { numeric: true })) : [], [records, selected]);
  const selectedGroups = useMemo(() => groupCapabilityVersions(filtered), [filtered]);

  useEffect(() => {
    if (!selected) {
      setSelectedKey(null);
      return;
    }
    const key = capabilityVersionKey(selected);
    setSelectedKey((current) => current && records.some((record) => capabilityVersionKey(record) === current) ? current : key);
    setParameters(selected.activation?.parameters && typeof selected.activation.parameters === "object" && !Array.isArray(selected.activation.parameters)
      ? selected.activation.parameters as CapabilityParameterValues
      : initialCapabilityParameterValues(selected.parameters));
    setTriggers(selected.activation?.triggers ?? selected.triggers ?? []);
    setParameterErrors({});
    setActionError(null);
    setActionNotice(null);
  }, [records, selected]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/" && !isTypingTarget(event.target)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectRecord = (record: CapabilityVersionRecord) => {
    setSelectedKey(capabilityVersionKey(record));
    setActionError(null);
    setActionNotice(null);
  };

  const requestAction = (action: CapabilityAction) => {
    if (!selected || busyAction) return;
    if (action === "activate") {
      const errors = validateCapabilityParameterValues(selected.parameters ?? [], parameters);
      setParameterErrors(errors);
      if (Object.keys(errors).length > 0) return;
    }
    setActionError(null);
    setActionNotice(null);
    setConfirming({ action, record: selected });
  };

  const confirmAction = async () => {
    if (!confirming || busyAction) return;
    const { action, record } = confirming;
    const handler = action === "activate" ? onActivate : action === "deprecate" ? onDeprecate : onFork;
    if (!handler) {
      setActionError(`${actionLabel(action)} is not available on this surface.`);
      setConfirming(null);
      return;
    }
    setBusyAction(action);
    setActionError(null);
    setActionNotice(null);
    try {
      const result = action === "activate"
        ? await onActivate?.(record, parameters, triggers)
        : action === "deprecate"
          ? await onDeprecate?.(record)
          : await onFork?.(record);
      if (result?.status === "conflict" || result?.status === "rejected") {
        throw new Error(result.reason ?? `${actionLabel(action)} was rejected by the daemon.`);
      }
      if (result?.status === "replayed") {
        setActionNotice(`${actionLabel(action)} replayed from the daemon receipt. No duplicate mutation was created.`);
      } else {
        setActionNotice(`${actionLabel(action)} committed for ${record.name} ${formatCapabilityVersion(record.version)}.`);
      }
      setConfirming(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `${actionLabel(action)} failed.`);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <main className={cn(styles.library, className)}>
      <header className={styles.header}>
        <div className={styles.eyebrow}><Sparkle weight="fill" /> Reusable capabilities <span className={styles.eyebrowRule} /></div>
        <div className={styles.headerRow}>
          <div>
            <h1 className={styles.title}>{title}</h1>
            <p className={styles.subtitle}>{description}</p>
          </div>
          <span className={styles.registryCount}><span className={styles.registryDot} /> {records.length} version{records.length === 1 ? "" : "s"}</span>
        </div>
      </header>

      {actionError ? <div className={cn(styles.notice, styles.noticeDanger)} role="alert"><Warning /> <span>{actionError}</span><button type="button" onClick={() => setActionError(null)} aria-label="Dismiss notice"><X /></button></div> : null}
      {actionNotice ? <div className={cn(styles.notice, styles.noticeSuccess)} role="status"><Check /> <span>{actionNotice}</span><button type="button" onClick={() => setActionNotice(null)} aria-label="Dismiss notice"><X /></button></div> : null}

      <div className={styles.body}>
        <aside className={styles.sidebar} aria-label="Capability versions">
          <div className={styles.searchWrap}>
            <MagnifyingGlass className={styles.searchIcon} aria-hidden="true" />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search capabilities" aria-label="Search capabilities" className={styles.searchInput} />
            <kbd className={styles.shortcut}>/</kbd>
          </div>
          <div className={styles.filterRow} role="group" aria-label="Filter capability status">
            {(["all", "active", "draft", "deprecated"] as const).map((option) => <button type="button" key={option} className={cn(styles.filterButton, status === option && styles.filterButtonActive)} onClick={() => setStatus(option)} aria-pressed={status === option}>{option}</button>)}
          </div>
          <div className={styles.sidebarMeta}><span>Versions</span><span>{filtered.length} shown</span></div>
          <div className={styles.list} role="listbox" tabIndex={filtered.length > 0 ? 0 : undefined} aria-label="Capability versions" aria-activedescendant={selected ? `capability-${capabilityVersionKey(selected)}` : undefined} onKeyDown={(event) => {
            if (!filtered.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const currentIndex = Math.max(0, filtered.findIndex((record) => selected && capabilityVersionKey(record) === capabilityVersionKey(selected)));
            const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? filtered.length - 1 : Math.min(filtered.length - 1, Math.max(0, currentIndex + (event.key === "ArrowDown" ? 1 : -1)));
            const nextRecord = filtered[nextIndex];
            if (nextRecord) selectRecord(nextRecord);
          }}>
            {filtered.length === 0 ? <EmptyLibrary hasRecords={records.length > 0} /> : filtered.map((record) => <CapabilityListItem key={capabilityVersionKey(record)} record={record} selected={selected ? capabilityVersionKey(record) === capabilityVersionKey(selected) : false} onSelect={() => selectRecord(record)} />)}
          </div>
          {selectedGroups.length > 0 ? <p className={styles.sidebarFootnote}><ClockCounterClockwise /> {selectedGroups.length} capability{selectedGroups.length === 1 ? "" : "ies"} in view</p> : null}
        </aside>

        {selected ? <section className={styles.detail} aria-label={`${selected.name} details`}>
          <CapabilityDetailHeader record={selected} onAction={requestAction} actionAvailability={{ activate: Boolean(onActivate), deprecate: Boolean(onDeprecate), fork: Boolean(onFork) }} />
          <div className={styles.detailGrid}>
            <div className={styles.primaryColumn}>
              <section className={styles.panel} aria-labelledby="capability-inputs-heading">
                <div className={styles.panelHeading}><div><p className={styles.sectionKicker}>Configure</p><h2 id="capability-inputs-heading">Parameters</h2></div><SlidersHorizontal aria-hidden="true" /></div>
                <p className={styles.panelIntro}>Typed inputs are passed to the selected revision at activation.</p>
                <CapabilityParameterEditor parameters={selected.parameters ?? []} values={parameters} errors={parameterErrors} onChange={(name, value) => { setParameters((current) => ({ ...current, [name]: value })); setParameterErrors((current) => ({ ...current, [name]: "" })); }} />
              </section>
              <section className={styles.panel} aria-labelledby="capability-triggers-heading">
                <div className={styles.panelHeading}><div><p className={styles.sectionKicker}>Optional</p><h2 id="capability-triggers-heading">Triggers</h2></div><ArrowClockwise aria-hidden="true" /></div>
                <p className={styles.panelIntro}>Attach daemon-owned entry points only when this capability needs them.</p>
                <CapabilityTriggerEditor triggers={triggers} onChange={setTriggers} />
              </section>
            </div>
            <aside className={styles.secondaryColumn}>
              <DefaultsPanel defaults={selected.defaults} />
              <CapabilityVersionHistory versions={selectedVersions} selected={selected} onSelect={selectRecord} />
            </aside>
          </div>
        </section> : <EmptyLibrary hasRecords={false} detail />}
      </div>

      <CapabilityConfirmationDialog confirming={confirming} busy={busyAction !== null} onOpenChange={(open) => { if (!open && !busyAction) setConfirming(null); }} onConfirm={() => void confirmAction()} />
    </main>
  );
}

/** Naming alias for hosts that treat this as a surface in a larger workspace. */
export const CapabilityLibrarySurface = CapabilityLibrary;

function CapabilityListItem({ record, selected, onSelect }: { record: CapabilityVersionRecord; selected: boolean; onSelect: () => void }) {
  return <button id={`capability-${capabilityVersionKey(record)}`} type="button" role="option" aria-selected={selected} className={cn(styles.listItem, selected && styles.listItemSelected)} onClick={onSelect}>
    <span className={styles.listItemTop}><span className={styles.listItemName}>{record.name}</span><StatusPill status={record.status} /></span>
    <span className={styles.listItemBottom}><span className={styles.mono}>{formatCapabilityVersion(record.version)}</span><span className={styles.listItemDivider}>·</span><span className={styles.listItemSummary}>{record.summary ?? record.description ?? "No summary"}</span></span>
  </button>;
}

function CapabilityDetailHeader({ record, onAction, actionAvailability }: { record: CapabilityVersionRecord; onAction: (action: CapabilityAction) => void; actionAvailability: Record<CapabilityAction, boolean> }) {
  return <header className={styles.detailHeader}>
    <div className={styles.detailHeading}><div className={styles.detailTitleRow}><h2>{record.name}</h2><span className={styles.versionBadge}>{formatCapabilityVersion(record.version)}</span><StatusPill status={record.status} /></div><p className={styles.detailDescription}>{record.description ?? record.summary ?? "No description recorded for this revision."}</p><div className={styles.metadata}>{record.id} <span>/</span> {record.hash ? `sha256:${record.hash.slice(0, 12)}…` : "hash unavailable"} <span>/</span> updated {formatDate(record.updatedAt ?? record.createdAt)}</div></div>
    <div className={styles.actionRow} aria-label="Capability actions">
      <ActionButton action="activate" disabled={!actionAvailability.activate || record.status === "deprecated"} onClick={() => onAction("activate")} />
      <ActionButton action="deprecate" disabled={!actionAvailability.deprecate || record.status === "deprecated"} onClick={() => onAction("deprecate")} />
      <ActionButton action="fork" disabled={!actionAvailability.fork} onClick={() => onAction("fork")} />
    </div>
  </header>;
}

function ActionButton({ action, disabled, onClick }: { action: CapabilityAction; disabled: boolean; onClick: () => void }) {
  const icon = action === "activate" ? <ArrowSquareOut /> : action === "deprecate" ? <Minus /> : <GitBranch />;
  return <Button type="button" variant={action === "activate" ? "default" : "outline"} size="sm" disabled={disabled} onClick={onClick} title={disabled ? `${actionLabel(action)} unavailable` : undefined}>{icon}{actionLabel(action)}</Button>;
}

export function CapabilityParameterEditor({ parameters, values, errors = {}, onChange, disabled = false }: { parameters: readonly CapabilityParameter[]; values: CapabilityParameterValues; errors?: Readonly<Record<string, string>>; onChange: (name: string, value: CapabilityParameterValues[string]) => void; disabled?: boolean }) {
  if (parameters.length === 0) return <div className={styles.emptySubtle}><Code aria-hidden="true" /><span>This revision declares no parameters.</span></div>;
  return <div className={styles.parameterList}>{parameters.map((parameter) => <ParameterField key={parameter.name} parameter={parameter} value={values[parameter.name]} error={errors[parameter.name]} disabled={disabled} onChange={onChange} />)}</div>;
}

function ParameterField({ parameter, value, error, disabled, onChange }: { parameter: CapabilityParameter; value: CapabilityParameterValues[string]; error?: string; disabled: boolean; onChange: (name: string, value: CapabilityParameterValues[string]) => void }) {
  const id = `parameter-${parameter.name.replace(/[^a-z0-9_-]/giu, "-")}`;
  const describedBy = [parameter.description ? `${id}-description` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  const setValue = (next: CapabilityParameterValues[string]) => onChange(parameter.name, next);
  let control: ReactNode;
  if (parameter.type === "boolean") control = <label className={styles.toggle}><input id={id} type="checkbox" checked={value === true} onChange={(event) => setValue(event.target.checked)} disabled={disabled} aria-describedby={describedBy} /><span className={styles.toggleTrack} aria-hidden="true"><span /></span><span>{value === true ? "Enabled" : "Disabled"}</span></label>;
  else if (parameter.type === "enum") control = <div className={styles.selectWrap}><select id={id} value={typeof value === "string" ? value : ""} onChange={(event) => setValue(event.target.value || undefined)} disabled={disabled} aria-describedby={describedBy}><option value="">Select a value</option>{(parameter.enumValues ?? []).map((option) => <option value={option} key={option}>{option}</option>)}</select><CaretDown aria-hidden="true" /></div>;
  else if (parameter.type === "json") control = <textarea id={id} value={formatEditorValue(value)} onChange={(event) => { const raw = event.target.value; try { setValue(JSON.parse(raw) as CapabilityParameterValues[string]); } catch { setValue(raw); } }} placeholder={parameter.placeholder ?? "{ }"} rows={3} disabled={disabled} aria-describedby={describedBy} spellCheck={false} className={styles.jsonInput} />;
  else control = <input id={id} type={parameter.type === "number" || parameter.type === "integer" ? "number" : "text"} step={parameter.type === "integer" ? 1 : parameter.type === "number" ? "any" : undefined} value={value === undefined || value === null ? "" : String(value)} onChange={(event) => { const raw = event.target.value; if (raw === "") setValue(undefined); else if (parameter.type === "number" || parameter.type === "integer") setValue(Number(raw)); else setValue(raw); }} placeholder={parameter.placeholder} disabled={disabled} aria-describedby={describedBy} />;
  return <div className={cn(styles.parameterField, error && styles.parameterFieldError)}><div className={styles.parameterLabelRow}><label htmlFor={id}>{capabilityParameterLabel(parameter)}</label><span className={styles.typeBadge}>{parameter.type}</span>{parameter.required ? <span className={styles.required}>required</span> : null}</div>{control}{parameter.description ? <p id={`${id}-description`} className={styles.fieldDescription}>{parameter.description}</p> : null}{error ? <p id={`${id}-error`} className={styles.fieldError} role="alert"><Warning /> {error}</p> : null}</div>;
}

export function CapabilityTriggerEditor({ triggers, onChange, disabled = false }: { triggers: readonly CapabilityTrigger[]; onChange: (triggers: readonly CapabilityTrigger[]) => void; disabled?: boolean }) {
  const addTrigger = () => onChange([...triggers, { id: nextTriggerId(), type: "manual", enabled: true }]);
  return <div className={styles.triggerEditor}>{triggers.length === 0 ? <div className={styles.triggerEmpty}><span>No triggers attached.</span><button type="button" onClick={addTrigger} disabled={disabled}><Plus /> Add trigger</button></div> : <>{triggers.map((trigger, index) => <div className={styles.triggerRow} key={`${trigger.id}-${index}`}><div className={styles.triggerType}><select value={trigger.type} onChange={(event) => updateTrigger(triggers, index, { type: event.target.value as CapabilityTriggerType }, onChange)} disabled={disabled} aria-label={`Trigger ${index + 1} type`}>{(["manual", "cron", "webhook", "signal"] as const).map((type) => <option value={type} key={type}>{type}</option>)}{!["manual", "cron", "webhook", "signal"].includes(trigger.type) ? <option value={trigger.type}>{trigger.type}</option> : null}</select><CaretDown aria-hidden="true" /></div><input value={trigger.expression ?? ""} onChange={(event) => updateTrigger(triggers, index, { expression: event.target.value || undefined }, onChange)} placeholder={trigger.type === "manual" ? "Manual entry" : trigger.type === "cron" ? "0 9 * * 1-5" : "Expression or key"} disabled={disabled} aria-label={`Trigger ${index + 1} expression`} /><button type="button" className={styles.iconButton} onClick={() => onChange(triggers.filter((_, itemIndex) => itemIndex !== index))} disabled={disabled} aria-label={`Remove trigger ${index + 1}`}><Trash /></button></div>)}<button type="button" className={styles.addTrigger} onClick={addTrigger} disabled={disabled}><Plus /> Add trigger</button></>}</div>;
}

function DefaultsPanel({ defaults }: { defaults?: CapabilityDefaults }) {
  const entries = [["Harness", defaults?.harness], ["Model", defaults?.model], ["Permissions", defaults?.permissions?.join(", ")]].filter((entry): entry is [string, string] => Boolean(entry[1]));
  return <section className={styles.panel} aria-labelledby="capability-defaults-heading"><div className={styles.panelHeading}><div><p className={styles.sectionKicker}>Runtime</p><h2 id="capability-defaults-heading">Defaults</h2></div><ShieldCheck aria-hidden="true" /></div>{entries.length === 0 ? <div className={styles.emptySubtle}><span>No defaults recorded.</span></div> : <dl className={styles.defaultsList}>{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl>}<p className={styles.panelFootnote}>Inherited values remain explicit at activation.</p></section>;
}

export function CapabilityVersionHistory({ versions, selected, onSelect }: { versions: readonly CapabilityVersionRecord[]; selected: CapabilityVersionRecord; onSelect: (record: CapabilityVersionRecord) => void }) {
  const [compareKey, setCompareKey] = useState<string | null>(null);
  const compare = versions.find((record) => capabilityVersionKey(record) === compareKey) ?? versions.find((record) => capabilityVersionKey(record) !== capabilityVersionKey(selected));
  const diff = compare ? diffCapabilityVersions(compare, selected) : null;
  return <section className={styles.panel} aria-labelledby="capability-history-heading"><div className={styles.panelHeading}><div><p className={styles.sectionKicker}>Immutable record</p><h2 id="capability-history-heading">Version history</h2></div><ClockCounterClockwise aria-hidden="true" /></div><div className={styles.historyList}>{versions.length === 0 ? <span className={styles.emptySubtle}>No versions recorded.</span> : versions.map((record) => <button type="button" className={cn(styles.historyItem, capabilityVersionKey(record) === capabilityVersionKey(selected) && styles.historyItemSelected)} key={capabilityVersionKey(record)} onClick={() => onSelect(record)}><span className={styles.historyVersion}>{formatCapabilityVersion(record.version)}</span><span className={styles.historyDate}>{formatDate(record.createdAt)}</span><StatusPill status={record.status} /></button>)}</div>{versions.length > 1 ? <div className={styles.diffBlock}><label htmlFor="capability-compare">Compare selected with</label><div className={styles.selectWrap}><select id="capability-compare" value={compare ? capabilityVersionKey(compare) : ""} onChange={(event) => setCompareKey(event.target.value || null)}><option value="">Choose a revision</option>{versions.filter((record) => capabilityVersionKey(record) !== capabilityVersionKey(selected)).map((record) => <option value={capabilityVersionKey(record)} key={capabilityVersionKey(record)}>{formatCapabilityVersion(record.version)} · {record.status}</option>)}</select><CaretDown aria-hidden="true" /></div>{diff ? <CapabilityDiffView diff={diff} /> : <p className={styles.diffHint}>Select another revision to inspect changes.</p>}</div> : null}</section>;
}

function CapabilityDiffView({ diff }: { diff: ReturnType<typeof diffCapabilityVersions> }) {
  if (!diff.changed) return <div className={styles.noDiff}><Check /> No changes between these revisions.</div>;
  return <div className={styles.diffList}>{diff.entries.map((entry) => <details key={entry.key} className={styles.diffEntry} open><summary><span className={cn(styles.diffMarker, entry.kind === "added" ? styles.diffAdded : entry.kind === "removed" ? styles.diffRemoved : styles.diffChanged)}>{entry.kind === "added" ? "+" : entry.kind === "removed" ? "−" : "~"}</span><span>{entry.label}</span><CaretDown /></summary><div className={styles.diffValues}>{entry.kind !== "added" ? <pre className={styles.diffBefore}>{entry.before}</pre> : null}{entry.kind !== "removed" ? <pre className={styles.diffAfter}>{entry.after}</pre> : null}</div></details>)}</div>;
}

function CapabilityConfirmationDialog({ confirming, busy, onOpenChange, onConfirm }: { confirming: { action: CapabilityAction; record: CapabilityVersionRecord } | null; busy: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  const action = confirming?.action;
  return <Dialog open={Boolean(confirming)} onOpenChange={onOpenChange}><DialogContent className={styles.confirmDialog}><DialogHeader><DialogTitle>{action ? `${actionLabel(action)} ${formatCapabilityVersion(confirming.record.version)}?` : "Confirm capability action"}</DialogTitle><DialogDescription>{action ? confirmationDescription(action, confirming.record) : "Confirm this capability change."}</DialogDescription></DialogHeader><div className={styles.confirmCallout}><ShieldCheck /><span>Only the selected immutable revision will be affected.</span></div><DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button><Button type="button" variant={action === "deprecate" ? "destructive" : "default"} onClick={onConfirm} disabled={busy || !action}>{busy ? <AgentLoader kind="circular" size={14} label={`${actionLabel(action ?? "activate")} in progress`} /> : null}{busy ? "Working…" : action ? actionLabel(action) : "Confirm"}</Button></DialogFooter></DialogContent></Dialog>;
}

function StatusPill({ status }: { status: CapabilityStatus }) { return <span className={cn(styles.status, styles[`status${status[0].toUpperCase()}${status.slice(1)}`])}><span />{status}</span>; }
function EmptyLibrary({ hasRecords, detail = false }: { hasRecords: boolean; detail?: boolean }) { return <div className={detail ? styles.emptyDetail : styles.emptyLibrary}><Sparkle aria-hidden="true" /><h2>{hasRecords ? "No matching capabilities" : "Capability registry is empty"}</h2><p>{hasRecords ? "Try a different search or status filter." : "Live capability records will appear here when the daemon returns them."}</p></div>; }
function actionLabel(action: CapabilityAction): string { return action[0].toUpperCase() + action.slice(1); }
function confirmationDescription(action: CapabilityAction, record: CapabilityVersionRecord): string { if (action === "activate") return `Activate ${record.name} using its ${formatCapabilityVersion(record.version)} defaults and typed inputs.`; if (action === "deprecate") return `Deprecate ${record.name} ${formatCapabilityVersion(record.version)}. Existing runs are not rewritten.`; return `Create a new editable revision from ${record.name} ${formatCapabilityVersion(record.version)}.`; }
function formatEditorValue(value: CapabilityParameterValues[string]): string { if (value === undefined || value === null) return ""; return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value); }
function updateTrigger(triggers: readonly CapabilityTrigger[], index: number, patch: Partial<CapabilityTrigger>, onChange: (triggers: readonly CapabilityTrigger[]) => void) { onChange(triggers.map((trigger, triggerIndex) => triggerIndex === index ? { ...trigger, ...patch } : trigger)); }
function nextTriggerId(): string { if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `trigger-${crypto.randomUUID().slice(0, 8)}`; return `trigger-${Date.now().toString(36)}`; }
function isTypingTarget(target: EventTarget | null): boolean { return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable); }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date); }
