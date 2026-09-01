import type { JsonValue } from "./contracts";

export type CapabilityParameterType = "string" | "number" | "integer" | "boolean" | "enum" | "json";

export type CapabilityParameter = Readonly<{
  name: string;
  label?: string;
  type: CapabilityParameterType;
  description?: string;
  required?: boolean;
  defaultValue?: JsonValue;
  enumValues?: readonly string[];
  placeholder?: string;
}>;

export type CapabilityTriggerType = "manual" | "cron" | "webhook" | "signal" | (string & {});

export type CapabilityTrigger = Readonly<{
  id: string;
  type: CapabilityTriggerType;
  label?: string;
  expression?: string;
  enabled?: boolean;
}>;

/** Defaults intentionally use provider-owned strings: the library does not impose roles or opinions. */
export type CapabilityDefaults = Readonly<{
  harness?: string;
  model?: string;
  permissions?: readonly string[];
}>;

export type CapabilityStatus = "draft" | "active" | "deprecated";

export type CapabilityVersionRecord = Readonly<{
  id: string;
  name: string;
  version: string | number;
  status: CapabilityStatus;
  summary?: string;
  description?: string;
  tags?: readonly string[];
  createdAt: string;
  updatedAt?: string;
  createdBy?: string;
  hash?: string;
  parameters?: readonly CapabilityParameter[];
  triggers?: readonly CapabilityTrigger[];
  defaults?: CapabilityDefaults;
  /** Last daemon-admitted activation inputs, when the version is active. */
  activation?: Readonly<{
    parameters: JsonValue;
    triggers: readonly CapabilityTrigger[];
  }>;
  /** Optional canonical source used by the adapter to produce a meaningful diff. */
  source?: JsonValue;
}>;

/** Structural shape of the daemon/protocol record, kept local to avoid coupling the web bundle to zod. */
export type CapabilityVersionSource = Readonly<{
  capabilityId: string;
  version: number;
  state?: CapabilityStatus;
  status?: CapabilityStatus;
  definition: Readonly<{
    name?: string;
    description?: string;
    parameters?: Readonly<{
      properties?: Readonly<Record<string, Readonly<{
        title?: string;
        description?: string;
        type?: string;
        enum?: readonly JsonValue[];
      }>>>;
      required?: readonly string[];
    }>;
    triggers?: readonly Readonly<{
      id: string;
      kind: string;
      configuration?: JsonValue;
      enabled?: boolean;
    }>[];
    defaults?: Readonly<{
      harness?: string;
      model?: string;
      permission?: string;
      permissions?: string;
    }>;
  }>;
  activation?: Readonly<{
    parameters: JsonValue;
    triggers: readonly Readonly<{
      id: string;
      kind: string;
      configuration?: JsonValue;
      enabled?: boolean;
    }>[];
  }>;
  hash?: string;
  createdAt: string;
  updatedAt?: string;
}>;

export type CapabilityLibraryItem = Readonly<{
  id: string;
  name: string;
  versions: readonly CapabilityVersionRecord[];
}>;

export type CapabilityParameterValue = string | number | boolean | JsonValue[] | { [key: string]: JsonValue } | null;
export type CapabilityParameterValues = Readonly<Record<string, CapabilityParameterValue | undefined>>;

export type CapabilityDiffEntry = Readonly<{
  key: string;
  label: string;
  before: string;
  after: string;
  kind: "added" | "removed" | "changed";
}>;

export type CapabilityDiff = Readonly<{
  entries: readonly CapabilityDiffEntry[];
  changed: boolean;
}>;

export type CapabilityQuery = Readonly<{
  text?: string;
  status?: CapabilityStatus | "all";
}>;

export function groupCapabilityVersions(records: readonly CapabilityVersionRecord[]): CapabilityLibraryItem[] {
  const groups = new Map<string, CapabilityVersionRecord[]>();
  for (const record of records) {
    const versions = groups.get(record.id) ?? [];
    versions.push(record);
    groups.set(record.id, versions);
  }
  return [...groups.entries()]
    .map(([id, versions]) => {
      const ordered = [...versions].sort(compareVersions);
      return { id, name: ordered[0]?.name ?? id, versions: ordered };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/** Convert the daemon contract into a compact, render-ready view model. */
export function adaptCapabilityVersionRecord(source: CapabilityVersionSource): CapabilityVersionRecord {
  const parameters = source.definition.parameters;
  const required = new Set(parameters?.required ?? []);
  const mappedParameters = Object.entries(parameters?.properties ?? {}).map(([name, node]) => {
    const enumValues = node.enum?.every((value): value is string => typeof value === "string") ? node.enum : undefined;
    const type: CapabilityParameterType = enumValues?.length ? "enum" : node.type === "number" || node.type === "integer" || node.type === "boolean" || node.type === "string" ? node.type : "json";
    return {
      name,
      ...(node.title ? { label: node.title } : {}),
      type,
      ...(node.description ? { description: node.description } : {}),
      ...(required.has(name) ? { required: true } : {}),
      ...(enumValues ? { enumValues } : {}),
    } satisfies CapabilityParameter;
  });
  const mapTrigger = (trigger: { id: string; kind: string; configuration?: JsonValue; enabled?: boolean }): CapabilityTrigger => ({
    id: trigger.id,
    type: trigger.kind,
    ...(trigger.configuration === undefined ? {} : { expression: stableValue(trigger.configuration) }),
    ...(trigger.enabled === undefined ? {} : { enabled: trigger.enabled }),
  });
  const triggers = (source.definition.triggers ?? []).map(mapTrigger);
  const activation = source.activation === undefined ? undefined : {
    parameters: source.activation.parameters,
    triggers: source.activation.triggers.map(mapTrigger),
  } satisfies NonNullable<CapabilityVersionRecord["activation"]>;
  const defaults = source.definition.defaults;
  const permissions = defaults?.permissions ?? defaults?.permission;
  return {
    id: source.capabilityId,
    name: source.definition.name ?? source.capabilityId,
    version: source.version,
    status: source.status ?? source.state ?? "draft",
    ...(source.definition.description ? { description: source.definition.description } : {}),
    createdAt: source.createdAt,
    ...(source.updatedAt ? { updatedAt: source.updatedAt } : {}),
    ...(source.hash ? { hash: source.hash } : {}),
    ...(mappedParameters.length ? { parameters: mappedParameters } : {}),
    ...(triggers.length ? { triggers } : {}),
    ...(activation === undefined ? {} : { activation }),
    ...(defaults || permissions ? { defaults: { ...(defaults?.harness ? { harness: defaults.harness } : {}), ...(defaults?.model ? { model: defaults.model } : {}), ...(permissions ? { permissions: [permissions] } : {}) } } : {}),
  };
}

export function filterCapabilityVersions(records: readonly CapabilityVersionRecord[], query: CapabilityQuery): CapabilityVersionRecord[] {
  const text = query.text?.trim().toLocaleLowerCase();
  return records.filter((record) => {
    if (query.status && query.status !== "all" && record.status !== query.status) return false;
    if (!text) return true;
    const haystack = [
      record.id,
      record.name,
      record.summary,
      record.description,
      ...(record.tags ?? []),
      formatCapabilityVersion(record.version),
    ].filter(Boolean).join(" ").toLocaleLowerCase();
    return haystack.includes(text);
  }).sort((left, right) => left.name.localeCompare(right.name) || compareVersions(left, right));
}

export function capabilityVersionKey(record: Pick<CapabilityVersionRecord, "id" | "version">): string {
  return `${record.id}@${String(record.version)}`;
}

export function formatCapabilityVersion(version: string | number): string {
  const value = String(version);
  return value.startsWith("v") ? value : `v${value}`;
}

export function capabilityParameterLabel(parameter: CapabilityParameter): string {
  return parameter.label?.trim() || parameter.name;
}

export function initialCapabilityParameterValues(parameters: readonly CapabilityParameter[] = []): CapabilityParameterValues {
  return Object.fromEntries(parameters.filter((parameter) => parameter.defaultValue !== undefined).map((parameter) => [parameter.name, parameter.defaultValue]));
}

export function validateCapabilityParameterValues(
  parameters: readonly CapabilityParameter[],
  values: CapabilityParameterValues,
): Readonly<Record<string, string>> {
  const errors: Record<string, string> = {};
  for (const parameter of parameters) {
    const value = values[parameter.name];
    if (parameter.required && (value === undefined || value === null || (typeof value === "string" && !value.trim()))) {
      errors[parameter.name] = "Required";
      continue;
    }
    if (value === undefined || value === null || value === "") continue;
    if ((parameter.type === "number" || parameter.type === "integer") && (typeof value !== "number" || !Number.isFinite(value) || (parameter.type === "integer" && !Number.isInteger(value)))) {
      errors[parameter.name] = parameter.type === "integer" ? "Enter a whole number" : "Enter a number";
    } else if (parameter.type === "boolean" && typeof value !== "boolean") {
      errors[parameter.name] = "Enter true or false";
    } else if (parameter.type === "enum" && (typeof value !== "string" || !parameter.enumValues?.includes(value))) {
      errors[parameter.name] = "Choose an available value";
    } else if (parameter.type === "json" && typeof value === "string") {
      errors[parameter.name] = "Enter valid JSON";
    }
  }
  return errors;
}

export function diffCapabilityVersions(before: CapabilityVersionRecord, after: CapabilityVersionRecord): CapabilityDiff {
  const entries: CapabilityDiffEntry[] = [];
  addDiff(entries, "summary", "Summary", before.summary, after.summary);
  addDiff(entries, "description", "Description", before.description, after.description);
  addDiff(entries, "tags", "Tags", before.tags, after.tags);
  addDiff(entries, "parameters", "Parameters", before.parameters, after.parameters);
  addDiff(entries, "triggers", "Triggers", before.triggers, after.triggers);
  addDiff(entries, "defaults", "Defaults", before.defaults, after.defaults);
  if (before.source !== undefined || after.source !== undefined) addDiff(entries, "source", "Source", before.source, after.source);
  return { entries, changed: entries.length > 0 };
}

function addDiff(entries: CapabilityDiffEntry[], key: string, label: string, before: unknown, after: unknown): void {
  const beforeText = stableValue(before);
  const afterText = stableValue(after);
  if (beforeText === afterText) return;
  entries.push({ key, label, before: beforeText, after: afterText, kind: before === undefined ? "added" : after === undefined ? "removed" : "changed" });
}

function stableValue(value: unknown): string {
  if (value === undefined) return "Not set";
  if (typeof value === "string") return value || "Empty";
  return JSON.stringify(value, null, 2) ?? String(value);
}

function compareVersions(left: Pick<CapabilityVersionRecord, "version" | "createdAt">, right: Pick<CapabilityVersionRecord, "version" | "createdAt">): number {
  const leftNumber = numericVersion(left.version);
  const rightNumber = numericVersion(right.version);
  if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) return rightNumber - leftNumber;
  return String(right.version).localeCompare(String(left.version), undefined, { numeric: true }) || right.createdAt.localeCompare(left.createdAt);
}

function numericVersion(version: string | number): number | undefined {
  const value = typeof version === "number" ? version : Number.parseFloat(version.replace(/^v/iu, ""));
  return Number.isFinite(value) ? value : undefined;
}
