import { z } from "zod";

/**
 * Output collection policy for a declarative map/fan-out step.
 *
 * The policy is intentionally descriptive.  The durable executor owns the
 * concrete reduction semantics; keeping this contract data-only lets a
 * conductor author a strategy without smuggling a callback into a workflow
 * revision.
 */
export const WorkflowFanoutAggregationSchema = z
  .object({
    mode: z.enum(["array", "object", "merge"]),
    /** Optional item key path used by object-style aggregation. */
    keyPath: z.string().min(1).max(1_000).optional(),
  })
  .strict();
export type WorkflowFanoutAggregation = z.infer<typeof WorkflowFanoutAggregationSchema>;
