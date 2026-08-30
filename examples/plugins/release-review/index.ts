type PluginApi = {
  registerTool(tool: {
    name: string;
    label?: string;
    description: string;
    parameters?: unknown;
    outputSchema?: unknown;
    execute: (...args: unknown[]) => unknown | Promise<unknown>;
  }): void;
  on(event: string, handler: (...args: unknown[]) => unknown | Promise<unknown>): void;
};

export default function releaseReviewPlugin(api: PluginApi): void {
  api.registerTool({
    name: "release_checklist",
    label: "Release checklist",
    description: "Return the repository's small, deterministic release checklist.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        checks: { type: "array", items: { type: "string" } },
      },
      required: ["checks"],
      additionalProperties: false,
    },
    execute: () => ({
      checks: [
        "Run the repository's verification command.",
        "Review the intended diff and exclude unrelated files.",
        "Confirm credentials and generated runtime state are absent.",
      ],
    }),
  });
}
