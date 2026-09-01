import { describe, expect, it } from "vitest";
import {
  buildSessionDiagnosticBundle,
  classifySessionDiagnosticRuntime,
  isSessionDiagnosticTerminal,
  sessionDiagnosticHumanText,
  sessionDiagnosticJson,
  verifySessionDiagnosticContentHash,
} from "./session-diagnostics.js";

const provenance = {
  source: "test",
  generatedAt: "2026-09-01T00:00:00.000Z",
  generatorVersion: "test-1",
};

describe("session diagnostics", () => {
  it("treats idle and waiting projections with retained sessions as reusable, live agents", () => {
    for (const status of ["idle", "waiting"] as const) {
      expect(classifySessionDiagnosticRuntime({ status, hasReusableSession: true })).toEqual({
        termination: "running",
        liveness: "alive",
        recovery: "eligible",
        reason: "The runtime retains a reusable native session for this idle/waiting agent.",
      });
    }
  });

  it("does not turn a reusable projection with a clean lease retirement into a terminal/dead diagnostic", () => {
    const result = classifySessionDiagnosticRuntime({
      status: "waiting",
      hasReusableSession: false,
      nativeSessionId: "native-waiting",
      leaseNativeSessionId: "native-waiting",
      leaseState: "exited",
      leaseError: null,
    });
    expect(result.termination).toBe("unknown");
    expect(result.liveness).toBe("unknown");
  });

  it("keeps true terminal projections terminal while reporting retained completion sessions", () => {
    expect(classifySessionDiagnosticRuntime({ status: "failed", hasReusableSession: false })).toMatchObject({
      termination: "terminal",
      liveness: "dead",
    });
    expect(classifySessionDiagnosticRuntime({ status: "completed", hasReusableSession: true })).toMatchObject({
      termination: "terminal",
      liveness: "alive",
      recovery: "eligible",
    });
  });

  it("redacts secrets from stderr, commands, and allowlisted environment metadata", () => {
    const bundle = buildSessionDiagnosticBundle({
      objectiveId: "objective-1",
      runId: "run-1",
      exits: [{ process: "native", code: 1, stderr: "Bearer super-secret API_KEY=abc123 sk-test-secret-value" }],
      commandReceipts: [{ id: "receipt-1", command: "curl https://example.test?token=top-secret", purpose: "check", status: "failed", stderr: "password=hunter2" }],
      environment: { NODE_ENV: "test", API_KEY: "do-not-export" },
      provenance,
    }, { environmentAllowlist: ["NODE_ENV"], redactionPatterns: [/super-secret/g] });

    const serialized = sessionDiagnosticJson(bundle);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("do-not-export");
    expect(bundle.environment).toEqual({ NODE_ENV: "test" });
    expect(verifySessionDiagnosticContentHash(bundle)).toBe(true);
  });

  it("marks bounded excerpts and the bundle when truncation occurs", () => {
    const bundle = buildSessionDiagnosticBundle({
      exits: [{ process: "native", code: 1, stderr: "x".repeat(1_000) }],
      verificationCommands: Array.from({ length: 20 }, (_, index) => ({ command: `check-${index}`, purpose: "verify" })),
      provenance,
    }, { maxExcerptBytes: 32, maxBytes: 1_500 });

    expect(bundle.truncated).toBe(true);
    expect(bundle.exits[0]?.stderrTruncated).toBe(true);
    expect(new TextEncoder().encode(sessionDiagnosticJson(bundle)).byteLength).toBeLessThanOrEqual(1_500);
  });

  it("serializes canonically regardless of input object key order", () => {
    const left = buildSessionDiagnosticBundle({
      objectiveId: "objective-1", runId: "run-1", harness: { version: "1", harness: "codex", model: "auto", available: true, auth: "ready" },
      environment: { ZED: "z", ALPHA: "a" }, provenance,
    }, { environmentAllowlist: ["ALPHA", "ZED"] });
    const right = buildSessionDiagnosticBundle({
      provenance, environment: { ALPHA: "a", ZED: "z" },
      harness: { auth: "ready", available: true, model: "auto", harness: "codex", version: "1" }, runId: "run-1", objectiveId: "objective-1",
    }, { environmentAllowlist: ["ZED", "ALPHA"] });
    expect(sessionDiagnosticJson(left)).toBe(sessionDiagnosticJson(right));
    expect(sessionDiagnosticHumanText(left)).toBe(sessionDiagnosticHumanText(right));
  });

  it("distinguishes terminal exits from unknown and running sessions", () => {
    const terminal = buildSessionDiagnosticBundle({ exits: [{ process: "native", code: 0 }], provenance });
    const unknown = buildSessionDiagnosticBundle({ exits: [{ process: "native" }], provenance });
    const running = buildSessionDiagnosticBundle({ exits: [{ process: "native", state: "running" }], liveness: { state: "alive", recovery: "ineligible" }, provenance });
    expect(terminal.termination).toBe("terminal");
    expect(unknown.termination).toBe("unknown");
    expect(running.termination).toBe("running");
    expect(isSessionDiagnosticTerminal(terminal)).toBe(true);
    expect(isSessionDiagnosticTerminal(unknown)).toBe(false);
  });
});
