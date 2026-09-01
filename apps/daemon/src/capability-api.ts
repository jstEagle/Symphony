import {
  CapabilityCompatibilityTargetSchema,
  CapabilityDefinitionSchema,
  CapabilityIdSchema,
  CapabilityProvenanceSchema,
  CapabilityTriggerBindingSchema,
  CapabilityVersionSchema,
  JsonValueSchema,
  ObjectiveActorSchema,
  type CapabilityCompatibilityTarget,
  type CapabilityExecutionDefaults,
  type CapabilityVersionRecord,
  type ObjectiveActor,
} from "@symphony/protocol";
import {
  CapabilityLibraryRepository,
  type CapabilityLibraryReceipt,
} from "@symphony/storage";
import {
  CapabilityLibrary,
  type CapabilityLibraryCommandResult,
  type CapabilityExecutionResolution,
} from "@symphony/workflow";
import { z } from "zod";

/**
 * A small, transport-neutral response used by both HTTP and MCP callers.
 * `body` is deliberately `unknown`: HTTP and MCP can serialize the same
 * truthful result without making either transport a dependency of this file.
 */
export type CapabilityApiResponse = Readonly<{
  status: number;
  body: unknown;
}>;

export type CapabilityApiRequest = Readonly<{
  method: string;
  path: string;
  query?: Readonly<Record<string, string | undefined>>;
  body?: unknown;
}>;

export type CapabilityApiOptions = Readonly<{
  clock?: () => string;
}>;

const RequestKeySchema = z.string().min(1).max(512);
const CapabilityActorSchema = ObjectiveActorSchema;

const CapabilityCreateRequestSchema = z.object({
  capabilityId: CapabilityIdSchema,
  version: CapabilityVersionSchema.optional(),
  definition: z.unknown(),
  provenance: z.unknown(),
  actor: CapabilityActorSchema,
  requestKey: RequestKeySchema,
}).strict();

const CapabilityStateRequestSchema = z.object({
  capabilityId: CapabilityIdSchema,
  version: CapabilityVersionSchema,
  actor: CapabilityActorSchema,
  requestKey: RequestKeySchema,
  /** Optional concrete inputs are validated and persisted by the workflow layer. */
  parameters: JsonValueSchema.optional(),
  triggers: z.array(CapabilityTriggerBindingSchema).max(256).optional(),
  target: CapabilityCompatibilityTargetSchema.optional(),
}).strict();

const CapabilityPrepareRequestSchema = z.object({
  capabilityId: CapabilityIdSchema,
  version: CapabilityVersionSchema,
  parameters: JsonValueSchema,
  target: CapabilityCompatibilityTargetSchema.optional(),
}).strict();

const CapabilityRoutePrepareBodySchema = z.object({
  parameters: JsonValueSchema,
  target: CapabilityCompatibilityTargetSchema.optional(),
}).strict();

const CapabilityRouteMutationBodySchema = z.object({
  actor: CapabilityActorSchema,
  requestKey: RequestKeySchema,
  parameters: JsonValueSchema.optional(),
  triggers: z.array(CapabilityTriggerBindingSchema).max(256).optional(),
  target: CapabilityCompatibilityTargetSchema.optional(),
}).strict();

const CapabilityRouteCreateBodySchema = z.object({
  capabilityId: CapabilityIdSchema,
  version: CapabilityVersionSchema.optional(),
  definition: z.unknown(),
  provenance: z.unknown(),
  actor: CapabilityActorSchema,
  requestKey: RequestKeySchema,
}).strict();

type CapabilityCreateRequest = z.infer<typeof CapabilityCreateRequestSchema>;
type CapabilityStateRequest = z.infer<typeof CapabilityStateRequestSchema>;
type CapabilityPrepareRequest = z.infer<typeof CapabilityPrepareRequestSchema>;

/**
 * Daemon-neutral capability registry boundary.
 *
 * One adapter owns one repository. This makes its lifecycle explicit for a
 * daemon (construct at startup, close during shutdown), while also allowing
 * MCP/HTTP callers to share exactly the same durable command semantics.
 */
export class CapabilityApiAdapter {
  readonly repository: CapabilityLibraryRepository;
  readonly library: CapabilityLibrary;

  constructor(dataPath: string, options: CapabilityApiOptions = {}) {
    this.repository = new CapabilityLibraryRepository(dataPath);
    this.library = new CapabilityLibrary(this.repository, options.clock);
  }

  /** Close the owned SQLite handle. Calling close more than once is safe. */
  close(): void {
    if (!this.repository.database.isOpen) return;
    this.repository.close();
  }

  list(input: unknown = {}): CapabilityApiResponse {
    try {
      const query = z.object({ capabilityId: CapabilityIdSchema.optional() }).strict().parse(
        typeof input === "string" ? { capabilityId: input } : input,
      );
      return ok(this.library.list(query.capabilityId));
    } catch (error) {
      return failure(error);
    }
  }

  get(input: unknown, version?: number): CapabilityApiResponse {
    try {
      const query = typeof input === "string"
        ? { capabilityId: input, version }
        : z.object({ capabilityId: CapabilityIdSchema, version: CapabilityVersionSchema }).strict().parse(input);
      const parsed = z.object({ capabilityId: CapabilityIdSchema, version: CapabilityVersionSchema }).strict().parse(query);
      const record = this.library.get(parsed.capabilityId, parsed.version);
      return record ? ok(record) : errorResponse(404, `Capability version not found: ${parsed.capabilityId}@${parsed.version}`);
    } catch (error) {
      return failure(error);
    }
  }

  create(input: unknown): CapabilityApiResponse {
    try {
      const request = CapabilityCreateRequestSchema.parse(input);
      return commandResponse(this.library.createVersion({
        capabilityId: request.capabilityId,
        ...(request.version === undefined ? {} : { version: request.version }),
        definition: CapabilityDefinitionSchema.parse(request.definition),
        provenance: CapabilityProvenanceSchema.parse(request.provenance),
        requestKey: request.requestKey,
      }), "create");
    } catch (error) {
      return failure(error);
    }
  }

  activate(input: unknown): CapabilityApiResponse {
    return this.transition(input, "activate");
  }

  deprecate(input: unknown): CapabilityApiResponse {
    return this.transition(input, "deprecate");
  }

  prepare(input: unknown): CapabilityApiResponse {
    try {
      const request = CapabilityPrepareRequestSchema.parse(input);
      return ok(this.library.prepareExecution(request.capabilityId, request.version, {
        parameters: request.parameters,
        ...(request.target === undefined ? {} : { target: request.target }),
      }));
    } catch (error) {
      if (isNotFoundError(error)) return errorResponse(404, error.message);
      return failure(error);
    }
  }

  // Named aliases keep the boundary discoverable to MCP tool registries that
  // expose verbs as `createCapability`/`prepareExecution` while retaining the
  // concise HTTP-oriented method names above.
  listCapabilities(input: unknown = {}): CapabilityApiResponse { return this.list(input); }
  getCapability(input: unknown, version?: number): CapabilityApiResponse { return this.get(input, version); }
  createCapability(input: unknown): CapabilityApiResponse { return this.create(input); }
  activateCapability(input: unknown): CapabilityApiResponse { return this.activate(input); }
  deprecateCapability(input: unknown): CapabilityApiResponse { return this.deprecate(input); }
  prepareExecution(input: unknown): CapabilityApiResponse { return this.prepare(input); }

  /**
   * Dispatch a parsed request. The method intentionally receives an already
   * decoded body so neither HTTP nor MCP parsing rules leak into the adapter.
   */
  async handle(request: CapabilityApiRequest): Promise<CapabilityApiResponse> {
    try {
      const method = request.method.toUpperCase();
      const url = new URL(request.path, "http://capability-api.invalid");
      const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      const baseIndex = segments[0] === "v1" && segments[1] === "capabilities" ? 2 : segments[0] === "capabilities" ? 1 : -1;
      if (baseIndex < 0) return errorResponse(404, "Capability API route not found");
      const route = segments.slice(baseIndex);

      if (method === "GET" && route.length === 0) {
        const capabilityId = request.query?.capabilityId ?? url.searchParams.get("capabilityId") ?? undefined;
        return this.list(capabilityId === undefined ? {} : { capabilityId });
      }
      if (method === "POST" && route.length === 0) return this.create(CapabilityRouteCreateBodySchema.parse(request.body));
      if (route.length !== 2 && route.length !== 3) return errorResponse(404, "Capability API route not found");

      const capabilityId = CapabilityIdSchema.parse(route[0]);
      const version = CapabilityVersionSchema.parse(Number(route[1]));
      if (method === "GET" && route.length === 2) return this.get({ capabilityId, version });
      if (method !== "POST" || route.length !== 3) return errorResponse(404, "Capability API route not found");

      const action = route[2];
      if (action === "prepare") {
        const body = CapabilityRoutePrepareBodySchema.parse(request.body);
        return this.prepare({ capabilityId, version, ...body });
      }
      if (action === "activate" || action === "deprecate") {
        const body = CapabilityRouteMutationBodySchema.parse(request.body);
        return action === "activate"
          ? this.activate({ capabilityId, version, ...body })
          : this.deprecate({ capabilityId, version, ...body });
      }
      return errorResponse(404, "Capability API route not found");
    } catch (error) {
      return failure(error);
    }
  }

  private transition(input: unknown, operation: "activate" | "deprecate"): CapabilityApiResponse {
    try {
      const request = CapabilityStateRequestSchema.parse(input);
      const stateInput = {
        capabilityId: request.capabilityId,
        version: request.version,
        actor: request.actor,
        requestKey: request.requestKey,
        ...(request.parameters === undefined ? {} : { parameters: request.parameters }),
        ...(request.triggers === undefined ? {} : { triggers: request.triggers }),
        ...(request.target === undefined ? {} : { target: request.target }),
      };
      const result = operation === "activate"
        ? this.library.activate(stateInput)
        : this.library.deprecate(stateInput);
      return commandResponse(result, operation);
    } catch (error) {
      return failure(error);
    }
  }
}

/** Explicit service naming for callers that prefer a service over an adapter. */
export const CapabilityLibraryApi = CapabilityApiAdapter;
export const CapabilityApiService = CapabilityApiAdapter;

function ok(body: unknown): CapabilityApiResponse {
  return { status: 200, body };
}

function errorResponse(status: number, message: string): CapabilityApiResponse {
  return { status, body: { error: message } };
}

function commandResponse(result: CapabilityLibraryCommandResult, operation: string): CapabilityApiResponse {
  if (result.status === "conflict") {
    return { status: 409, body: { ...result, error: result.reason ?? "Capability command conflicts with durable state." } };
  }
  if (result.status === "rejected") {
    const status = result.reason?.includes("not found") ? 404 : 422;
    return { status, body: { ...result, error: result.reason ?? "Capability command was rejected." } };
  }
  // Replays are successful reads of a previously durable command. They are
  // intentionally distinguishable in the body but never masquerade as a new
  // commit (and therefore never return 201).
  return { status: result.status === "replayed" ? 200 : operation === "create" ? 201 : 200, body: result };
}

function failure(error: unknown): CapabilityApiResponse {
  if (error instanceof z.ZodError) return errorResponse(400, error.issues.map((issue) => issue.message).join("; "));
  if (error instanceof Error) return errorResponse(400, error.message);
  return errorResponse(400, String(error));
}

function isNotFoundError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith("Capability version not found:");
}

// Keep these imports visible in generated declarations for consumers that use
// the adapter as their sole capability-library integration point.
export type {
  CapabilityCompatibilityTarget,
  CapabilityExecutionDefaults,
  CapabilityVersionRecord,
  ObjectiveActor,
  CapabilityLibraryReceipt,
  CapabilityExecutionResolution,
};
