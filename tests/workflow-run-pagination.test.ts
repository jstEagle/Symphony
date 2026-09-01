import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SymphonyStore, type WorkflowRunRecord } from "../packages/storage/src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function run(index: number): WorkflowRunRecord {
  return {
    id: `run-${String(index).padStart(3, "0")}`,
    workflowId: "durable-recovery",
    workflowRevision: 1,
    status: "running",
    input: {},
    output: null,
    error: null,
    startedAt: "2026-09-01T00:00:00.000Z",
    // Deliberately tie timestamps: the id is the keyset tiebreaker.
    updatedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: null,
    cancelRequested: false,
  };
}

describe("workflow run recovery pagination", () => {
  it("walks every non-terminal run beyond the legacy 200-run recovery cap", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-workflow-run-pagination-"));
    temporary.push(root);
    const store = new SymphonyStore(join(root, "state.sqlite"));
    try {
      for (let index = 0; index < 205; index += 1) store.saveRun(run(index));

      const seen: string[] = [];
      let cursor: { updatedAt: string; id: string } | undefined;
      do {
        const page = store.listRunPage({ status: ["running"], limit: 17, ...(cursor ? { cursor } : {}) });
        seen.push(...page.runs.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(seen).toHaveLength(205);
      expect(new Set(seen).size).toBe(205);
      expect(seen).toEqual([...Array(205)].map((_, index) => `run-${String(204 - index).padStart(3, "0")}`));
    } finally {
      store.close();
    }
  });
});
