import { describe, expect, it } from "vitest";
import type { ObjectiveRunRecord } from "./contracts";
import { objectiveProjectionState } from "./objective-project";

const objectiveRun = { runId: "run-1", objectiveId: "objective-1" } as ObjectiveRunRecord;

function state(overrides: Partial<Parameters<typeof objectiveProjectionState>[0]> = {}) {
  return objectiveProjectionState({
    enabled: true,
    live: true,
    listPending: false,
    listFetching: false,
    listError: null,
    objectiveRun: null,
    snapshotPending: false,
    snapshotFetching: false,
    snapshotError: null,
    snapshotReady: false,
    ...overrides,
  });
}

describe("authoritative objective runline state", () => {
  it("keeps the legitimate no-objective fallback distinct from loading", () => {
    expect(state()).toBe("no-objective");
    expect(state({ listPending: true })).toBe("loading");
    expect(state({ listFetching: true })).toBe("loading");
  });

  it("fails closed when the objective list fails, even if cached rows remain", () => {
    expect(state({ listError: new Error("daemon unavailable"), objectiveRun })).toBe("unavailable");
  });

  it("fails closed when the selected objective snapshot fails", () => {
    expect(state({ objectiveRun, snapshotReady: true, snapshotError: new Error("snapshot unavailable") })).toBe("unavailable");
  });

  it("only projects the durable workspace after the snapshot is ready", () => {
    expect(state({ objectiveRun })).toBe("loading");
    expect(state({ objectiveRun, snapshotReady: true })).toBe("ready");
  });

  it("does not query or render the live projection when disabled", () => {
    expect(state({ enabled: false, listError: new Error("ignored") })).toBe("disabled");
    expect(state({ live: false })).toBe("disabled");
  });
});
