import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { capabilities, emit, makeSession } from "../../packages/drivers/src/common.js";
import type {
  DriverDoctorResult,
  DriverEvent,
  DriverMessageRequest,
  DriverSession,
  DriverStartRequest,
  ModelDescriptor,
  WorkerDriver,
} from "../../packages/protocol/src/index.js";

/**
 * A process-boundary queue fixture. Its native session is represented by the
 * daemon's durable session record; the important boundary is that steering is
 * disabled, so AgentCoordinator persists a follow-up in SQLite before it can
 * be drained after a replacement daemon starts.
 */
export class ProcessCrashQueueDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities({ steer: false });
  private readonly consumers = new Map<string, (event: DriverEvent) => void>();

  constructor(private readonly root: string) {}

  async doctor(): Promise<DriverDoctorResult> {
    return {
      driver: this.id,
      available: true,
      authenticated: true,
      version: "process-crash-queue-fixture",
      capabilities: this.capabilities,
      detail: "Deterministic queue fixture for child-daemon recovery acceptance.",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{
      id: "fixture",
      harness: this.id,
      name: "Process crash queue fixture",
      description: "No external provider is contacted.",
      modalities: ["text"],
      structuredOutput: true,
      pricing: {},
      metadata: {},
    }];
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.consumers.set(request.agentId, onEvent);
    appendFileSync(join(this.root, ".process-crash-queue-starts"), `${request.agentId}\n`);
    emit(onEvent, "run.started", { agentId: request.agentId }, `queue-start:${request.agentId}`);
    return makeSession(this.id, `queue-native-${request.agentId}`, { agentId: request.agentId }, `queue-run-${request.agentId}`);
  }

  async resume(session: DriverSession, request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.consumers.set(request.agentId, onEvent);
    appendFileSync(join(this.root, ".process-crash-queue-resumes"), `${request.agentId}\n`);
    return { ...session, state: "idle", metadata: { ...session.metadata, agentId: request.agentId } };
  }

  async sendMessage(session: DriverSession, content: string, request?: DriverMessageRequest): Promise<{ receiptId: string; queued: boolean }> {
    const agentId = typeof session.metadata.agentId === "string" ? session.metadata.agentId : session.nativeSessionId.replace(/^queue-native-/u, "");
    appendFileSync(join(this.root, ".process-crash-queue-followups"), `${JSON.stringify({ agentId, content, requestId: request?.requestId ?? null })}\n`);
    const consumer = this.consumers.get(agentId);
    if (!consumer) throw new Error(`No queue fixture consumer for ${agentId}`);
    emit(consumer, "output.completed", { structuredOutput: { completed: true, content } }, `queue-output:${agentId}:${request?.attemptId ?? "legacy"}`);
    emit(consumer, "run.completed", { status: "completed", nativeTurnId: `queue-turn:${agentId}` }, `queue-complete:${agentId}:${request?.attemptId ?? "legacy"}`);
    return { receiptId: request?.requestId ?? `queue-receipt:${agentId}`, queued: true };
  }

  async cancel(session: DriverSession): Promise<void> {
    const agentId = typeof session.metadata.agentId === "string" ? session.metadata.agentId : session.nativeSessionId.replace(/^queue-native-/u, "");
    const consumer = this.consumers.get(agentId);
    if (consumer) emit(consumer, "run.cancelled", { status: "cancelled" }, `queue-cancel:${agentId}`);
  }
}
