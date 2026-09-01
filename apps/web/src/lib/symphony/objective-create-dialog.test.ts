import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("objective create dialog admission controls", () => {
  it("wires durable policy controls instead of claiming budgets are unavailable", () => {
    const source = readFileSync(fileURLToPath(new URL("../../components/symphony/objective-create-dialog.tsx", import.meta.url)), "utf8");

    expect(source).toContain("Admission policy");
    expect(source).toContain("Cost ceiling (USD)");
    expect(source).toContain("Concurrent-agent ceiling");
    expect(source).toContain("Allowed capabilities");
    expect(source).toContain("Objective expiry");
    expect(source).not.toContain("not yet part of the Objective Runtime contract");
  });
});
