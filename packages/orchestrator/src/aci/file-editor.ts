/**
 * ACI File Editor — line-anchored multi-line edit with linter guardrail.
 * Linter runs against the proposed content; on syntax error the edit is
 * reverted and a 3-part error message (error code + preview + original
 * snippet) is returned so the agent can self-correct (SWE-agent NeurIPS
 * 2024, §3 + §A.1).
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";

import type { LintResult, LintRunner } from "./linter-guardrail.js";
import { defaultLintRunner } from "./linter-guardrail.js";
import { assertWithinWorkspace } from "./path-containment.js";

export type EditInput = {
  readonly cwd: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly replacement: string;
  readonly snippetContext?: number;
};

export type EditResult =
  | { readonly status: "applied"; readonly contentPreview: string; readonly lintResult: LintResult }
  | { readonly status: "lint_failed"; readonly errorMessage: string; readonly lintResult: LintResult }
  | { readonly status: "out_of_range"; readonly totalLines: number; readonly errorMessage: string };

export type EditOptions = {
  readonly lintRunner?: LintRunner;
};

export async function editFile(input: EditInput, options: EditOptions = {}): Promise<EditResult> {
  const lintRunner = options.lintRunner ?? defaultLintRunner;
  const absPath = assertWithinWorkspace(input.cwd, input.path);
  statSync(absPath);
  const original = readFileSync(absPath, "utf8");
  const lines = original.split(/\r?\n/);

  if (input.startLine < 1 || input.endLine > lines.length || input.startLine > input.endLine + 1) {
    return {
      status: "out_of_range",
      totalLines: lines.length,
      errorMessage: `start=${input.startLine} end=${input.endLine} outside 1..${lines.length}`,
    };
  }

  const replacementLines = input.replacement.split(/\r?\n/);
  const before = lines.slice(0, input.startLine - 1);
  const after = lines.slice(input.endLine);
  const next = [...before, ...replacementLines, ...after].join("\n");

  writeFileSync(absPath, next, "utf8");
  // Best-effort rollback on lint failure. TOCTOU between validation and
  // write is inherent to pure-userland Node (no O_NOFOLLOW); the upstream
  // assertWithinWorkspace + statSync chain is the primary guard.
  const lintResult = await lintRunner({ absPath, content: next });
  if (!lintResult.ok) {
    writeFileSync(absPath, original, "utf8");
    const snippetContext = input.snippetContext ?? 5;
    const previewStart = Math.max(0, input.startLine - 1 - snippetContext);
    const previewEnd = Math.min(lines.length, input.startLine - 1 + replacementLines.length + snippetContext);
    const proposedSnippet = next
      .split(/\r?\n/)
      .slice(previewStart, previewEnd)
      .map((line, index) => `${previewStart + index + 1}: ${line}`)
      .join("\n");
    const originalSnippet = lines
      .slice(previewStart, previewEnd)
      .map((line, index) => `${previewStart + index + 1}: ${line}`)
      .join("\n");
    const findingsText = lintResult.findings
      .slice(0, 5)
      .map((finding) => `- [${finding.code}] line ${finding.line ?? "?"}: ${finding.message}`)
      .join("\n");
    const errorMessage = [
      "[file-editor] lint failed; edit reverted.",
      "Errors:",
      findingsText || "(linter returned no structured findings)",
      "",
      "Proposed (would-have-been):",
      proposedSnippet,
      "",
      "Original (current state):",
      originalSnippet,
    ].join("\n");
    return { status: "lint_failed", errorMessage, lintResult };
  }
  const previewStart = Math.max(0, input.startLine - 1 - 2);
  const previewEnd = Math.min(next.split(/\r?\n/).length, input.startLine - 1 + replacementLines.length + 2);
  const contentPreview = next
    .split(/\r?\n/)
    .slice(previewStart, previewEnd)
    .map((line, index) => `${previewStart + index + 1}: ${line}`)
    .join("\n");
  return { status: "applied", contentPreview, lintResult };
}
