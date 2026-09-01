import { describe, expect, it } from "vitest";
import {
  ObjectiveValueCharterSchema,
  ObjectiveValueCharterMutationCitationSchema,
  objectiveValueCharterBinding,
  objectiveValueCharterHash,
  normalizeObjectiveValueCharter,
} from "./objective-values.js";

const charter = {
  version: 1 as const,
  revision: 3,
  values: [
    { id: "correctness", label: "Correctness", priority: 1, description: "Preserve factual behavior." },
    { id: "clarity", label: "Clarity", priority: 2 },
  ],
  tradeoffs: [{ id: "correctness-over-speed", higherPriorityValueId: "correctness", lowerPriorityValueId: "clarity", guidance: "Prefer a slower verified result when the values conflict." }],
  antiGoals: [{ id: "invented-evidence", statement: "Do not present unsupported claims as facts." }],
  hardConstraints: [{ id: "no-secrets", statement: "Never expose credentials or private tokens." }],
  evidenceExpectations: [{ id: "traceable", statement: "Cite durable evidence for material conclusions.", required: true, sourceKinds: ["event", "artifact"], minimumSources: 1 }],
};

describe("objective value charter protocol", () => {
  it("parses bounded declarative values and derives a stable content hash", () => {
    const parsed = ObjectiveValueCharterSchema.parse(charter);
    const reordered = ObjectiveValueCharterSchema.parse({
      ...charter,
      values: [...charter.values].reverse(),
    });
    expect(objectiveValueCharterHash(parsed)).not.toBe(objectiveValueCharterHash(reordered));
    expect(objectiveValueCharterBinding(parsed)).toEqual({ revision: 3, hash: objectiveValueCharterHash(parsed) });
    expect(normalizeObjectiveValueCharter(parsed).hash).toBe(objectiveValueCharterHash(parsed));
  });

  it("rejects references outside the declared charter", () => {
    expect(() => ObjectiveValueCharterSchema.parse({
      ...charter,
      tradeoffs: [{ ...charter.tradeoffs[0], lowerPriorityValueId: "missing" }],
    })).toThrow(/unknown value/iu);
  });

  it("requires a typed citation when a mutation is charter-aware", () => {
    expect(() => ObjectiveValueCharterMutationCitationSchema.parse({})).toThrow(/affected value or tradeoff/iu);
    expect(ObjectiveValueCharterMutationCitationSchema.parse({ valueIds: ["correctness"], tradeoffIds: [] })).toEqual({ valueIds: ["correctness"], tradeoffIds: [] });
  });
});
