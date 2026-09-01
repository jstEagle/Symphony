import { describe, expect, it } from "vitest";
import { readAgentId } from "../apps/web/src/components/symphony/agent-tool.js";

describe("agent tool projection", () => {
  it("resolves an agent id when a native adapter serializes arguments", () => {
    expect(readAgentId(
      '{"objective":"Inspect the daemon","agentId":"agent-123"}',
      undefined,
    )).toBe("agent-123");
  });

  it("prefers the structured result over serialized arguments", () => {
    expect(readAgentId(
      '{"agentId":"agent-old"}',
      '{"agentId":"agent-new"}',
    )).toBe("agent-new");
  });

  it("ignores malformed and unrelated payloads", () => {
    expect(readAgentId("not-json", '{"path":"/tmp/file"}')).toBeUndefined();
  });
});
