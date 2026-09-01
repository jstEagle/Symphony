import { describe, expect, it } from "vitest";
import {
  adaptCapabilityVersionRecord,
  capabilityVersionKey,
  diffCapabilityVersions,
  filterCapabilityVersions,
  groupCapabilityVersions,
  initialCapabilityParameterValues,
  validateCapabilityParameterValues,
  type CapabilityVersionRecord,
} from "./capability-library";

const v1: CapabilityVersionRecord = {
  id: "release-notes",
  name: "Release notes",
  version: 1,
  status: "deprecated",
  summary: "Draft release notes from merged changes",
  tags: ["release", "writing"],
  createdAt: "2026-08-01T00:00:00.000Z",
  parameters: [
    { name: "audience", type: "enum", required: true, enumValues: ["internal", "public"] },
    { name: "includeLinks", type: "boolean", defaultValue: true },
  ],
  defaults: { harness: "codex", model: "auto", permissions: ["read repository"] },
};

const v2: CapabilityVersionRecord = {
  ...v1,
  version: 2,
  status: "active",
  summary: "Draft and validate release notes from merged changes",
  createdAt: "2026-08-15T00:00:00.000Z",
  parameters: [...(v1.parameters ?? []), { name: "tone", type: "string", defaultValue: "direct" }],
};

describe("capability library adapter", () => {
  it("groups immutable versions and orders newest versions first", () => {
    const groups = groupCapabilityVersions([v1, v2]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.versions.map((record) => record.version)).toEqual([2, 1]);
    expect(capabilityVersionKey(v2)).toBe("release-notes@2");
  });

  it("searches names, summaries, tags, and status without creating records", () => {
    expect(filterCapabilityVersions([v1, v2], { text: "writing", status: "all" })).toHaveLength(2);
    expect(filterCapabilityVersions([v1, v2], { text: "validate", status: "active" }).map((record) => record.version)).toEqual([2]);
    expect(filterCapabilityVersions([], { text: "anything", status: "all" })).toEqual([]);
  });

  it("only seeds declared parameter defaults and validates typed values", () => {
    expect(initialCapabilityParameterValues(v1.parameters)).toEqual({ includeLinks: true });
    expect(validateCapabilityParameterValues(v1.parameters ?? [], { audience: "other", includeLinks: "yes" })).toEqual({ audience: "Choose an available value", includeLinks: "Enter true or false" });
    expect(validateCapabilityParameterValues(v1.parameters ?? [], { audience: "public", includeLinks: false })).toEqual({});
  });

  it("returns a meaningful field-level diff and an unchanged result", () => {
    const diff = diffCapabilityVersions(v1, v2);
    expect(diff.changed).toBe(true);
    expect(diff.entries.map((entry) => entry.key)).toEqual(["summary", "parameters"]);
    expect(diffCapabilityVersions(v2, { ...v2 }).changed).toBe(false);
  });

  it("adapts the daemon's JSON-Schema parameters and caller-defined trigger kinds", () => {
    const adapted = adaptCapabilityVersionRecord({
      capabilityId: "sync",
      version: 3,
      state: "active",
      definition: {
        name: "Sync records",
        description: "Synchronize records",
        parameters: {
          required: ["limit"],
          properties: {
            limit: { type: "integer", title: "Batch size" },
            scope: { type: "string", enum: ["open", "all"] },
          },
        },
        triggers: [{ id: "nightly", kind: "vendor.schedule", configuration: { expression: "0 0 * * *" } }],
        defaults: { harness: "acp", permission: "workspace:write" },
      },
      activation: {
        parameters: { limit: 25 },
        triggers: [{ id: "nightly", kind: "vendor.schedule", configuration: { expression: "0 1 * * *" }, enabled: true }],
      },
      hash: "f".repeat(64),
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    expect(adapted).toMatchObject({ id: "sync", version: 3, status: "active" });
    expect(adapted.parameters).toEqual([
      { name: "limit", label: "Batch size", type: "integer", required: true },
      { name: "scope", type: "enum", enumValues: ["open", "all"] },
    ]);
    expect(adapted.triggers?.[0]).toMatchObject({ id: "nightly", type: "vendor.schedule" });
    expect(adapted.activation).toMatchObject({ parameters: { limit: 25 }, triggers: [{ id: "nightly", type: "vendor.schedule" }] });
    expect(adapted.defaults).toEqual({ harness: "acp", permissions: ["workspace:write"] });
  });
});
