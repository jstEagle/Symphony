import { z } from "zod";

/**
 * Objective values are intentionally declarative.  A charter can describe
 * what matters and what evidence is expected, but it cannot contain a role,
 * workflow step, expression, callback, or other executable instruction.
 */

const IdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u);
const HashSchema = z.string().min(8).max(256);
const TextSchema = z.string().min(1).max(2_000);

export const ObjectiveValuePrioritySchema = z.number().int().positive().max(100);
export type ObjectiveValuePriority = z.infer<typeof ObjectiveValuePrioritySchema>;

export const ObjectiveValueSchema = z
  .object({
    id: IdSchema,
    label: TextSchema,
    priority: ObjectiveValuePrioritySchema,
    description: z.string().max(2_000).optional(),
  })
  .strict();
export type ObjectiveValue = z.infer<typeof ObjectiveValueSchema>;
/** Descriptive alias for callers that name this an entry rather than a value. */
export const ObjectiveValueEntrySchema = ObjectiveValueSchema;
export type ObjectiveValueEntry = ObjectiveValue;

/** A typed preference between two declared values; it is not a decision rule. */
export const ObjectiveValueTradeoffSchema = z
  .object({
    id: IdSchema,
    higherPriorityValueId: IdSchema,
    lowerPriorityValueId: IdSchema,
    guidance: TextSchema,
  })
  .strict();
export type ObjectiveValueTradeoff = z.infer<typeof ObjectiveValueTradeoffSchema>;
export const ObjectiveTradeoffGuidanceSchema = ObjectiveValueTradeoffSchema;
export type ObjectiveTradeoffGuidance = ObjectiveValueTradeoff;

export const ObjectiveValueAntiGoalSchema = z
  .object({
    id: IdSchema,
    statement: TextSchema,
    description: z.string().max(2_000).optional(),
  })
  .strict();
export type ObjectiveValueAntiGoal = z.infer<typeof ObjectiveValueAntiGoalSchema>;
export const ObjectiveAntiGoalSchema = ObjectiveValueAntiGoalSchema;
export type ObjectiveAntiGoal = ObjectiveValueAntiGoal;

export const ObjectiveValueHardConstraintSchema = z
  .object({
    id: IdSchema,
    statement: TextSchema,
    description: z.string().max(2_000).optional(),
  })
  .strict();
export type ObjectiveValueHardConstraint = z.infer<typeof ObjectiveValueHardConstraintSchema>;
export const ObjectiveHardConstraintSchema = ObjectiveValueHardConstraintSchema;
export type ObjectiveHardConstraint = ObjectiveValueHardConstraint;

export const ObjectiveEvidenceSourceKindSchema = z.enum([
  "event",
  "observation",
  "artifact",
  "checkpoint",
  "agent-output",
  "workspace",
  "external",
]);
export type ObjectiveEvidenceSourceKind = z.infer<typeof ObjectiveEvidenceSourceKindSchema>;

export const ObjectiveValueEvidenceExpectationSchema = z
  .object({
    id: IdSchema,
    statement: TextSchema,
    required: z.boolean().default(true),
    sourceKinds: z.array(ObjectiveEvidenceSourceKindSchema).max(8).default([]),
    minimumSources: z.number().int().nonnegative().max(64).default(0),
  })
  .strict();
export type ObjectiveValueEvidenceExpectation = z.infer<typeof ObjectiveValueEvidenceExpectationSchema>;
export const ObjectiveEvidenceExpectationSchema = ObjectiveValueEvidenceExpectationSchema;
export type ObjectiveEvidenceExpectation = ObjectiveValueEvidenceExpectation;

/** The immutable, bounded content of an objective value charter. */
export const ObjectiveValueCharterSchema = z
  .object({
    version: z.literal(1).default(1),
    revision: z.number().int().positive().max(1_000_000_000).default(1),
    /** Hash is optional at the input edge and filled by the workflow kernel. */
    hash: HashSchema.optional(),
    values: z.array(ObjectiveValueSchema).min(1).max(32),
    tradeoffs: z.array(ObjectiveValueTradeoffSchema).max(64).default([]),
    antiGoals: z.array(ObjectiveValueAntiGoalSchema).max(32).default([]),
    hardConstraints: z.array(ObjectiveValueHardConstraintSchema).max(64).default([]),
    evidenceExpectations: z.array(ObjectiveValueEvidenceExpectationSchema).max(64).default([]),
  })
  .strict()
  .superRefine((charter, context) => {
    const ids = new Set<string>();
    for (const [index, value] of charter.values.entries()) {
      if (ids.has(value.id)) context.addIssue({ code: "custom", path: ["values", index, "id"], message: `Duplicate objective value id: ${value.id}` });
      ids.add(value.id);
    }
    const checkUnique = (entries: readonly { id: string }[], field: string): void => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        if (seen.has(entry.id)) context.addIssue({ code: "custom", path: [field, index, "id"], message: `Duplicate charter ${field} id: ${entry.id}` });
        seen.add(entry.id);
      });
    };
    checkUnique(charter.tradeoffs, "tradeoffs");
    checkUnique(charter.antiGoals, "antiGoals");
    checkUnique(charter.hardConstraints, "hardConstraints");
    checkUnique(charter.evidenceExpectations, "evidenceExpectations");
    charter.tradeoffs.forEach((tradeoff, index) => {
      if (!ids.has(tradeoff.higherPriorityValueId)) context.addIssue({ code: "custom", path: ["tradeoffs", index, "higherPriorityValueId"], message: `Tradeoff references unknown value ${tradeoff.higherPriorityValueId}` });
      if (!ids.has(tradeoff.lowerPriorityValueId)) context.addIssue({ code: "custom", path: ["tradeoffs", index, "lowerPriorityValueId"], message: `Tradeoff references unknown value ${tradeoff.lowerPriorityValueId}` });
      if (tradeoff.higherPriorityValueId === tradeoff.lowerPriorityValueId) context.addIssue({ code: "custom", path: ["tradeoffs", index], message: "A tradeoff must reference two different values" });
    });
    for (const [index, expectation] of charter.evidenceExpectations.entries()) {
      if (!expectation.required && expectation.minimumSources > 0) {
        context.addIssue({ code: "custom", path: ["evidenceExpectations", index, "minimumSources"], message: "Optional evidence expectations cannot require a minimum source count" });
      }
    }
  });
export type ObjectiveValueCharter = z.infer<typeof ObjectiveValueCharterSchema>;
/** Input form exposed for callers constructing a charter before defaults are applied. */
export type ObjectiveValueCharterInput = z.input<typeof ObjectiveValueCharterSchema>;

export const ObjectiveValueCharterBindingSchema = z
  .object({
    revision: z.number().int().positive().max(1_000_000_000),
    hash: HashSchema,
  })
  .strict();
export type ObjectiveValueCharterBinding = z.infer<typeof ObjectiveValueCharterBindingSchema>;

/** Structured citations attached to a strategy mutation reason. */
export const ObjectiveValueCharterMutationCitationSchema = z
  .object({
    valueIds: z.array(IdSchema).max(32).default([]),
    tradeoffIds: z.array(IdSchema).max(64).default([]),
  })
  .strict()
  .superRefine((citation, context) => {
    const check = (entries: readonly string[], field: string): void => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        if (seen.has(entry)) context.addIssue({ code: "custom", path: [field, index], message: `Duplicate charter citation ${entry}` });
        seen.add(entry);
      });
    };
    check(citation.valueIds, "valueIds");
    check(citation.tradeoffIds, "tradeoffIds");
    if (citation.valueIds.length === 0 && citation.tradeoffIds.length === 0) {
      context.addIssue({ code: "custom", path: [], message: "A charter citation must identify an affected value or tradeoff" });
    }
  });
export type ObjectiveValueCharterMutationCitation = z.infer<typeof ObjectiveValueCharterMutationCitationSchema>;

/** The content hash excludes the optional self-referential hash field. */
export function objectiveValueCharterHash(charter: ObjectiveValueCharter | ObjectiveValueCharterInput): string {
  const parsed = ObjectiveValueCharterSchema.parse(charter);
  const { hash: _ignored, ...content } = parsed;
  return sha256(canonicalJson(content));
}

export function objectiveValueCharterBinding(charter: ObjectiveValueCharter | ObjectiveValueCharterInput): ObjectiveValueCharterBinding {
  const parsed = ObjectiveValueCharterSchema.parse(charter);
  const hash = objectiveValueCharterHash(parsed);
  if (parsed.hash !== undefined && parsed.hash !== hash) throw new Error("Objective value charter hash does not match its immutable content");
  return { revision: parsed.revision, hash };
}

/** Parse and fill the content address so all newly admitted records agree. */
export function normalizeObjectiveValueCharter(input: unknown): ObjectiveValueCharter {
  const parsed = ObjectiveValueCharterSchema.parse(input);
  return { ...parsed, hash: objectiveValueCharterBinding(parsed).hash };
}

export function isObjectiveValueCharterHashValid(charter: ObjectiveValueCharter | ObjectiveValueCharterInput): boolean {
  return charter.hash === objectiveValueCharterHash(charter);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Keep this module independent from the protocol barrel. Objective-control
// imports the charter citation schema, so importing the barrel here would
// create an initialization cycle for direct browser/package consumers.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6df3, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
  0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624,
  0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3,
  0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = bytes.length + 1 + 8 + ((64 - ((bytes.length + 1 + 8) % 64)) % 64);
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  padded[padded.length - 8] = (high >>> 24) & 0xff;
  padded[padded.length - 7] = (high >>> 16) & 0xff;
  padded[padded.length - 6] = (high >>> 8) & 0xff;
  padded[padded.length - 5] = high & 0xff;
  padded[padded.length - 4] = (low >>> 24) & 0xff;
  padded[padded.length - 3] = (low >>> 16) & 0xff;
  padded[padded.length - 2] = (low >>> 8) & 0xff;
  padded[padded.length - 1] = low & 0xff;

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const rotateRight = (word: number, bits: number): number => (word >>> bits) | (word << (32 - bits));

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] = ((padded[position]! << 24) | (padded[position + 1]! << 16) | (padded[position + 2]! << 8) | padded[position + 3]!) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const prior = words[index - 15]!;
      const secondPrior = words[index - 2]!;
      const sigma0 = rotateRight(prior, 7) ^ rotateRight(prior, 18) ^ (prior >>> 3);
      const sigma1 = rotateRight(secondPrior, 17) ^ rotateRight(secondPrior, 19) ^ (secondPrior >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choice + SHA256_K[index]! + words[index]!) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
}
