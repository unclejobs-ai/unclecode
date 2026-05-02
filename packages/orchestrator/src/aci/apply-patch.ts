/**
 * Minimal unified-diff applier — supports `--- a/path` / `+++ b/path` headers
 * with `@@ -start,len +start,len @@` hunks. Context lines (` `) and
 * additions/removals (`+`/`-`). No fuzzy matching: hunks must match exactly.
 *
 * Returns the resulting per-file content + a structured rejection list when
 * a hunk does not apply, so the caller can surface a 3-part error message
 * the same way file-editor does.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

import { assertWithinWorkspace, PathContainmentError } from "./path-containment.js";

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
  const lines = patch.split(/\r?\n/);
  const files: FilePatch[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? "";
    if (!line.startsWith("--- ")) {
      cursor += 1;
      continue;
    }
    const oldHeader = line.slice(4).trim();
    const nextLine = lines[cursor + 1] ?? "";
    if (!nextLine.startsWith("+++ ")) {
      cursor += 1;
      continue;
    }
    const newHeader = nextLine.slice(4).trim();
    cursor += 2;
    const hunks: PatchHunk[] = [];
    while (cursor < lines.length && lines[cursor]?.startsWith("@@")) {
      const hunkHeader = lines[cursor] ?? "";
      const match = hunkHeader.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) {
        cursor += 1;
        continue;
      }
      const oldStart = Number.parseInt(match[1] ?? "0", 10);
      const oldLen = match[2] ? Number.parseInt(match[2], 10) : 1;
      const newStart = Number.parseInt(match[3] ?? "0", 10);
      const newLen = match[4] ? Number.parseInt(match[4], 10) : 1;
      cursor += 1;
      const hunkLines: string[] = [];
      while (cursor < lines.length) {
        const candidate = lines[cursor] ?? "";
        if (candidate.startsWith("--- ") || candidate.startsWith("@@")) {
          break;
        }
        hunkLines.push(candidate);
        cursor += 1;
      }
      hunks.push({ oldStart, oldLen, newStart, newLen, lines: hunkLines });
    }
    files.push({
      oldPath: stripDiffPrefix(oldHeader),
      newPath: stripDiffPrefix(newHeader),
      hunks,
    });
  }
  return files;
}

function stripDiffPrefix(header: string): string {
  return header.replace(/^a\//, "").replace(/^b\//, "").replace(/\t.*$/, "");
}

export function applyPatch(input: ApplyPatchInput): ApplyPatchResult {
  const files = parseUnifiedDiff(input.patch);
  const applied: { path: string; hunkCount: number }[] = [];
  const rejected: { path: string; hunkIndex: number; reason: string }[] = [];

  for (const file of files) {
    const target = file.newPath || file.oldPath;
    let absPath: string;
    try {
      absPath = assertWithinWorkspace(input.cwd, target, { allowMissing: true });
    } catch (error) {
      if (error instanceof PathContainmentError) {
        rejected.push({ path: target, hunkIndex: 0, reason: error.message });
        continue;
      }
      throw error;
    }
    const original = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";
    const lines = original.split(/\r?\n/);
    let working = lines.slice();
    let cursorOffset = 0;
    let success = true;

    for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
      const hunk = file.hunks[hunkIndex];
      if (!hunk) continue;
      const startIndex = hunk.oldStart - 1 + cursorOffset;
      const expectedOld: string[] = [];
      const replacement: string[] = [];
      for (const hl of hunk.lines) {
        if (hl.startsWith(" ")) {
          expectedOld.push(hl.slice(1));
          replacement.push(hl.slice(1));
        } else if (hl.startsWith("-")) {
          expectedOld.push(hl.slice(1));
        } else if (hl.startsWith("+")) {
          replacement.push(hl.slice(1));
        }
      }
      const actualOld = working.slice(startIndex, startIndex + expectedOld.length);
      if (actualOld.join("\n") !== expectedOld.join("\n")) {
        rejected.push({
          path: target,
          hunkIndex,
          reason: `hunk ${hunkIndex + 1} did not match at line ${hunk.oldStart}`,
        });
        success = false;
        break;
      }
      working = [
        ...working.slice(0, startIndex),
        ...replacement,
        ...working.slice(startIndex + expectedOld.length),
      ];
      cursorOffset += replacement.length - expectedOld.length;
    }

    if (success) {
      // Best-effort TOCTOU guard: assertWithinWorkspace + stat chain runs
      // before the write; pure-userland Node has no O_NOFOLLOW seam.
      writeFileSync(absPath, working.join("\n"));
      applied.push({ path: target, hunkCount: file.hunks.length });
    }
  }

  return { applied, rejected };
}
