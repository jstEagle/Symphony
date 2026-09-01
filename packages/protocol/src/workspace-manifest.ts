import { z } from "zod";

/**
 * A workspace manifest is a portable, content-addressed description of the
 * execution boundary.  It intentionally contains metadata and digests only:
 * file contents, command output, and credentials never belong in this record.
 */
export const WORKSPACE_MANIFEST_VERSION = 1 as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, "Expected a SHA-256 digest.");
const CanonicalPathSchema = z.string().min(1).refine(isPortableAbsolute, "Expected an absolute canonical path.");
const RelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !isPortableAbsolute(value), "Manifest paths must be relative to the workspace root.")
  .refine((value) => value.split(/[\\/]+/u).every((part) => part !== ".."), "Manifest paths cannot escape the workspace root.");
const IsoDateSchema = z.iso.datetime({ offset: true });

export const WorkspaceManifestRepositorySchema = z
  .object({
    // Git also permits scp-style remotes (git@example.com:org/repo.git), so
    // this is an opaque identity string rather than an HTTP URL contract.
    remote: z.string().min(1).optional(),
    root: CanonicalPathSchema,
    gitDir: CanonicalPathSchema,
    commonGitDir: CanonicalPathSchema.optional(),
    branch: z.string().min(1).nullable(),
    ref: z.string().min(1),
    head: z.string().regex(/^[a-f0-9]{7,64}$/u),
  })
  .strict();
export type WorkspaceManifestRepository = z.infer<typeof WorkspaceManifestRepositorySchema>;

export const WorkspaceManifestWorktreeSchema = z
  .object({
    id: z.string().min(1).max(512),
    path: CanonicalPathSchema,
    gitDir: CanonicalPathSchema,
    commonGitDir: CanonicalPathSchema.optional(),
  })
  .strict();
export type WorkspaceManifestWorktree = z.infer<typeof WorkspaceManifestWorktreeSchema>;

export const WorkspaceManifestFileSchema = z
  .object({
    path: RelativePathSchema,
    kind: z.enum(["tracked", "ignored", "local-setup"]),
    size: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative().optional(),
    modifiedAt: IsoDateSchema.optional(),
    sha256: Sha256Schema,
  })
  .strict();
export type WorkspaceManifestFile = z.infer<typeof WorkspaceManifestFileSchema>;

export const WorkspaceManifestCommandEvidenceSchema = z
  .object({
    command: z.string().min(1).max(4_096),
    purpose: z.enum(["dependency", "setup", "verification"]),
    startedAt: IsoDateSchema,
    finishedAt: IsoDateSchema,
    exitCode: z.number().int(),
    stdoutSha256: Sha256Schema,
    stderrSha256: Sha256Schema,
    evidenceSha256: Sha256Schema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (Date.parse(evidence.finishedAt) < Date.parse(evidence.startedAt)) {
      context.addIssue({ code: "custom", path: ["finishedAt"], message: "Command evidence finished before it started." });
    }
  });
export type WorkspaceManifestCommandEvidence = z.infer<typeof WorkspaceManifestCommandEvidenceSchema>;

export const WorkspaceManifestDirtyStateSchema = z
  .object({
    clean: z.boolean(),
    digest: Sha256Schema,
    trackedCount: z.number().int().nonnegative(),
    untrackedCount: z.number().int().nonnegative(),
    ignoredCount: z.number().int().nonnegative(),
    changedPathsDigest: Sha256Schema,
  })
  .strict();
export type WorkspaceManifestDirtyState = z.infer<typeof WorkspaceManifestDirtyStateSchema>;

export const WorkspaceManifestCheckpointSchema = z
  .object({
    id: z.string().min(1).max(512),
    baseHead: z.string().regex(/^[a-f0-9]{7,64}$/u),
    diffSha256: Sha256Schema,
    pathsSha256: Sha256Schema,
    createdAt: IsoDateSchema,
  })
  .strict();
export type WorkspaceManifestCheckpoint = z.infer<typeof WorkspaceManifestCheckpointSchema>;

export const WorkspaceManifestCapabilitiesSchema = z
  .object({
    root: CanonicalPathSchema,
    permission: z.enum(["read-only", "full-access"]),
    allowedPaths: z.array(CanonicalPathSchema).max(512),
    deniedPaths: z.array(CanonicalPathSchema).max(512),
  })
  .strict();
export type WorkspaceManifestCapabilities = z.infer<typeof WorkspaceManifestCapabilitiesSchema>;

export const WorkspaceManifestProvenanceSchema = z
  .object({
    manifestId: z.string().min(1).max(512),
    createdAt: IsoDateSchema,
    createdBy: z.string().min(1).max(512),
    hostId: z.string().min(1).max(512).optional(),
    source: z.enum(["capture", "checkpoint", "rebind"]).default("capture"),
  })
  .strict();
export type WorkspaceManifestProvenance = z.infer<typeof WorkspaceManifestProvenanceSchema>;

export const WorkspaceManifestBodySchema = z
  .object({
    version: z.literal(WORKSPACE_MANIFEST_VERSION),
    cwd: CanonicalPathSchema,
    workspaceRoot: CanonicalPathSchema,
    repository: WorkspaceManifestRepositorySchema,
    worktree: WorkspaceManifestWorktreeSchema,
    dirty: WorkspaceManifestDirtyStateSchema,
    files: z.array(WorkspaceManifestFileSchema).max(10_000),
    commands: z.array(WorkspaceManifestCommandEvidenceSchema).max(1_000),
    checkpoint: WorkspaceManifestCheckpointSchema.optional(),
    capabilities: WorkspaceManifestCapabilitiesSchema,
    provenance: WorkspaceManifestProvenanceSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.repository.root !== manifest.workspaceRoot) {
      context.addIssue({ code: "custom", path: ["repository", "root"], message: "Repository root must equal workspaceRoot." });
    }
    if (manifest.worktree.path !== manifest.workspaceRoot) {
      context.addIssue({ code: "custom", path: ["worktree", "path"], message: "Worktree path must equal workspaceRoot." });
    }
    if (manifest.worktree.gitDir !== manifest.repository.gitDir) {
      context.addIssue({ code: "custom", path: ["worktree", "gitDir"], message: "Worktree gitDir must equal repository gitDir." });
    }
    if (manifest.capabilities.root !== manifest.workspaceRoot) {
      context.addIssue({ code: "custom", path: ["capabilities", "root"], message: "Capability root must equal workspaceRoot." });
    }
    if (!isPathWithin(manifest.workspaceRoot, manifest.cwd)) {
      context.addIssue({ code: "custom", path: ["cwd"], message: "cwd must be contained by workspaceRoot." });
    }
    for (const [index, file] of manifest.files.entries()) {
      if (!isPathWithin(manifest.workspaceRoot, joinRelative(manifest.workspaceRoot, file.path))) {
        context.addIssue({ code: "custom", path: ["files", index, "path"], message: "Manifest file is outside workspaceRoot." });
      }
    }
    for (const [index, path] of manifest.capabilities.allowedPaths.entries()) {
      if (!isPathWithin(manifest.workspaceRoot, path)) {
        context.addIssue({ code: "custom", path: ["capabilities", "allowedPaths", index], message: "Allowed capability path is outside workspaceRoot." });
      }
    }
    for (const [index, path] of manifest.capabilities.deniedPaths.entries()) {
      if (!isPathWithin(manifest.workspaceRoot, path)) {
        context.addIssue({ code: "custom", path: ["capabilities", "deniedPaths", index], message: "Denied capability path is outside workspaceRoot." });
      }
    }
    const seen = new Set<string>();
    for (const [index, file] of manifest.files.entries()) {
      if (seen.has(file.path)) context.addIssue({ code: "custom", path: ["files", index, "path"], message: "Duplicate manifest file path." });
      seen.add(file.path);
    }
    if (manifest.checkpoint && !manifest.repository.head.startsWith(manifest.checkpoint.baseHead) && !manifest.checkpoint.baseHead.startsWith(manifest.repository.head)) {
      context.addIssue({ code: "custom", path: ["checkpoint", "baseHead"], message: "Checkpoint baseHead must identify the manifest HEAD." });
    }
  });
export type WorkspaceManifestBody = z.infer<typeof WorkspaceManifestBodySchema>;

export const WorkspaceManifestSchema = WorkspaceManifestBodySchema.extend({ manifestHash: Sha256Schema }).strict();
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

export const WorkspaceManifestInputSchema = WorkspaceManifestBodySchema;
export type WorkspaceManifestInput = z.input<typeof WorkspaceManifestInputSchema>;

export function stableWorkspaceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableWorkspaceJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableWorkspaceJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function workspaceManifestHash(input: WorkspaceManifestBody | WorkspaceManifestInput): string {
  return workspaceManifestSha256(stableWorkspaceJson(input));
}

export function createWorkspaceManifest(input: WorkspaceManifestInput): WorkspaceManifest {
  const body = WorkspaceManifestInputSchema.parse(input);
  return WorkspaceManifestSchema.parse({ ...body, manifestHash: workspaceManifestHash(body) });
}

export function parseWorkspaceManifest(input: unknown): WorkspaceManifest {
  const manifest = WorkspaceManifestSchema.parse(input);
  const { manifestHash: _ignored, ...body } = manifest;
  const expected = workspaceManifestHash(body);
  if (manifest.manifestHash !== expected) throw new Error(`Workspace manifest hash mismatch: expected ${expected}.`);
  return manifest;
}

export function isPathWithin(root: string, candidate: string): boolean {
  const rootParts = portablePathParts(root);
  const candidateParts = portablePathParts(candidate);
  if (rootParts === null || candidateParts === null || rootParts.drive !== candidateParts.drive) return false;
  return rootParts.parts.every((part, index) => candidateParts.parts[index] === part);
}

function joinRelative(root: string, path: string): string {
  return `${root.replace(/[\\/]$/u, "")}/${path.replace(/\\/gu, "/")}`;
}

function isPortableAbsolute(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(value);
}

type PortablePath = { drive: string; parts: string[] };

function portablePathParts(value: string): PortablePath | null {
  if (!isPortableAbsolute(value)) return null;
  const slashValue = value.replace(/\\/gu, "/");
  const driveMatch = /^([A-Za-z]:)(?:\/|$)/u.exec(slashValue);
  const drive = (driveMatch?.[1] ?? "/").toLowerCase();
  const body = driveMatch ? slashValue.slice(driveMatch[0].length) : slashValue.replace(/^\/+/, "");
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(drive === "/" ? part : part.toLowerCase());
    }
  }
  return { drive, parts };
}

// Kept local so this protocol leaf does not import index.ts (which exports
// this module) and form a browser bundle cycle. It is the same synchronous,
// TextEncoder-based SHA-256 kept local to avoid importing the protocol index
// from a leaf module that the index itself exports.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

/** Runtime-neutral SHA-256 for manifest content addressing. */
function workspaceManifestSha256(value: string): string {
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
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
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
      words[index] = (words[index - 16]! + (rotateRight(prior, 7) ^ rotateRight(prior, 18) ^ (prior >>> 3)) + words[index - 7]! + (rotateRight(secondPrior, 17) ^ rotateRight(secondPrior, 19) ^ (secondPrior >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [...hash] as number[];
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + sigma1 + choice + SHA256_K[index]! + words[index]!) >>> 0;
      const sigma0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (sigma0 + majority) >>> 0;
      [h, g, f, e, d, c, b, a] = [g!, f!, e!, (d! + temp1) >>> 0, c!, b!, a!, (temp1 + temp2) >>> 0];
    }
    hash[0] = (hash[0]! + a!) >>> 0; hash[1] = (hash[1]! + b!) >>> 0; hash[2] = (hash[2]! + c!) >>> 0; hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0; hash[5] = (hash[5]! + f!) >>> 0; hash[6] = (hash[6]! + g!) >>> 0; hash[7] = (hash[7]! + h!) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
}
