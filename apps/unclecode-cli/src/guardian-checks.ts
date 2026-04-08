import { execFile as execFileCallback } from "node:child_process";
import { readFile as readFileCallback } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

type ExecFileResult = {
  stdout: string;
  stderr: string;
};

type ExecFileLike = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<ExecFileResult>;

type ReadFileLike = (path: string, encoding: BufferEncoding) => Promise<string>;

export type GuardianExecutableCheck = {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly summary: string;
};

export type GuardianExecutableCheckResult = {
  readonly checks: readonly GuardianExecutableCheck[];
  readonly summary: string;
};

export async function runWorkspaceGuardianChecks(
  input: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    scripts?: readonly string[];
    changedFiles?: readonly string[];
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

  if (runnableScripts.length === 0) {
    return {
      checks: [],
      summary: "No executable checks configured.",
    };
  }

  const selectedScripts = selectChangedFileAwareScripts(
    runnableScripts,
    input.changedFiles ?? [],
  );

  if (selectedScripts.length === 0) {
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
    checks,
    summary: checks.map((check) => check.summary).join(" · "),
  };
}

type ChangedFileSignals = {
  readonly hasSourceFiles: boolean;
  readonly hasTestFiles: boolean;
  readonly hasConfigFiles: boolean;
  readonly hasOnlyDocs: boolean;
  readonly hasMeaningfulFiles: boolean;
};

function resolveRunnableScripts(
  requestedScripts: readonly string[],
  availableScripts: ReadonlySet<string>,
  changedFiles: readonly string[],
): readonly string[] {
  const resolved: string[] = [];

  for (const script of requestedScripts) {
    if (script === "test") {
      const expandedTests = resolveTargetedTestScripts(changedFiles, availableScripts);
      if (expandedTests.length > 0) {
        for (const expanded of expandedTests) {
          if (!resolved.includes(expanded)) {
            resolved.push(expanded);
          }
        }
        continue;
      }
    }

    if (availableScripts.has(script) && !resolved.includes(script)) {
      resolved.push(script);
    }
  }

  return resolved;
}

function selectChangedFileAwareScripts(
  scripts: readonly string[],
  changedFiles: readonly string[],
): readonly string[] {
  if (changedFiles.length === 0) {
    return scripts;
  }

  const signals = analyzeChangedFiles(changedFiles);
  if (!signals.hasMeaningfulFiles || signals.hasOnlyDocs) {
    return [];
  }

  if (signals.hasTestFiles && !signals.hasSourceFiles && !signals.hasConfigFiles) {
    return scripts.filter((script) => isTestScript(script) || !isKnownGuardianScript(script));
  }

  return scripts.filter((script) => shouldRunGuardianScript(script, signals));
}

function analyzeChangedFiles(changedFiles: readonly string[]): ChangedFileSignals {
  const normalized = normalizeChangedFiles(changedFiles);
  const hasSourceFiles = normalized.some((file) => isSourceFile(file));
  const hasTestFiles = normalized.some((file) => isTestFile(file));
  const hasConfigFiles = normalized.some((file) => isConfigFile(file));
  const hasMeaningfulFiles = hasSourceFiles || hasTestFiles || hasConfigFiles;
  const hasOnlyDocs =
    !hasMeaningfulFiles && normalized.length > 0 && normalized.every((file) => isDocLikeFile(file));

  return {
    hasSourceFiles,
    hasTestFiles,
    hasConfigFiles,
    hasOnlyDocs,
    hasMeaningfulFiles,
  };
}

function shouldRunGuardianScript(script: string, signals: ChangedFileSignals): boolean {
  if (!isKnownGuardianScript(script)) {
    return true;
  }

  if (isLintScript(script)) {
    return signals.hasSourceFiles || signals.hasTestFiles || signals.hasConfigFiles;
  }

  if (isTypecheckScript(script)) {
    return signals.hasSourceFiles || signals.hasConfigFiles;
  }

  if (isTestScript(script)) {
    return signals.hasSourceFiles || signals.hasTestFiles || signals.hasConfigFiles;
  }

  if (isBuildScript(script)) {
    return signals.hasSourceFiles || signals.hasConfigFiles;
  }

  return true;
}

function isKnownGuardianScript(script: string): boolean {
  return isLintScript(script) || isTypecheckScript(script) || isTestScript(script) || isBuildScript(script);
}

function isLintScript(script: string): boolean {
  return /(^|:)(lint|format:check)$/.test(script) || script === "lint";
}

function isTypecheckScript(script: string): boolean {
  return /(^|:)(check|typecheck|tsc)$/.test(script);
}

function isTestScript(script: string): boolean {
  return /(^|:)(test|test:unit|test:integration)$/.test(script);
}

function isBuildScript(script: string): boolean {
  return /(^|:)build$/.test(script);
}

function isSourceFile(file: string): boolean {
  return /\.(c|m)?[jt]sx?$/.test(file) && !isTestFile(file);
}

function isTestFile(file: string): boolean {
  return /(^|\/)(__tests__|tests?)(\/|$)/.test(file) || /\.(test|spec)\.(c|m)?[jt]sx?$/.test(file);
}

function isConfigFile(file: string): boolean {
  const base = file.split("/").at(-1) ?? file;
  return base === "package.json"
    || base === "package-lock.json"
    || base === "pnpm-lock.yaml"
    || base === "yarn.lock"
    || /^tsconfig(\..+)?\.json$/.test(base)
    || /^biome(\..+)?\.jsonc?$/.test(base)
    || /^eslint(\..+)?\./.test(base)
    || /^vitest(\..+)?\./.test(base)
    || /^jest(\..+)?\./.test(base)
    || /^vite(\..+)?\./.test(base)
    || /^next\.config\./.test(base);
}

function isDocLikeFile(file: string): boolean {
  return /\.(md|mdx|txt|rst)$/.test(file);
}

function normalizeChangedFiles(changedFiles: readonly string[]): readonly string[] {
  return changedFiles
    .map((file) => file.trim().replace(/\\/g, "/").toLowerCase())
    .filter((file) => file.length > 0);
}

function resolveTargetedTestScripts(
  changedFiles: readonly string[],
  availableScripts: ReadonlySet<string>,
): readonly string[] {
  const normalized = normalizeChangedFiles(changedFiles);
  if (normalized.length === 0) {
    return availableScripts.has("test") ? ["test"] : [];
  }

  const targeted: string[] = [];
  for (const file of normalized) {
    const script = resolveTargetedTestScriptForFile(file);
    if (script && availableScripts.has(script) && !targeted.includes(script)) {
      targeted.push(script);
    }
  }

  if (targeted.length > 0) {
    return targeted;
  }

  return availableScripts.has("test") ? ["test"] : [];
}

function resolveTargetedTestScriptForFile(file: string): string | undefined {
  if (/(^|\/)(tests\/providers|packages\/providers\/)/.test(file)) {
    return "test:providers";
  }
  if (/(^|\/)(tests\/context-broker|packages\/context-broker\/)/.test(file)) {
    return "test:context-broker";
  }
  if (/(^|\/)(tests\/runtime-broker|packages\/runtime-broker\/)/.test(file)) {
    return "test:runtime-broker";
  }
  if (/(^|\/)(tests\/contracts|packages\/contracts\/|packages\/config-core\/)/.test(file)) {
    return "test:contracts";
  }
  if (/(^|\/)(tests\/performance)/.test(file)) {
    return "test:performance";
  }
  if (/(^|\/)(tests\/orchestrator|packages\/orchestrator\/)/.test(file)) {
    return "test:orchestrator";
  }
  if (/(^|\/)(tests\/tui|packages\/tui\/)/.test(file)) {
    return "test:tui";
  }
  if (/(^|\/)(tests\/commands|apps\/unclecode-cli\/src\/(command-router|program|interactive-shell|fast-cli|fast-sessions|startup-paths|operational)\.ts)/.test(file)) {
    return "test:commands";
  }
  if (/(^|\/)(tests\/work|apps\/unclecode-cli\/src\/(work-runtime|guardian-checks|runtime-coding-agent)\.ts|src\/)/.test(file)) {
    return "test:work";
  }
  return undefined;
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
