import { describe, expect, it } from "vitest";
import { summarizeUsage } from "../apps/daemon/src/index.js";
import { UsageEventSchema, type UsageEvent } from "../packages/protocol/src/index.js";

function usage(id: string, costAmount: number | null, currency = "USD"): UsageEvent {
  return UsageEventSchema.parse({
    id,
    workflowId: "workflow-usage",
    runId: "run-usage",
    agentId: null,
    model: "fixture",
    harness: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    costAmount,
    currency,
    basis: "provider-reported",
    priceSnapshotId: null,
    recordedAt: "2026-09-01T00:00:00.000Z",
  });
}

describe("daemon usage projection", () => {
  it("only adds USD costs to the total labelled USD", () => {
    expect(summarizeUsage([
      usage("usd", 1.25),
      usage("eur", 20, "EUR"),
      usage("jpy", 900, "JPY"),
      usage("unknown", null),
    ])).toEqual({
      currency: "USD",
      knownTotal: 1.25,
      unknownEvents: 3,
      eventCount: 4,
      byBasis: { "provider-reported": 1.25 },
    });
  });

  it("normalizes USD currency casing without accepting other currencies", () => {
    expect(summarizeUsage([
      usage("usd-lower", 0.5, "usd"),
      usage("eur-spaced", 5, " EUR "),
    ])).toMatchObject({
      currency: "USD",
      knownTotal: 0.5,
      unknownEvents: 1,
      eventCount: 2,
    });
  });
});
