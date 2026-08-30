import { describe, expect, it } from "vitest";
import { strictCodexOutputSchema } from "../packages/drivers/src/codex.js";
import { AcpDriver, ClaudeDriver, CodexDriver, CursorDriver, OpenCodeDriver, PiDriver } from "../packages/drivers/src/index.js";
import {
  buildAgentPrompt,
  buildConductorTurnPrompt,
  buildSymphonyOperatingContract,
  hasStructuredOutputSchema,
} from "../packages/drivers/src/prompt.js";
import { AgentWorkOrderSchema } from "../packages/protocol/src/index.js";
import { normalizeGeneratedChatTitle } from "../packages/runtime/src/index.js";
import { cursorStatusIsAuthenticated, normalizeCursorFailurePayload } from "../packages/drivers/src/cursor.js";
import { compareCliVersions, extractCliVersion } from "../apps/daemon/src/harness-maintenance.js";

describe("native driver compatibility", () => {
  it("advertises ordered in-flight steering for the durable Claude query", () => {
    const driver = new ClaudeDriver({
      enabled: true,
      process: { command: "claude", args: [] },
    });
    expect(driver.capabilities.steer).toBe(true);
  });

  it.each([
    ["Codex", CodexDriver],
    ["Claude", ClaudeDriver],
    ["Cursor", CursorDriver],
    ["OpenCode", OpenCodeDriver],
    ["Pi", PiDriver],
    ["ACP", AcpDriver],
  ] as const)("exposes per-session force termination for %s", (_name, Driver) => {
    expect(typeof Driver.prototype.forceTerminate).toBe("function");
  });

  it("normalizes JSON Schema to the Codex strict structured-output subset", () => {
    expect(strictCodexOutputSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        summary: { type: "string", default: "" },
        detail: {
          type: "object",
          properties: {
            confirmed: { type: "boolean" },
            notes: { type: "string" },
          },
          required: ["confirmed"],
        },
      },
      required: ["summary"],
    })).toEqual({
      type: "object",
      properties: {
        summary: { type: "string" },
        detail: {
          type: "object",
          properties: {
            confirmed: { type: "boolean" },
            notes: { type: "string" },
          },
          required: ["confirmed", "notes"],
          additionalProperties: false,
        },
      },
      required: ["summary", "detail"],
      additionalProperties: false,
    });
  });

  it("tells conductors when Symphony delegation should outrank native subagents", () => {
    const order = AgentWorkOrderSchema.parse({
      workflowId: "chat:thread",
      runId: "chat-run:thread",
      depth: 0,
      mission: { id: "chat:thread", revision: 1, hash: "12345678", statement: "Ship the requested change." },
      objective: "Coordinate the work.",
      outputSchema: { type: "object" },
      workspace: { path: "/tmp" },
      metadata: { threadId: "thread" },
    });
    const contract = buildSymphonyOperatingContract(order, { agentId: "agent-1", canCreate: true });
    expect(contract).toContain("user-facing conductor");
    expect(contract).toContain("Use Symphony create_agent for durable or cross-harness delegation");
    expect(contract).toContain("Native harness subagents remain available for short-lived");
    expect(contract).toContain("mcp__symphony__create_agent");
    expect(buildConductorTurnPrompt("Spawn a reviewer")).toContain("use Symphony create_agent when exposed");
  });

  it("treats an empty worker output schema as an unstructured response contract", () => {
    const order = AgentWorkOrderSchema.parse({
      workflowId: "workflow",
      runId: "run",
      depth: 1,
      mission: { id: "mission", revision: 1, hash: "12345678", statement: "Return a useful result." },
      objective: "Inspect one file.",
      outputSchema: {},
      workspace: { path: "/tmp" },
    });
    expect(hasStructuredOutputSchema(order)).toBe(false);
    expect(buildAgentPrompt(order)).toContain("No structured output schema was requested");
    expect(buildAgentPrompt(order)).not.toContain("Your final response must satisfy the output schema");
  });

  it("normalizes model-generated sidebar titles", () => {
    expect(normalizeGeneratedChatTitle('  "Review Symphony orchestration."  ')).toBe("Review Symphony orchestration");
    expect(normalizeGeneratedChatTitle("one two three four five six seven eight nine ten")).toBe("one two three four five six seven eight");
    expect(normalizeGeneratedChatTitle("   ")).toBeNull();
  });

  it("recognizes native Cursor login output without trusting negative status text", () => {
    expect(cursorStatusIsAuthenticated("✓ Logged in as person@example.com")).toBe(true);
    expect(cursorStatusIsAuthenticated("Authenticated with Cursor")).toBe(true);
    expect(cursorStatusIsAuthenticated("Not logged in. Run cursor-agent login.")).toBe(false);
    expect(cursorStatusIsAuthenticated(null)).toBe(false);
  });

  it("normalizes Cursor SDK credential failures into an actionable runtime error", () => {
    expect(normalizeCursorFailurePayload({ status: "ERROR", message: "[unknown] Invalid User API Key" })).toEqual({
      code: "cursor-sdk-unauthenticated",
      error: "Cursor SDK authentication failed. Authenticate the Cursor SDK in Symphony Settings or configure cursor.apiKey; cursor-agent CLI login is separate.",
    });
  });

  it("normalizes and compares native CLI versions", () => {
    expect(extractCliVersion("cursor-agent 2026.08.25-3e8eec8\nready")).toBe("2026.08.25-3e8eec8");
    expect(compareCliVersions("1.18.25", "1.18.21")).toBeGreaterThan(0);
    expect(compareCliVersions("2.1.4", "2.1.4")).toBe(0);
    expect(compareCliVersions("2.1.4", "2.1.4-beta.1")).toBeGreaterThan(0);
  });
});
