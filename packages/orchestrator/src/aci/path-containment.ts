/**
 * Path containment guard — refuses absolute paths, .. traversal, and
 * symlink-escape paths. Every ACI / snapshot / SOP write path passes user-
 * (or LLM-) supplied paths through here before opening the fd.
 *
 * Returns the resolved absolute path on success; throws on violation so
 * the caller cannot accidentally proceed.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ContainmentOptions = {
  readonly allowMissing?: boolean;
};

export class PathContainmentError extends Error {
  readonly path: string;
  readonly workspaceRoot: string;
  constructor(message: string, path: string, workspaceRoot: string) {
    super(message);
    this.name = "PathContainmentError";
    this.path = path;
    this.workspaceRoot = workspaceRoot;
  }
}

/**
 * Resolve to a canonical absolute path. When the leaf does not exist and
 * `allowMissing` is true, walk up the parent chain until an existing
 * directory is found, canonicalise that, then re-attach the missing tail.
 *
 * Without this, a non-existent leaf under a symlinked parent (e.g.
 * `workspace/escape-link/new-file.txt` where `escape-link → /etc`) would
 * skip realpath entirely and the symlink would silently escape the
 * containment check on the next `relative()` step.
 */
function canonical(path: string, allowMissing: boolean): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!allowMissing) throw error;
    // Walk up to the closest ancestor that exists, canonicalise it, then
    // re-attach the trailing missing segments. This forces symlink
    // resolution on every existing level, including the parent that
    // matters for containment. Without this, a non-existent leaf under a
    // symlinked parent (e.g. `workspace/escape-link/new-file.txt` where
    // `escape-link → /etc`) would skip realpath entirely and the symlink
    // would silently escape the containment check on the next relative()
    // step.
    let cursor = path;
    const tail: string[] = [];
    while (true) {
      const parent = dirname(cursor);
      if (parent === cursor) {
        // Reached filesystem root without finding any existing ancestor —
        // leave the original literal so the caller's containment check
        // still runs against it.
        return path;
      }
      // basename peels exactly one path component regardless of trailing
      // separators or UNC quirks; cursor.slice(parent.length + 1) breaks
      // when dirname strips a trailing sep and length math drifts.
      const segment = basename(cursor);
      try {
        const realParent = realpathSync(parent);
        // realParent is canonical; attach the segment that bridged
        // parent → cursor, then any deeper segments accumulated above.
        const suffix = tail.length === 0 ? segment : `${segment}${sep}${tail.join(sep)}`;
        return suffix.length > 0 ? join(realParent, suffix) : realParent;
      } catch {
        tail.unshift(segment);
        cursor = parent;
      }
    }
  }
}

/**
 * Best-effort containment guard. Resolves the candidate path against a
 * canonicalised workspace root and refuses absolute paths, NUL bytes, `..`
 * traversal, and symlink-escape paths. Returns the canonical absolute path
 * on success; throws `PathContainmentError` on violation.
 *
 * Caveat — TOCTOU: this check runs at validation time, not at fd-open
 * time. A concurrent agent that swaps a validated directory for a symlink
 * between this call and the subsequent `writeFileSync` / `execFile` can
 * still cross the boundary. Pure-userland Node has no `O_NOFOLLOW` seam,
 * so callers that share a workspace with adversarial co-tenants must
 * additionally constrain concurrency or use a lower-level open path.
 */
export function assertWithinWorkspace(
  workspaceRoot: string,
  candidatePath: string,
  options: ContainmentOptions = {},
): string {
  if (typeof candidatePath !== "string" || candidatePath.length === 0) {
    throw new PathContainmentError("path is empty", candidatePath, workspaceRoot);
  }
  if (isAbsolute(candidatePath)) {
    throw new PathContainmentError(
      `absolute path rejected (must be workspace-relative): ${candidatePath}`,
      candidatePath,
      workspaceRoot,
    );
  }
  if (candidatePath.includes("\0")) {
    throw new PathContainmentError("path contains NUL byte", candidatePath, workspaceRoot);
  }
  const allowMissing = options.allowMissing ?? false;
  const rootCanonical = canonical(resolve(workspaceRoot), false);
  const resolved = resolve(rootCanonical, candidatePath);
  const resolvedCanonical = canonical(resolved, allowMissing);
  const rel = relative(rootCanonical, resolvedCanonical);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathContainmentError(
      `path escapes workspace: ${candidatePath} → ${resolvedCanonical}`,
      candidatePath,
      workspaceRoot,
    );
  }
  if (rel.length > 0 && rel.split(sep).some((segment) => segment === "..")) {
    throw new PathContainmentError(
      `path contains traversal segment: ${candidatePath}`,
      candidatePath,
      workspaceRoot,
    );
  }
  return resolvedCanonical;
}
