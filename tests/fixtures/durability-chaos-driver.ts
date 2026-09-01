import { capabilities } from "../../packages/drivers/src/common.js";
import type {
  DriverDoctorResult,
  DriverEvent,
  DriverMessageRequest,
  DriverSession,
  DriverStartRequest,
  ModelDescriptor,
  WorkerDriver,
} from "../../packages/protocol/src/index.js";

export type ChaosNativeOutcome = "completed" | "failed" | "unknown";

/**
 * A deterministic native boundary for live acceptance tests.
 *
 * It deliberately keeps all control in the test: starts can be held open,
 * messages can be queued or made ambiguous, and terminal events are only
 * emitted when the test releases the exact native identity. This is a real
 * WorkerDriver behind startDaemon/HTTP/SQLite, not a mock of the daemon.
 */
export class DurabilityChaosDriver implements WorkerDriver {
  readonly id = "codex" as const;
  // Leave steering disabled so a message sent while a native turn is active
  // takes the durable queued-follow-up path. The matrix needs to prove that
  // queue survives a daemon generation boundary, not only a provider-side
  // steering receipt.
  readonly capabilities = capabilities({ steer: false });
  readonly startedAgentIds: string[] = [];
  readonly resumedAgentIds: string[] = [];
  readonly startOrders: DriverStartRequest[] = [];
  readonly messages: Array<{ agentId: string; content: string; requestId?: string }> = [];
  readonly cancelCalls: string[] = [];
  readonly consumers = new Map<string, (event: DriverEvent) => void>();
  readonly requests = new Map<string, DriverStartRequest>();
  readonly resumeStates = new Map<string, DriverSession["state"]>();
  hangNextStart = false;
  failNextMessage = false;
  queueNextMessage = false;

  async doctor(): Promise<DriverDoctorResult> {
    return {
      driver: this.id,
      available: true,
      authenticated: true,
      version: "durability-chaos-fixture",
      capabilities: this.capabilities,
      detail: "Deterministic in-process native boundary for live durability acceptance.",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{
      id: "fixture",
      harness: this.id,
      name: "Durability chaos fixture",
      description: "No external model or provider is contacted.",
      modalities: ["text"],
      structuredOutput: true,
      pricing: {},
      metadata: {},
    }];
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.startedAgentIds.push(request.agentId);
    this.startOrders.push(request);
    this.requests.set(request.agentId, request);
    this.consumers.set(request.agentId, onEvent);
    this.emit(request.agentId, "run.started", { agentId: request.agentId }, `start:${request.agentId}:${this.startedAgentIds.length}`);
    if (this.hangNextStart) {
      this.hangNextStart = false;
      return await new Promise<DriverSession>(() => undefined);
    }
    return this.session(request.agentId, "running");
  }

  async resume(session: DriverSession, request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const agentId = typeof session.metadata.agentId === "string" ? session.metadata.agentId : request.agentId;
    this.resumedAgentIds.push(agentId);
    this.requests.set(agentId, request);
    this.consumers.set(agentId, onEvent);
    return this.session(agentId, this.resumeStates.get(agentId) ?? "idle", session);
  }

  async sendMessage(session: DriverSession, content: string, request?: DriverMessageRequest): Promise<{ receiptId: string; queued: boolean }> {
    const agentId = typeof session.metadata.agentId === "string"
      ? session.metadata.agentId
      : session.nativeSessionId.replace(/^native-/u, "");
    this.messages.push({ agentId, content, ...(request?.requestId ? { requestId: request.requestId } : {}) });
    if (this.failNextMessage) {
      this.failNextMessage = false;
      throw new Error("deterministic transport failure after native acceptance became ambiguous");
    }
    const queued = this.queueNextMessage;
    this.queueNextMessage = false;
    return { receiptId: `native-message:${agentId}:${this.messages.length}`, queued };
  }

  async cancel(session: DriverSession): Promise<void> {
    const agentId = typeof session.metadata.agentId === "string"
      ? session.metadata.agentId
      : session.nativeSessionId.replace(/^native-/u, "");
    this.cancelCalls.push(agentId);
    this.emit(agentId, "run.cancelled", this.attemptPayload(agentId, { status: "cancelled" }), `cancel:${agentId}:${this.cancelCalls.length}`);
  }

  release(agentId: string, outcome: ChaosNativeOutcome): void {
    if (outcome === "unknown") {
      this.emit(agentId, "run.cancelled", this.attemptPayload(agentId, { status: "cancelled" }), `unknown:${agentId}`);
      return;
    }
    if (outcome === "failed") {
      this.emit(agentId, "run.failed", this.attemptPayload(agentId, { error: "deterministic fixture failure" }), `failed:${agentId}`);
      return;
    }
    this.emit(agentId, "usage.recorded", this.attemptPayload(agentId, {
      nativeTurnId: `turn:${agentId}`,
      usage: { input_tokens: 11, output_tokens: 5, cost: 0.002 },
      basis: "harness-reported",
    }), `usage:${agentId}`);
    this.emit(agentId, "output.completed", { structuredOutput: { completed: true } }, `output:${agentId}`);
    this.emit(agentId, "run.completed", this.attemptPayload(agentId, { status: "completed" }), `complete:${agentId}`);
  }

  complete(agentId: string): void {
    this.release(agentId, "completed");
  }

  private session(agentId: string, state: DriverSession["state"], previous?: DriverSession): DriverSession {
    return {
      driver: this.id,
      nativeSessionId: previous?.nativeSessionId ?? `native-${agentId}`,
      nativeRunId: previous?.nativeRunId ?? `native-run-${agentId}`,
      state,
      startedAt: previous?.startedAt ?? "2026-01-01T00:00:00.000Z",
      metadata: { ...(previous?.metadata ?? {}), agentId },
    };
  }

  private attemptPayload(agentId: string, payload: Record<string, unknown>): Record<string, unknown> {
    const metadata = this.requests.get(agentId)?.workOrder.metadata ?? {};
    return {
      ...payload,
      objectiveAttemptId: typeof metadata.objectiveAttemptId === "string" ? metadata.objectiveAttemptId : null,
      nativeTurnId: typeof payload.nativeTurnId === "string" ? payload.nativeTurnId : `turn:${agentId}`,
    };
  }

  private emit(agentId: string, kind: DriverEvent["kind"], payload: Record<string, unknown>, nativeEventId: string): void {
    const consumer = this.consumers.get(agentId);
    if (!consumer) throw new Error(`No deterministic fixture consumer for ${agentId}`);
    consumer({ kind, nativeEventId, occurredAt: "2026-01-01T00:00:00.000Z", payload: payload as DriverEvent["payload"] });
  }
}
