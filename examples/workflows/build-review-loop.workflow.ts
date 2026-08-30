import { agent, defineWorkflow, whileLoop } from "@symphony/sdk";

export default defineWorkflow({
  id: "build-review-loop",
  name: "Build and independently review",
  mission: {
    statement: "Ship the requested feature as a coherent and reliable part of the product.",
    keyResults: [
      "The requested behavior is implemented and verified.",
      "Independent review scores the result at least 8/10.",
    ],
  },
  workspace: {
    path: process.cwd(),
    dirtyPolicy: "local-only",
  },
  inputSchema: {
    type: "object",
    properties: {
      request: { type: "string" },
    },
    required: ["request"],
    additionalProperties: false,
  },
  output: "steps.review",
  steps: [
    whileLoop(
      "quality",
      { path: "steps.review.score", op: "lt", value: 8, default: 0 },
      [
        agent({
          id: "build",
          objective: "Implement or improve {{input.request}}, run proportionate checks, and report what changed.",
          routing: {
            taskKind: "coding",
            prioritize: ["intelligence", "coding-success"],
          },
          outputSchema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              checks: { type: "array", items: { type: "string" } },
            },
            required: ["summary", "checks"],
            additionalProperties: false,
          },
        }),
        agent({
          id: "review",
          objective: "Independently review the current implementation of {{input.request}} against the workflow mission and return a strict score.",
          permissions: "read-only",
          routing: {
            taskKind: "coding",
            prioritize: ["intelligence", "agentic-success"],
          },
          outputSchema: {
            type: "object",
            properties: {
              score: { type: "number", minimum: 0, maximum: 10 },
              feedback: { type: "array", items: { type: "string" } },
            },
            required: ["score", "feedback"],
            additionalProperties: false,
          },
        }),
      ],
      5,
    ),
  ],
});
