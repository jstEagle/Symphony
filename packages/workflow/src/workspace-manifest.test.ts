import { describe, expect, it } from "vitest";
import {
  applyWorkspaceRebind,
  isPathWithin,
  proposeWorkspaceRebind,
  recordWorkspaceCommandEvidence,
  revalidateWorkspaceManifest,
  validateObjectiveCheckpointWorkspace,
  validateWorkspaceManifestTransition,
  validateWorkspaceRebind,
} from "./workspace-manifest.js";
import { createWorkspaceManifest, parseWorkspaceManifest, type WorkspaceManifestBody } from "../../protocol/src/workspace-manifest.js";
import type { ObjectiveCheckpointRecord } from "../../protocol/src/index.js";

const root = "/tmp/symphony-workspace";
const head = "abcdef1234567890abcdef1234567890abcdef12";
const digest = "1111111111111111111111111111111111111111111111111111111111111111";
const fileDigest = "2222222222222222222222222222222222222222222222222222222222222222";

function body(overrides: Partial<WorkspaceManifestBody> = {}): WorkspaceManifestBody {
  return {
    version: 1,
    cwd: `${root}/packages/worker`,
    workspaceRoot: root,
    repository: { root, gitDir: `${root}/.git`, branch: "main", ref: "refs/heads/main", head },
    worktree: { id: "worktree-1", path: root, gitDir: `${root}/.git` },
    dirty: { clean: true, digest, trackedCount: 0, untrackedCount: 0, ignoredCount: 1, changedPathsDigest: digest },
    files: [{ path: ".env.local", kind: "ignored", size: 17, sha256: fileDigest }],
    commands: [],
    capabilities: { root, permission: "full-access", allowedPaths: [root], deniedPaths: [] },
    provenance: { manifestId: "manifest-1", createdAt: "2026-09-01T00:00:00Z", createdBy: "test", source: "capture" },
    ...overrides,
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    cwd: `${root}/packages/worker`,
    workspaceRoot: root,
    repository: { root, gitDir: `${root}/.git`, branch: "main", ref: "refs/heads/main", head },
    worktree: { id: "worktree-1", path: root, gitDir: `${root}/.git` },
    dirty: { clean: true, digest, trackedCount: 0, untrackedCount: 0, ignoredCount: 1 },
    files: [{ path: ".env.local", sha256: fileDigest, exists: true }],
    changedPaths: [],
    permission: "full-access",
    ...overrides,
  };
}

describe("workspace manifest durability", () => {
  it("uses separator-independent containment for restart records", () => {
    expect(isPathWithin("/workspace", "/workspace/src/index.ts")).toBe(true);
    expect(isPathWithin("/workspace", "/workspace-other/src/index.ts")).toBe(false);
    expect(isPathWithin("C:\\Worktree", "c:/worktree/src/index.ts")).toBe(true);
    expect(isPathWithin("C:\\Worktree", "C:\\Worktree\\..\\outside.txt")).toBe(false);
  });

  it("round-trips a content-addressed manifest without storing file contents", () => {
    const manifest = createWorkspaceManifest(body());
    expect(parseWorkspaceManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(manifest)).not.toContain("secret");
  });

  it("records setup output as hashes and never executes or embeds command output", () => {
    const evidence = recordWorkspaceCommandEvidence({
      command: "pnpm install --frozen-lockfile",
      purpose: "dependency",
      startedAt: "2026-09-01T00:00:00Z",
      finishedAt: "2026-09-01T00:00:01Z",
      exitCode: 0,
      stdout: "installed 42 packages",
      stderr: "",
    });
    expect(evidence.stdoutSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(evidence)).not.toContain("installed 42 packages");
  });

  it("fails closed after restart when refs, worktree, ignored files, or scope drift", () => {
    const manifest = createWorkspaceManifest(body());
    const result = revalidateWorkspaceManifest(manifest, observation({
      repository: { root, gitDir: `${root}/.git`, branch: "feature", ref: "refs/heads/feature", head: "9999999999999999999999999999999999999999" },
      worktree: { id: "worktree-2", path: "/tmp/moved-workspace", gitDir: "/tmp/moved-workspace/.git" },
      files: [{ path: ".env.local", sha256: fileDigest, exists: false }],
      changedPaths: ["../outside.txt"],
    }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(["stale-ref", "stale-head", "worktree-moved", "missing-ignored-file", "out-of-scope-path"]));
  });

  it("requires the checkpoint and diff binding to survive a restart", () => {
    const checkpoint = { id: "checkpoint-1", baseHead: head, diffSha256: digest, pathsSha256: fileDigest, createdAt: "2026-09-01T00:00:00Z" };
    const manifest = createWorkspaceManifest(body({ checkpoint }));
    const result = revalidateWorkspaceManifest(manifest, observation({ checkpoint: { id: "checkpoint-1", baseHead: head, diffSha256: digest, pathsSha256: "3333333333333333333333333333333333333333333333333333333333333333" } }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((entry) => entry.code === "checkpoint-mismatch")).toBe(true);
  });

  it("validates a rebind before atomically producing the new manifest", () => {
    const current = createWorkspaceManifest(body());
    const nextRoot = "/tmp/symphony-workspace-next";
    const target = body({
      cwd: `${nextRoot}/packages/worker`,
      workspaceRoot: nextRoot,
      repository: { root: nextRoot, gitDir: `${nextRoot}/.git`, branch: "main", ref: "refs/heads/main", head },
      worktree: { id: "worktree-next", path: nextRoot, gitDir: `${nextRoot}/.git` },
      capabilities: { root: nextRoot, permission: "full-access", allowedPaths: [nextRoot], deniedPaths: [] },
    });
    const proposal = proposeWorkspaceRebind(current, target, "2026-09-01T00:00:02Z");
    expect(validateWorkspaceRebind(proposal, current, observation({
      cwd: `${nextRoot}/packages/worker`, workspaceRoot: nextRoot,
      repository: { root: nextRoot, gitDir: `${nextRoot}/.git`, branch: "main", ref: "refs/heads/main", head },
      worktree: { id: "worktree-next", path: nextRoot, gitDir: `${nextRoot}/.git` },
    })).ok).toBe(true);
    const rebound = applyWorkspaceRebind(proposal, current, observation({
      cwd: `${nextRoot}/packages/worker`, workspaceRoot: nextRoot,
      repository: { root: nextRoot, gitDir: `${nextRoot}/.git`, branch: "main", ref: "refs/heads/main", head },
      worktree: { id: "worktree-next", path: nextRoot, gitDir: `${nextRoot}/.git` },
    }));
    expect(rebound.workspaceRoot).toBe(nextRoot);
    expect(rebound.manifestHash).not.toBe(current.manifestHash);
    expect(() => applyWorkspaceRebind(proposal, createWorkspaceManifest(body({ provenance: { manifestId: "other", createdAt: "2026-09-01T00:00:00Z", createdBy: "test", source: "capture" } })), observation())).toThrow("rebind rejected");
  });

  it("returns an explicit rebind requirement for checkpoint identity drift", () => {
    const manifest = createWorkspaceManifest(body());
    const checkpoint = {
      version: 1 as const,
      id: "checkpoint-1",
      runId: "run-1",
      objectiveId: "objective-1",
      sequence: 1,
      planRevision: 0,
      eventCursor: 1,
      context: {},
      taskStates: {},
      criteria: [],
      contextHash: digest,
      reason: "boundary",
      createdBy: { type: "system" as const, id: "test" },
      requestKey: "checkpoint-request-1",
      createdAt: "2026-09-01T00:00:00Z",
      workspaceManifest: manifest,
    };
    const result = validateObjectiveCheckpointWorkspace(checkpoint as ObjectiveCheckpointRecord, "resume", observation({
      repository: { root, gitDir: `${root}/.git`, branch: "main", ref: "refs/heads/main", head: "9999999999999999999999999999999999999999" },
    }));
    expect(result).toMatchObject({ status: "rebind-required", ok: false, rebindRequired: true });
    expect(result.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "rebind", code: "stale-head", path: "repository.head" }),
    ]));
  });

  it("keeps transition validation deterministic and reports setup/permission drift", () => {
    const setup = recordWorkspaceCommandEvidence({
      command: "pnpm install --frozen-lockfile",
      purpose: "dependency",
      startedAt: "2026-09-01T00:00:00Z",
      finishedAt: "2026-09-01T00:00:01Z",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    const manifest = createWorkspaceManifest(body({
      commands: [setup],
      capabilities: { root, permission: "read-only", allowedPaths: [root], deniedPaths: [] },
    }));
    const result = validateWorkspaceManifestTransition({
      operation: "accept",
      manifest,
      observation: observation({
        commands: [recordWorkspaceCommandEvidence({ ...setup, stdout: "changed" })],
        permission: "full-access",
      }),
    });
    expect(result.status).toBe("rebind-required");
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(["setup-mismatch", "permission-escalation"]));
    expect(result.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "setup" }),
      expect.objectContaining({ action: "permission" }),
    ]));
  });
});
