import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityApiAdapter, type CapabilityApiResponse } from "../apps/daemon/src/capability-api.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const actor = { type: "user" as const, id: "local-user" };
const timestamps = {
  one: "2026-09-01T00:00:00.000Z",
  two: "2026-09-01T00:01:00.000Z",
};

function capability(description = "Summarise a document") {
  return {
    capabilityId: "document.summarise",
    definition: {
      name: "Document summary",
      description,
      parameters: {
        type: "object" as const,
        properties: { document: { type: "string" as const } },
        required: ["document"],
        additionalProperties: false,
      },
      defaults: { harness: "fixture", permission: "read-only" },
    },
    provenance: { source: "test", actor: "local-user" },
  };
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "symphony-capability-api-"));
  temporary.push(directory);
  return join(directory, "capabilities.sqlite");
}

function body(response: CapabilityApiResponse): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

describe("capability API adapter", () => {
  it("requires strict mutation envelopes and never creates a record for invalid input", () => {
    const adapter = new CapabilityApiAdapter(databasePath());
    expect(adapter.create(capability())).toMatchObject({ status: 400, body: { error: expect.any(String) } });
    expect(adapter.create({ ...capability(), actor })).toMatchObject({ status: 400, body: { error: expect.any(String) } });
    expect(adapter.create({ ...capability(), requestKey: "create-1" })).toMatchObject({ status: 400, body: { error: expect.any(String) } });
    expect(adapter.list().body).toEqual([]);
    adapter.close();
  });

  it("exposes HTTP-shaped routes for create, get, activate, deprecate, and prepare", async () => {
    const adapter = new CapabilityApiAdapter(databasePath(), { clock: () => timestamps.one });
    const created = await adapter.handle({
      method: "POST",
      path: "/v1/capabilities",
      body: { ...capability(), actor, requestKey: "create-1" },
    });
    expect(created.status).toBe(201);
    const record = body(created).version as Record<string, unknown>;
    expect(record).toMatchObject({ capabilityId: "document.summarise", version: 1, state: "draft" });

    const fetched = await adapter.handle({ method: "GET", path: "/v1/capabilities/document.summarise/1" });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ capabilityId: "document.summarise", version: 1 });

    const prepared = await adapter.handle({
      method: "POST",
      path: "/v1/capabilities/document.summarise/1/prepare",
      body: { parameters: { document: "hello" }, target: { harness: "fixture", features: [] } },
    });
    expect(prepared.status).toBe(200);
    expect(prepared.body).toMatchObject({ compatible: true, parameters: { document: "hello" } });

    const activated = await adapter.handle({
      method: "POST",
      path: "/v1/capabilities/document.summarise/1/activate",
      body: {
        actor,
        requestKey: "activate-1",
        parameters: { document: "hello" },
        triggers: [{ id: "manual", kind: "manual", configuration: { source: "api" }, enabled: true }],
      },
    });
    expect(activated.status).toBe(200);
    expect(body(activated)).toMatchObject({
      status: "committed",
      version: {
        state: "active",
        activation: {
          parameters: { document: "hello" },
          triggers: [{ id: "manual", kind: "manual", configuration: { source: "api" }, enabled: true }],
        },
      },
    });
    const activationConflict = await adapter.handle({
      method: "POST",
      path: "/v1/capabilities/document.summarise/1/activate",
      body: { actor, requestKey: "activate-1", parameters: { document: "different" } },
    });
    expect(activationConflict.status).toBe(409);
    expect(body(activationConflict)).toMatchObject({ status: "conflict", version: null });

    const deprecated = await adapter.handle({
      method: "POST",
      path: "/v1/capabilities/document.summarise/1/deprecate",
      body: { actor, requestKey: "deprecate-1" },
    });
    expect(deprecated.status).toBe(200);
    expect(body(deprecated)).toMatchObject({ status: "committed", version: { state: "deprecated" } });
    adapter.close();
  });

  it("replays after restart and reports idempotency conflicts without mutating state", async () => {
    const path = databasePath();
    const first = new CapabilityApiAdapter(path, { clock: () => timestamps.one });
    const request = { ...capability(), actor, requestKey: "create-1" };
    const committed = first.create(request);
    const committedRecord = body(committed).version;
    first.close();

    const restarted = new CapabilityApiAdapter(path, { clock: () => timestamps.two });
    const replay = restarted.create(request);
    expect(replay.status).toBe(200);
    expect(body(replay)).toMatchObject({ status: "replayed", version: committedRecord });
    expect(restarted.list().body).toHaveLength(1);

    const conflict = restarted.create({ ...capability("different"), actor, requestKey: "create-1" });
    expect(conflict.status).toBe(409);
    expect(body(conflict)).toMatchObject({ status: "conflict", version: null, reason: expect.stringContaining("Idempotency") });
    expect(restarted.list().body).toHaveLength(1);

    const missing = restarted.activate({ capabilityId: "missing", version: 1, actor, requestKey: "activate-missing" });
    expect(missing.status).toBe(404);
    expect(body(missing)).toMatchObject({ status: "rejected", version: null, reason: expect.stringContaining("not found") });
    const missingReplay = restarted.activate({ capabilityId: "missing", version: 1, actor, requestKey: "activate-missing" });
    expect(missingReplay.status).toBe(200);
    expect(body(missingReplay)).toMatchObject({ status: "replayed", reason: expect.stringContaining("not found") });
    restarted.close();
  });

  it("returns truthful errors for unknown routes, versions, and incompatible preparation", async () => {
    const adapter = new CapabilityApiAdapter(databasePath());
    expect((await adapter.handle({ method: "GET", path: "/v1/capabilities/unknown/1" })).status).toBe(404);
    expect((await adapter.handle({ method: "GET", path: "/v1/not-capabilities" })).status).toBe(404);
    expect((await adapter.handle({ method: "POST", path: "/v1/capabilities", body: { ...capability(), actor, requestKey: "create-1", extra: true } })).status).toBe(400);
    const created = adapter.create({ ...capability(), actor, requestKey: "create-1" });
    const record = body(created).version as Record<string, unknown>;
    const prepared = adapter.prepare({ capabilityId: "document.summarise", version: record.version, parameters: {}, target: { harness: "other", features: [] } });
    expect(prepared.status).toBe(200);
    expect(prepared.body).toMatchObject({ compatible: false, reasons: expect.arrayContaining([expect.stringContaining("document is required")]) });
    adapter.close();
  });

  it("rejects invalid activation inputs without changing lifecycle state", () => {
    const adapter = new CapabilityApiAdapter(databasePath(), { clock: () => timestamps.one });
    const created = adapter.create({ ...capability(), actor, requestKey: "create-1" });
    expect(created.status).toBe(201);
    const rejected = adapter.activate({
      capabilityId: "document.summarise",
      version: 1,
      actor,
      requestKey: "activate-invalid",
      parameters: { document: 7 },
    });
    expect(rejected.status).toBe(422);
    expect(body(rejected)).toMatchObject({ status: "rejected", reason: expect.stringContaining("document") });
    expect(adapter.get("document.summarise", 1).body).toMatchObject({ state: "draft" });
    adapter.close();
  });
});
