import { runRustCommand, runRustCommandSync } from "../rust-command.js";
import type { LintResult, LintRunner } from "./linter-guardrail.js";
import { defaultLintRunner } from "./linter-guardrail.js";

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

type RustEditResult =
  | {
      readonly status: "applied";
      readonly absPath: string;
      readonly contentPreview: string;
      readonly originalContent: string;
      readonly proposedContent: string;
    }
  | { readonly status: "out_of_range"; readonly totalLines: number; readonly errorMessage: string };

export async function editFile(input: EditInput, options: EditOptions = {}): Promise<EditResult> {
  const lintRunner = options.lintRunner ?? defaultLintRunner;
  const editResult = parseRustEditResult(
    await runRustCommand(
      [
        "rust",
        "aci",
        "edit-json",
        input.path,
        String(input.startLine),
        String(input.endLine),
      ],
      input.cwd,
      input.replacement,
    ),
  );
  if (editResult.status === "out_of_range") {
    return editResult;
  }

  const lintResult = await lintRunner({
    absPath: editResult.absPath,
    content: editResult.proposedContent,
  });
  if (lintResult.ok) {
    return {
      status: "applied",
      contentPreview: editResult.contentPreview,
      lintResult,
    };
  }

  await runRustCommand(["rust", "aci", "restore", input.path], input.cwd, editResult.originalContent);
  return {
    status: "lint_failed",
    errorMessage: buildRustLintFailureMessage(input, editResult, lintResult),
    lintResult,
  };
}

function parseRustEditResult(stdout: string): RustEditResult {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRustEditResult(parsed)) {
    throw new Error("file-editor: invalid Rust result");
  }
  return parsed;
}

function buildRustLintFailureMessage(
  input: EditInput,
  editResult: Extract<RustEditResult, { status: "applied" }>,
  lintResult: LintResult,
): string {
  const findingsText = lintResult.findings
    .slice(0, 5)
    .map((finding) => `- [${finding.code}] line ${finding.line ?? "?"}: ${finding.message}`)
    .join("\n");
  return runRustCommandSync(
    [
      "rust",
      "aci",
      "lint-failure-message",
      String(input.startLine),
      String(input.snippetContext ?? 5),
    ],
    input.cwd,
    [
      editResult.originalContent,
      editResult.proposedContent,
      input.replacement,
      findingsText,
    ].join("\0"),
  );
}

function isRustEditResult(value: unknown): value is RustEditResult {
  if (!isRecord(value) || typeof value.status !== "string") {
    return false;
  }
  if (value.status === "out_of_range") {
    return Number.isInteger(value.totalLines) && typeof value.errorMessage === "string";
  }
  return (
    value.status === "applied" &&
    typeof value.absPath === "string" &&
    typeof value.contentPreview === "string" &&
    typeof value.originalContent === "string" &&
    typeof value.proposedContent === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
