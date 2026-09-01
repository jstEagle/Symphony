import { describe, expect, it } from "vitest";
import type { DriverEvent } from "@symphony/protocol";
import { AcpDriver } from "./acp.js";

function active(consume: (event: DriverEvent) => void) {
  return {
    emit: consume,
    sessionId: "acp-session",
    output: { text: "" },
    failure: Promise.resolve(new Error("unused")),
    closed: false,
    runSequence: 1,
    activeRun: 1,
    updateSequence: 0,
    processLeaseId: null,
    processSupervisor: undefined,
    processReleased: false,
  };
}

describe("ACP native event identity", () => {
  it("keeps ordered identical chunks distinct while replaying a provider sequence exactly once", () => {
    const driver = new AcpDriver([]);
    const events: DriverEvent[] = [];
    const state = active((event) => events.push(event));
    const onUpdate = (driver as unknown as { onUpdate(update: unknown, active: unknown): void }).onUpdate.bind(driver);
    const chunk = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "same" } };
    onUpdate(chunk, state);
    onUpdate(chunk, state);
    const sequenced = { ...chunk, sequence: 7 };
    onUpdate(sequenced, state);
    onUpdate(sequenced, state);

    const chunks = events.filter((event) => event.kind === "message.delta");
    expect(chunks).toHaveLength(4);
    expect(chunks[0]?.nativeEventId).not.toBe(chunks[1]?.nativeEventId);
    expect(chunks[2]?.nativeEventId).toBe(chunks[3]?.nativeEventId);
  });
});
