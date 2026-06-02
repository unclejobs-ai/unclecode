import { runRustCommandSync } from "../rust-command.js";

export type PatchHunk = {
  readonly oldStart: number;
  readonly oldLen: number;
  readonly newStart: number;
  readonly newLen: number;
  readonly lines: ReadonlyArray<string>;
};

export type FilePatch = {
  readonly oldPath: string;
  readonly newPath: string;
  readonly hunks: ReadonlyArray<PatchHunk>;
};

export type ApplyPatchInput = {
  readonly cwd: string;
  readonly patch: string;
};

export type ApplyPatchResult = {
  readonly applied: ReadonlyArray<{ readonly path: string; readonly hunkCount: number }>;
  readonly rejected: ReadonlyArray<{
    readonly path: string;
    readonly hunkIndex: number;
    readonly reason: string;
  }>;
};

export function parseUnifiedDiff(patch: string): ReadonlyArray<FilePatch> {
  return parseRustJson(
    runRustCommandSync(["rust", "aci", "parse-patch"], process.cwd(), patch),
    isFilePatchArray,
    "parseUnifiedDiff",
  );
}

export function applyPatch(input: ApplyPatchInput): ApplyPatchResult {
  return parseRustJson(
    runRustCommandSync(["rust", "aci", "apply-patch"], input.cwd, input.patch),
    isApplyPatchResult,
    "applyPatch",
  );
}

function parseRustJson<T>(stdout: string, guard: (value: unknown) => value is T, label: string): T {
  const parsed = JSON.parse(stdout) as unknown;
  if (!guard(parsed)) {
    throw new Error(`${label}: invalid Rust result`);
  }
  return parsed;
}

function isFilePatchArray(value: unknown): value is ReadonlyArray<FilePatch> {
  return Array.isArray(value) && value.every(isFilePatch);
}

function isFilePatch(value: unknown): value is FilePatch {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.oldPath === "string" &&
    typeof value.newPath === "string" &&
    Array.isArray(value.hunks) &&
    value.hunks.every(isPatchHunk)
  );
}

function isPatchHunk(value: unknown): value is PatchHunk {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Number.isInteger(value.oldStart) &&
    Number.isInteger(value.oldLen) &&
    Number.isInteger(value.newStart) &&
    Number.isInteger(value.newLen) &&
    Array.isArray(value.lines) &&
    value.lines.every((line) => typeof line === "string")
  );
}

function isApplyPatchResult(value: unknown): value is ApplyPatchResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Array.isArray(value.applied) &&
    value.applied.every(isAppliedPatch) &&
    Array.isArray(value.rejected) &&
    value.rejected.every(isRejectedPatch)
  );
}

function isAppliedPatch(value: unknown): value is { readonly path: string; readonly hunkCount: number } {
  return isRecord(value) && typeof value.path === "string" && Number.isInteger(value.hunkCount);
}

function isRejectedPatch(
  value: unknown,
): value is { readonly path: string; readonly hunkIndex: number; readonly reason: string } {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    Number.isInteger(value.hunkIndex) &&
    typeof value.reason === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
