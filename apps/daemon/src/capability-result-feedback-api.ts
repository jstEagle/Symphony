import {
  CapabilityResultDecisionRecordSchema,
  CapabilityResultEvaluationRecordSchema,
  CapabilityResultFeedbackRecordSchema,
  isCapabilityResultFeedbackHashValid,
  type CapabilityResultDecisionRecord,
  type CapabilityResultEvaluationRecord,
  type CapabilityResultFeedbackRecord,
} from "@symphony/protocol";
import {
  CapabilityResultFeedbackRepository,
  type CapabilityResultFeedbackListOptions,
} from "@symphony/storage";
import { z } from "zod";

export type CapabilityResultFeedbackApiResponse = Readonly<{
  status: number;
  body: unknown;
}>;

export type CapabilityResultFeedbackApiRequest = Readonly<{
  method: string;
  path: string;
  query?: Readonly<Record<string, string | undefined>>;
  body?: unknown;
}>;

export type CapabilityResultFeedbackSnapshot = Readonly<{
  objectiveId: string;
  feedback: CapabilityResultFeedbackRecord[];
  evaluations: CapabilityResultEvaluationRecord[];
  decisions: CapabilityResultDecisionRecord[];
}>;

const IdSchema = z.string().min(1).max(256);
const RequestKeySchema = z.string().min(8).max(512);
const FeedbackListQuerySchema = z.object({
  objectiveId: IdSchema.optional(),
  runId: IdSchema.optional(),
  nodeId: IdSchema.optional(),
  attemptId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(2_000).default(200),
}).strict();

/**
 * Daemon-owned authority for immutable capability-result feedback.
 *
 * The adapter accepts only already-produced, content-addressed records. It
 * never interprets capability definitions or executes workflow JSON. Request
 * idempotency is bound by the daemon HTTP boundary, while direct callers must
 * provide the record's key explicitly.
 */
export class CapabilityResultFeedbackApiAdapter {
  readonly repository: CapabilityResultFeedbackRepository;

  constructor(dataPath: string) {
    this.repository = new CapabilityResultFeedbackRepository(dataPath);
  }

  close(): void {
    if (this.repository.database.isOpen) this.repository.close();
  }

  validateFeedback(input: unknown): CapabilityResultFeedbackApiResponse {
    try {
      const record = CapabilityResultFeedbackRecordSchema.parse(input);
      return isCapabilityResultFeedbackHashValid(record)
        ? ok(record)
        : errorResponse(422, `Invalid capability feedback hash: ${record.id}`);
    } catch (error) {
      return failure(error);
    }
  }

  validate(input: unknown): CapabilityResultFeedbackApiResponse {
    return this.validateFeedback(input);
  }

  submitFeedback(input: unknown): CapabilityResultFeedbackApiResponse {
    try {
      const record = CapabilityResultFeedbackRecordSchema.parse(input);
      if (!isCapabilityResultFeedbackHashValid(record)) {
        return errorResponse(422, `Invalid capability feedback hash: ${record.id}`);
      }
      const existing = this.repository.getByIdempotencyKey("feedback", record.idempotencyKey);
      if (existing) {
        return sameRecord(existing, record)
          ? committedResponse("replayed", existing as CapabilityResultFeedbackRecord)
          : conflictResponse(`Capability feedback idempotency key is already bound to a different record: ${record.idempotencyKey}`);
      }
      const existingById = this.repository.getFeedback(record.id);
      if (existingById) {
        return sameRecord(existingById, record)
          ? committedResponse("replayed", existingById)
          : conflictResponse(`Capability feedback id is already bound to a different record: ${record.id}`);
      }
      const committed = this.repository.durableTransaction(() => this.repository.saveFeedback(record));
      if (!committed) {
        const replay = this.repository.getByIdempotencyKey("feedback", record.idempotencyKey);
        if (replay && sameRecord(replay, record)) return committedResponse("replayed", replay as CapabilityResultFeedbackRecord);
        return conflictResponse(`Capability feedback idempotency key is already bound to a different record: ${record.idempotencyKey}`);
      }
      return committedResponse("committed", record);
    } catch (error) {
      return failure(error);
    }
  }

  /** Alias used by callers that model the operation as a generic submit. */
  submit(input: unknown): CapabilityResultFeedbackApiResponse {
    return this.submitFeedback(input);
  }

  getFeedback(id: string): CapabilityResultFeedbackApiResponse {
    try {
      const record = IdSchema.parse(id);
      const feedback = this.repository.getFeedback(record);
      return feedback ? ok(feedback) : errorResponse(404, `Capability feedback not found: ${record}`);
    } catch (error) {
      return failure(error);
    }
  }

  getEvaluation(id: string): CapabilityResultFeedbackApiResponse {
    try {
      const record = IdSchema.parse(id);
      const evaluation = this.repository.getEvaluation(record);
      return evaluation ? ok(evaluation) : errorResponse(404, `Capability evaluation not found: ${record}`);
    } catch (error) {
      return failure(error);
    }
  }

  getDecision(id: string): CapabilityResultFeedbackApiResponse {
    try {
      const record = IdSchema.parse(id);
      const decision = this.repository.getDecision(record);
      return decision ? ok(decision) : errorResponse(404, `Capability decision not found: ${record}`);
    } catch (error) {
      return failure(error);
    }
  }

  objectiveSnapshot(objectiveId: string, options: Omit<CapabilityResultFeedbackListOptions, "objectiveId"> = {}): CapabilityResultFeedbackSnapshot {
    const id = IdSchema.parse(objectiveId);
    const filter = { ...options, objectiveId: id };
    return {
      objectiveId: id,
      feedback: this.repository.listFeedback(filter),
      evaluations: this.repository.listEvaluations(filter),
      decisions: this.repository.listDecisions(filter),
    };
  }

  getObjectiveSnapshot(objectiveId: string, options: Omit<CapabilityResultFeedbackListOptions, "objectiveId"> = {}): CapabilityResultFeedbackSnapshot {
    return this.objectiveSnapshot(objectiveId, options);
  }

  /**
   * Transport-neutral routes for direct daemon/SDK consumers. HTTP auth and
   * the header-to-key binding remain in apps/daemon/src/index.ts.
   */
  async handle(request: CapabilityResultFeedbackApiRequest): Promise<CapabilityResultFeedbackApiResponse> {
    try {
      const method = request.method.toUpperCase();
      const url = new URL(request.path, "http://feedback-api.invalid");
      const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      const baseIndex = segments[0] === "v1" && segments[1] === "capability-result-feedback"
        ? 2
        : segments[0] === "capability-result-feedback" ? 1 : -1;
      if (baseIndex < 0) return errorResponse(404, "Capability-result feedback API route not found");
      const route = segments.slice(baseIndex);
      if (method === "POST" && route.length === 0) return this.submitFeedback(request.body);
      if (method === "GET" && route.length === 0) {
        const query = FeedbackListQuerySchema.parse({
          ...(request.query ?? {}),
          ...(url.searchParams.has("objectiveId") ? { objectiveId: url.searchParams.get("objectiveId") } : {}),
          ...(url.searchParams.has("runId") ? { runId: url.searchParams.get("runId") } : {}),
          ...(url.searchParams.has("nodeId") ? { nodeId: url.searchParams.get("nodeId") } : {}),
          ...(url.searchParams.has("attemptId") ? { attemptId: url.searchParams.get("attemptId") } : {}),
          ...(url.searchParams.has("limit") ? { limit: url.searchParams.get("limit") } : {}),
        });
        const options: CapabilityResultFeedbackListOptions = {
          limit: query.limit,
          ...(query.objectiveId === undefined ? {} : { objectiveId: query.objectiveId }),
          ...(query.runId === undefined ? {} : { runId: query.runId }),
          ...(query.nodeId === undefined ? {} : { nodeId: query.nodeId }),
          ...(query.attemptId === undefined ? {} : { attemptId: query.attemptId }),
        };
        return ok({
          feedback: this.repository.listFeedback(options),
          evaluations: this.repository.listEvaluations(options),
          decisions: this.repository.listDecisions(options),
        });
      }
      if (route.length !== 2 || method !== "GET") return errorResponse(404, "Capability-result feedback API route not found");
      const id = IdSchema.parse(route[1]);
      if (route[0] === "feedback") return this.getFeedback(id);
      if (route[0] === "evaluations" || route[0] === "evaluation") return this.getEvaluation(id);
      if (route[0] === "decisions" || route[0] === "decision") return this.getDecision(id);
      return errorResponse(404, "Capability-result feedback API route not found");
    } catch (error) {
      return failure(error);
    }
  }
}

export const CapabilityResultFeedbackApi = CapabilityResultFeedbackApiAdapter;

function ok(body: unknown): CapabilityResultFeedbackApiResponse {
  return { status: 200, body };
}

function errorResponse(status: number, error: string): CapabilityResultFeedbackApiResponse {
  return { status, body: { error } };
}

function committedResponse(status: "committed" | "replayed", feedback: CapabilityResultFeedbackRecord): CapabilityResultFeedbackApiResponse {
  return {
    status: status === "committed" ? 201 : 200,
    body: { status, replayed: status === "replayed", feedback },
  };
}

function conflictResponse(error: string): CapabilityResultFeedbackApiResponse {
  return { status: 409, body: { status: "conflict", replayed: false, feedback: null, error } };
}

function sameRecord(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function failure(error: unknown): CapabilityResultFeedbackApiResponse {
  if (error instanceof z.ZodError) return errorResponse(400, error.issues.map((issue) => issue.message).join("; "));
  if (error instanceof Error && /idempotency conflict|already bound/u.test(error.message)) return conflictResponse(error.message);
  if (error instanceof Error) return errorResponse(400, error.message);
  return errorResponse(400, String(error));
}
