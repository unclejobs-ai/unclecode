import { execFile as execFileCallback } from "node:child_process";
import { readFile as readFileCallback } from "node:fs/promises";
import { promisify } from "node:util";

import {
  resolveRunnableScripts,
  selectChangedFileAwareScripts,
} from "./guardian-script-selection.js";
import { runLspGuardianChecks } from "./guardian-lsp-checks.js";
import type {
  ExecFileLike,
  GuardianExecutableCheck,
  GuardianExecutableCheckResult,
  GuardianLspBridge,
  ReadFileLike,
} from "./guardian-check-types.js";

const execFile = promisify(execFileCallback);
export type {
  GuardianExecutableCheck,
  GuardianExecutableCheckResult,
  GuardianLspBridge,
} from "./guardian-check-types.js";

export async function runWorkspaceGuardianChecks(
  input: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    scripts?: readonly string[];
    changedFiles?: readonly string[];
    lspBridge?: GuardianLspBridge;
    lspTimeoutMs?: number;
    lspMaxDiagnostics?: number;
  },
  deps?: {
    readFile?: ReadFileLike;
    execFile?: ExecFileLike;
    platform?: NodeJS.Platform;
  },
): Promise<GuardianExecutableCheckResult> {
  const readFile = deps?.readFile ?? readFileCallback;
  const runExecFile = deps?.execFile ?? execFile;
  const platform = deps?.platform ?? process.platform;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const packageJsonPath = `${input.cwd}/package.json`;
  const availableScripts = await loadPackageScripts(packageJsonPath, readFile);
  const requestedScripts = input.scripts ?? ["check"];
  const runnableScripts = resolveRunnableScripts(
    requestedScripts,
    availableScripts,
    input.changedFiles ?? [],
  );
  const lspChecks = await runLspGuardianChecks({
    cwd: input.cwd,
    readFile,
    changedFiles: input.changedFiles ?? [],
    timeoutMs: input.lspTimeoutMs ?? timeoutMs,
    ...(input.lspBridge ? { lspBridge: input.lspBridge } : {}),
    ...(input.lspMaxDiagnostics !== undefined ? { maxDiagnostics: input.lspMaxDiagnostics } : {}),
  });

  if (runnableScripts.length === 0 && lspChecks.length === 0) {
    return {
      checks: [],
      summary: "No executable checks configured.",
    };
  }

  const selectedScripts = selectChangedFileAwareScripts(
    runnableScripts,
    input.changedFiles ?? [],
  );

  if (selectedScripts.length === 0 && lspChecks.length === 0) {
    return {
      checks: [],
      summary: input.changedFiles && input.changedFiles.length > 0
        ? "No applicable executable checks selected for changed files."
        : "No executable checks configured.",
    };
  }

  const command = platform === "win32" ? "npm.cmd" : "npm";
  const checks: GuardianExecutableCheck[] = [];

  for (const script of selectedScripts) {
    const startedAt = Date.now();
    try {
      await runExecFile(command, ["run", script, "--silent"], {
        cwd: input.cwd,
        ...(input.env ? { env: input.env } : {}),
        timeout: timeoutMs,
      });
      const durationMs = Date.now() - startedAt;
      checks.push({
        name: script,
        status: "passed",
        summary: `${script} PASS (${durationMs}ms)`,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const detail = extractFailureDetail(error);
      checks.push({
        name: script,
        status: "failed",
        summary: `${script} FAIL (${durationMs}ms)${detail ? ` · ${detail}` : ""}`,
      });
    }
  }

  return {
    checks: [...checks, ...lspChecks],
    summary: [...checks, ...lspChecks].map((check) => check.summary).join(" · "),
  };
}

async function loadPackageScripts(packageJsonPath: string, readFile: ReadFileLike): Promise<Set<string>> {
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return new Set(Object.keys(parsed.scripts ?? {}));
  } catch {
    return new Set();
  }
}

function extractFailureDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stdout = typeof (error as Error & { stdout?: unknown }).stdout === "string"
    ? ((error as Error & { stdout?: string }).stdout ?? "")
    : "";
  const stderr = typeof (error as Error & { stderr?: unknown }).stderr === "string"
    ? ((error as Error & { stderr?: string }).stderr ?? "")
    : "";
  const combined = `${stderr}\n${stdout}`
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return combined ?? error.message;
}
