import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CapabilityLibraryRepository } from "../../storage/src/capability-library.js";
import { CapabilityLibrary } from "./capability-library.js";

const t1 = "2026-09-01T00:00:00.000Z";
const t2 = "2026-09-01T00:01:00.000Z";
const t3 = "2026-09-01T00:02:00.000Z";

function draft(description = "Summarise a document") {
  return {
    capabilityId: "document.summarise",
    definition: {
      name: "Document summary",
      description,
      parameters: {
        type: "object" as const,
        properties: {
          document: { type: "string" as const },
          format: { type: "string" as const, enum: ["short", "long"] },
        },
        required: ["document"],
        additionalProperties: false,
      },
      triggers: [{ id: "on-upload", kind: "file.uploaded", configuration: { extension: ".md" }, enabled: true }],
      defaults: { harness: "custom-harness", model: "custom-model", permission: "read-only" },
      compatibility: { harnesses: ["custom-harness"], models: ["custom-model"], permissions: ["read-only"], features: ["streaming"] },
      strategy: { steps: ["extract", "summarise"] },
    },
    provenance: { source: "workspace", revision: "git:abc123", actor: "author-1", metadata: { imported: false } },
  };
}

describe("capability library", () => {
  it("keeps immutable version history, activates one version, and survives restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-capability-library-"));
    const databasePath = join(directory, "library.sqlite");
    const firstRepository = new CapabilityLibraryRepository(databasePath);
    const first = new CapabilityLibrary(firstRepository);

    const v1 = first.createVersion({ ...draft(), requestKey: "create-1", now: t1 });
    expect(v1.status).toBe("committed");
    expect(v1.version?.version).toBe(1);
    expect(v1.version?.state).toBe("draft");
    expect(v1.version?.hash).toMatch(/^[a-f0-9]{64}$/);

    const replay = first.createVersion({ ...draft(), requestKey: "create-1", now: t2 });
    expect(replay.status).toBe("replayed");
    expect(replay.version).toEqual(v1.version);

    const v2 = first.createVersion({ ...draft("Summarise a document with citations"), requestKey: "create-2", now: t2 });
    expect(v2.version?.version).toBe(2);
    expect(v2.version?.hash).not.toBe(v1.version?.hash);

    expect(first.activate({ capabilityId: "document.summarise", version: 1, requestKey: "activate-1", now: t2 }).status).toBe("committed");
    expect(first.activate({ capabilityId: "document.summarise", version: 2, requestKey: "activate-2", now: t3 }).status).toBe("committed");
    expect(first.resolve("document.summarise")?.version).toBe(2);
    expect(first.get("document.summarise", 1)?.state).toBe("deprecated");

    firstRepository.close();
    const restartedRepository = new CapabilityLibraryRepository(databasePath);
    const restarted = new CapabilityLibrary(restartedRepository);
    expect(restarted.list("document.summarise").map((record) => record.version)).toEqual([1, 2]);
    expect(restarted.resolve("document.summarise")?.hash).toBe(v2.version?.hash);
    expect(restarted.createVersion({ ...draft(), requestKey: "create-1", now: t3 })).toEqual({
      status: "replayed",
      version: v1.version,
    });
    restartedRepository.close();
  });

  it("rejects idempotency-key reuse with a different command and records missing-target outcomes", () => {
    const repository = new CapabilityLibraryRepository(":memory:");
    const library = new CapabilityLibrary(repository, () => t1);
    expect(library.createVersion({ ...draft(), requestKey: "same-key" }).status).toBe("committed");
    const conflict = library.createVersion({ ...draft("changed"), requestKey: "same-key" });
    expect(conflict.status).toBe("conflict");
    expect(conflict.reason).toContain("Idempotency");

    const missing = library.activate({ capabilityId: "missing", version: 1, requestKey: "activate-missing" });
    expect(missing.status).toBe("rejected");
    expect(library.activate({ capabilityId: "missing", version: 1, requestKey: "activate-missing" }).status).toBe("replayed");
    repository.close();
  });

  it("validates typed parameters and caller-defined compatibility without prescribing roles", () => {
    const repository = new CapabilityLibraryRepository(":memory:");
    const library = new CapabilityLibrary(repository, () => t1);
    const created = library.createVersion({ ...draft(), requestKey: "create-compatible" });
    const record = created.version!;
    const good = library.prepareExecution("document.summarise", record.version, {
      parameters: { document: "hello", format: "short" },
      target: { harness: "custom-harness", model: "custom-model", permission: "read-only", features: ["streaming"] },
    });
    expect(good.compatible).toBe(true);
    expect(good.defaults.harness).toBe("custom-harness");

    const bad = library.prepareExecution("document.summarise", record.version, {
      parameters: { format: "invalid", extra: true },
      target: { harness: "other-harness", features: [] },
    });
    expect(bad.compatible).toBe(false);
    expect(bad.reasons.join(" ")).toContain("document is required");
    expect(bad.reasons.join(" ")).toContain("Harness is not compatible");
    expect(bad.reasons.join(" ")).toContain("Required feature is unavailable");
    repository.close();
  });

  it("admits activation inputs through the durable state transition and replays them after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-capability-activation-"));
    const databasePath = join(directory, "library.sqlite");
    const repository = new CapabilityLibraryRepository(databasePath);
    const library = new CapabilityLibrary(repository, () => t1);
    const created = library.createVersion({ ...draft(), requestKey: "create-activation" });
    const activated = library.activate({
      capabilityId: "document.summarise",
      version: created.version!.version,
      requestKey: "activate-activation",
      parameters: { document: "hello", format: "short" },
      triggers: [{ id: "on-upload", kind: "file.uploaded", configuration: { extension: ".txt" }, enabled: true }],
      target: { harness: "custom-harness", model: "custom-model", permission: "read-only", features: ["streaming"] },
    });
    expect(activated.status).toBe("committed");
    expect(activated.version?.activation).toEqual({
      parameters: { document: "hello", format: "short" },
      triggers: [{ id: "on-upload", kind: "file.uploaded", configuration: { extension: ".txt" }, enabled: true }],
      defaults: { harness: "custom-harness", model: "custom-model", permission: "read-only" },
    });
    repository.close();

    const restartedRepository = new CapabilityLibraryRepository(databasePath);
    const restarted = new CapabilityLibrary(restartedRepository, () => t2);
    expect(restarted.get("document.summarise", 1)?.activation?.parameters).toEqual({ document: "hello", format: "short" });
    const invalid = restarted.activate({
      capabilityId: "document.summarise",
      version: 1,
      requestKey: "activate-invalid",
      parameters: { document: "", format: "invalid" },
    });
    expect(invalid.status).toBe("rejected");
    expect(restarted.get("document.summarise", 1)?.state).toBe("active");
    restartedRepository.close();
  });
});
