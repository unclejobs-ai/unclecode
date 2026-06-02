import { runRustCommandSync } from "../rust-command.js";

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

export function assertWithinWorkspace(
  workspaceRoot: string,
  candidatePath: string,
  options: ContainmentOptions = {},
): string {
  const normalizedCandidate = normalizeCandidate(candidatePath, workspaceRoot);
  try {
    return runRustCommandSync(
      ["rust", "path", "assert", options.allowMissing === true ? "allow-missing" : "existing"],
      workspaceRoot,
      normalizedCandidate,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PathContainmentError(message, normalizedCandidate, workspaceRoot);
  }
}

function normalizeCandidate(candidatePath: string, workspaceRoot: string): string {
  if (typeof candidatePath !== "string" || candidatePath.length === 0) {
    throw new PathContainmentError("path is empty", String(candidatePath), workspaceRoot);
  }
  if (candidatePath.includes("\0")) {
    throw new PathContainmentError("path contains NUL byte", candidatePath, workspaceRoot);
  }
  return candidatePath.normalize("NFC");
}
