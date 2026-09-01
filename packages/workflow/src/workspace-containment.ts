import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type WorkspaceSpec } from "@symphony/protocol";

/**
 * A workspace grant is a capability boundary, not just a convenience cwd.
 * Always resolve both sides through the filesystem before comparing them so a
 * symlink cannot turn an apparently nested task into an outside operation.
 */
export class WorkspaceContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceContainmentError";
  }
}

export function canonicalWorkspacePath(
  inputPath: string,
  rootDirectory: string,
  label = "Workspace grant",
): string {
  const expanded = inputPath.replace(/^~(?=$|[\\/])/u, homedir());
  const absolute = isAbsolute(expanded) ? expanded : resolve(rootDirectory, expanded);
  if (!existsSync(absolute)) throw new WorkspaceContainmentError(`${label} does not exist: ${absolute}`);
  let canonical: string;
  try {
    canonical = realpathSync.native(absolute);
  } catch (error) {
    throw new WorkspaceContainmentError(`${label} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (!statSync(canonical).isDirectory()) throw new WorkspaceContainmentError(`${label} is not a folder: ${canonical}`);
  } catch (error) {
    if (error instanceof WorkspaceContainmentError) throw error;
    throw new WorkspaceContainmentError(`${label} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
  return canonical;
}

export function childWorkspaceGrant(
  parent: WorkspaceSpec,
  child: WorkspaceSpec | undefined,
  rootDirectory: string,
): WorkspaceSpec {
  const parentPath = canonicalWorkspacePath(parent.path, rootDirectory, "Parent workspace grant");
  if (!child) return { ...parent, path: parentPath };
  if (containsParentTraversal(child.path)) {
    throw new WorkspaceContainmentError("Child workspace grants cannot contain parent traversal (..).");
  }
  const expanded = child.path.replace(/^~(?=$|[\\/])/u, homedir());
  const requestedPath = isAbsolute(expanded) ? expanded : resolve(parentPath, expanded);
  const childPath = canonicalWorkspacePath(requestedPath, rootDirectory, "Child workspace grant");
  const relativePath = relative(parentPath, childPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new WorkspaceContainmentError("Child workspace grant must be contained within the parent workspace grant.");
  }
  return { ...child, path: childPath };
}

function containsParentTraversal(inputPath: string): boolean {
  return inputPath.split(/[\\/]+/u).some((segment) => segment === "..");
}
