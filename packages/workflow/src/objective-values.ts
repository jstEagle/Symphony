import {
  ObjectiveControlMutationSchema,
  ObjectiveControlPlanSchema,
  ObjectiveSpecSchema,
  ObjectiveValueCharterSchema,
  objectiveValueCharterBinding,
  normalizeObjectiveValueCharter,
  type ObjectiveControlMutation,
  type ObjectiveControlPlan,
  type ObjectiveSpec,
  type ObjectiveValueCharter,
  type ObjectiveValueCharterInput,
  type ObjectiveValueCharterBinding,
} from "@symphony/protocol";

// Keep the normalization helper available to workflow-side consumers that
// validate persisted objective specs during daemon recovery.
export { normalizeObjectiveValueCharter };

/**
 * Workflow-side value helpers keep charter policy in the pure objective
 * kernel. They do not select agent roles or impose a workflow topology.
 */

export function normalizeObjectiveSpecValueCharter(spec: ObjectiveSpec): ObjectiveSpec {
  const parsed = ObjectiveSpecSchema.parse(spec);
  if (!parsed.valueCharter) return parsed;
  return ObjectiveSpecSchema.parse({
    ...parsed,
    valueCharter: normalizeObjectiveValueCharter(parsed.valueCharter),
  });
}

export function objectiveValueCharterBindingForSpec(spec: ObjectiveSpec): ObjectiveValueCharterBinding | null {
  const parsed = ObjectiveSpecSchema.parse(spec);
  return parsed.valueCharter ? objectiveValueCharterBinding(parsed.valueCharter) : null;
}

/**
 * Attach the immutable charter identity to a control plan. Existing bindings
 * are checked before they can be reused, so a strategy cannot silently drift
 * from its objective values charter.
 */
export function bindObjectiveValueCharterToPlan(
  plan: ObjectiveControlPlan,
  charter: ObjectiveValueCharter | ObjectiveValueCharterInput | null | undefined,
): ObjectiveControlPlan {
  const parsedPlan = ObjectiveControlPlanSchema.parse(plan);
  const binding = charter ? objectiveValueCharterBinding(charter) : null;
  assertPlanBindingMatches(parsedPlan, binding);
  if (!binding) return parsedPlan;
  return ObjectiveControlPlanSchema.parse({
    ...parsedPlan,
    valueCharterRevision: binding.revision,
    valueCharterHash: binding.hash,
  });
}

/** Add the objective binding to a mutation before storage derives a revision. */
export function bindObjectiveValueCharterToMutation(
  mutation: ObjectiveControlMutation,
  charter: ObjectiveValueCharter | ObjectiveValueCharterInput | null | undefined,
): ObjectiveControlMutation {
  const parsedMutation = ObjectiveControlMutationSchema.parse(mutation);
  const binding = charter ? objectiveValueCharterBinding(charter) : null;
  if (parsedMutation.valueCharterRevision !== undefined && parsedMutation.valueCharterRevision !== binding?.revision) {
    throw new Error("Objective strategy mutation charter revision does not match the admitted charter");
  }
  if (parsedMutation.valueCharterHash !== undefined && parsedMutation.valueCharterHash !== binding?.hash) {
    throw new Error("Objective strategy mutation charter hash does not match the admitted charter");
  }
  if (!binding) return parsedMutation;
  assertObjectiveValueCharterMutationReason(charter!, parsedMutation);
  return ObjectiveControlMutationSchema.parse({
    ...parsedMutation,
    valueCharterRevision: binding.revision,
    valueCharterHash: binding.hash,
  });
}

/**
 * A charter changes the standard for a strategy mutation. Requiring typed
 * citations lets a conductor explain the affected values/tradeoffs without
 * turning the reason into executable policy.
 */
export function objectiveValueCharterMutationReasonIssues(
  charter: ObjectiveValueCharter | ObjectiveValueCharterInput,
  mutation: Pick<ObjectiveControlMutation, "charterCitations" | "reason">,
): string[] {
  const parsedCharter = ObjectiveValueCharterSchema.parse(charter);
  const citations = mutation.charterCitations;
  if (!citations || (citations.valueIds.length === 0 && citations.tradeoffIds.length === 0)) {
    return ["Objective strategy mutation reasons must cite at least one affected charter value or tradeoff."];
  }
  const valueIds = new Set(parsedCharter.values.map((value) => value.id));
  const tradeoffIds = new Set(parsedCharter.tradeoffs.map((tradeoff) => tradeoff.id));
  const issues: string[] = [];
  for (const id of citations.valueIds) if (!valueIds.has(id)) issues.push(`Strategy mutation cites unknown charter value ${id}.`);
  for (const id of citations.tradeoffIds) if (!tradeoffIds.has(id)) issues.push(`Strategy mutation cites unknown charter tradeoff ${id}.`);
  if (mutation.reason.trim().length === 0) issues.push("Objective strategy mutation reason cannot be empty when a charter exists.");
  return issues;
}

export function assertObjectiveValueCharterMutationReason(
  charter: ObjectiveValueCharter | ObjectiveValueCharterInput,
  mutation: Pick<ObjectiveControlMutation, "charterCitations" | "reason">,
): void {
  const issues = objectiveValueCharterMutationReasonIssues(charter, mutation);
  if (issues.length > 0) throw new Error(issues.join(" "));
}

function assertPlanBindingMatches(
  plan: ObjectiveControlPlan,
  binding: ObjectiveValueCharterBinding | null,
): void {
  if (plan.valueCharterRevision !== undefined && plan.valueCharterRevision !== binding?.revision) {
    throw new Error("Objective strategy charter revision does not match the admitted charter");
  }
  if (plan.valueCharterHash !== undefined && plan.valueCharterHash !== binding?.hash) {
    throw new Error("Objective strategy charter hash does not match the admitted charter");
  }
}
