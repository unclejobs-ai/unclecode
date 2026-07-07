import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  GuardianExecutableCheck,
  GuardianLspBridge,
  ReadFileLike,
} from "./guardian-check-types.js";

export async function runLspGuardianChecks(input: {
  readonly cwd: string;
  readonly readFile: ReadFileLike;
  readonly changedFiles: readonly string[];
  readonly lspBridge?: GuardianLspBridge;
  readonly timeoutMs: number;
  readonly maxDiagnostics?: number;
}): Promise<readonly GuardianExecutableCheck[]> {
  if (!input.lspBridge || input.changedFiles.length === 0) {
    return [];
  }

  const checks: GuardianExecutableCheck[] = [];
  for (const file of input.changedFiles.filter(isLspCandidateFile)) {
    try {
      const path = await resolveWorkspaceFile(input.cwd, file);
      const content = await input.readFile(path, "utf8");
      const result = await input.lspBridge.checkAfterEdit({
        path: file,
        content,
        options: {
          timeoutMs: input.timeoutMs,
          ...(input.maxDiagnostics !== undefined ? { maxDiagnostics: input.maxDiagnostics } : {}),
        },
      });
      checks.push({
        name: `lsp:${file}`,
        status: result.status === "fail" || result.status === "unavailable" ? "failed" : "passed",
        summary: `lsp:${file} ${result.status.toUpperCase()} · ${result.summary}`,
      });
    } catch (error) {
      checks.push({
        name: `lsp:${file}`,
        status: "failed",
        summary: `lsp:${file} UNAVAILABLE · ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return checks;
}

function isLspCandidateFile(file: string): boolean {
  return /\.(c|m)?[jt]sx?$|\.rs$|\.py$|\.go$|\.java$|\.kt$|\.swift$|\.rb$|\.php$|\.cs$/i.test(file)
    && !/(^|\/)(__tests__|tests?)(\/|$)/i.test(file)
    && !/\.(test|spec)\.(c|m)?[jt]sx?$/i.test(file);
}

async function resolveWorkspaceFile(cwd: string, file: string): Promise<string> {
  const normalized = file.replace(/\\/g, "/");
  if (isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error(`changed file must be workspace-relative: ${file}`);
  }
  const root = resolve(cwd);
  const path = resolve(root, normalized);
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`changed file escapes workspace: ${file}`);
  }
  const realRoot = await realpath(root);
  const realFile = await realpath(path);
  const realRel = relative(realRoot, realFile);
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error(`changed file escapes workspace: ${file}`);
  }
  return path;
}
