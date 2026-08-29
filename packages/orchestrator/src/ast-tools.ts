import { realpathSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { ToolDefinition, ToolHandler } from "./tools.js";
import type { ToolRegistry } from "./tool-executor.js";
import { createOwnedProcessGroupController } from "./process-group-settlement.js";

const DEFAULT_MATCH_LIMIT = 50;
const MAX_MATCH_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
type AstGrepRunner = (
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
) => Promise<string>;

export type AstToolRegistryOptions = {
  readonly executable?: string;
  readonly run?: AstGrepRunner;
  readonly forceKillDelayMs?: number;
};

function abortError(): Error {
  const error = new Error("The AST tool request was aborted.");
  error.name = "AbortError";
  return error;
}

function resolveWorkspaceTarget(cwd: string, requestedPath: string): string {
  if (path.isAbsolute(requestedPath)) {
    throw new Error(`Path escapes working directory: ${requestedPath}`);
  }
  const workspace = realpathSync(cwd);
  const candidate = path.resolve(workspace, requestedPath);
  const lexicalRelative = path.relative(workspace, candidate);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    throw new Error(`Path escapes working directory: ${requestedPath}`);
  }
  let target: string;
  try {
    target = realpathSync(candidate);
  } catch {
    throw new Error(`Path does not exist or is not accessible in the workspace: ${requestedPath}`);
  }
  const relative = path.relative(workspace, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes working directory: ${requestedPath}`);
  }
  return relative || ".";
}

function requiredString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function optionalLanguage(input: Record<string, unknown>): string | undefined {
  if (input.lang === undefined) return undefined;
  if (typeof input.lang !== "string" || input.lang.trim().length === 0) {
    throw new Error("lang must be a non-empty string");
  }
  return input.lang.trim();
}
function optionalPath(input: Record<string, unknown>): string {
  if (input.path === undefined) return ".";
  if (typeof input.path !== "string" || input.path.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  return input.path;
}


function resolveLimit(input: Record<string, unknown>): number {
  if (input.limit === undefined) return DEFAULT_MATCH_LIMIT;
  if (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_MATCH_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_MATCH_LIMIT}`);
  }
  return input.limit;
}
function resolveTimeout(input: Record<string, unknown>): number {
  if (input.timeout_ms === undefined) return DEFAULT_TIMEOUT_MS;
  if (
    typeof input.timeout_ms !== "number"
    || !Number.isInteger(input.timeout_ms)
    || input.timeout_ms < 100
    || input.timeout_ms > MAX_TIMEOUT_MS
  ) {
    throw new Error(`timeout_ms must be an integer between 100 and ${MAX_TIMEOUT_MS}`);
  }
  return input.timeout_ms;
}


function parseMatches(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("ast-grep returned a non-array JSON payload");
  }
  return parsed;
}

function runAstGrep(
  executable: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  forceKillDelayMs = 2_000,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(abortError());
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(executable, [...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const processGroup = createOwnedProcessGroupController({
    child,
    label: "ast-grep",
    forceKillDelayMs,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let stderrBytes = 0;
  let stderrTruncated = false;
  let settled = false;
  let requestedFailure: Error | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (signal) signal.removeEventListener("abort", onAbort);
  };

  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };

  const requestTermination = (error: Error) => {
    requestedFailure ??= error;
    void processGroup.terminate().catch(() => undefined);
  };
  const onAbort = () => requestTermination(abortError());
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  timeoutTimer = setTimeout(() => {
    requestTermination(new Error(`ast-grep timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timeoutTimer.unref();

  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      requestTermination(new Error(`ast-grep output exceeded ${MAX_OUTPUT_BYTES} bytes`));
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const remaining = MAX_STDERR_BYTES - stderrBytes;
    if (remaining <= 0) {
      stderrTruncated = true;
      return;
    }
    const bounded = chunk.subarray(0, remaining);
    stderr.push(bounded);
    stderrBytes += bounded.length;
    if (bounded.length < chunk.length) stderrTruncated = true;
  });
  child.once("error", (error) => {
    requestedFailure ??= error;
    if (!child.pid) fail(error);
  });
  child.once("close", (code, terminatedBySignal) => {
    if (settled) return;
    settled = true;
    void (async () => {
      try {
        await (requestedFailure ? processGroup.terminate() : processGroup.settle());
        if (requestedFailure) {
          reject(requestedFailure);
          return;
        }
        const output = Buffer.concat(stdout).toString("utf8");
        if (code === 0 || (code === 1 && output.trim() === "[]")) {
          resolve(output);
          return;
        }
        const rawDetail = Buffer.concat(stderr).toString("utf8").trim();
        const detail = `${rawDetail}${stderrTruncated ? " [stderr truncated]" : ""}`.trim();
        const status = terminatedBySignal ? `signal ${terminatedBySignal}` : `exit ${code ?? "unknown"}`;
        reject(new Error(`ast-grep failed (${status})${detail ? `: ${detail}` : ""}`));
      } catch (error) {
        reject(error);
      } finally {
        cleanup();
      }
    })();
  });
  return promise;
}

export const astToolDefinitions: readonly ToolDefinition[] = [
  {
    name: "ast_search",
    description: "Search source code by AST structure with ast-grep; metavariables such as $A match syntax nodes.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "ast-grep structural pattern." },
        path: { type: "string", description: "Relative file or directory path; defaults to the workspace." },
        lang: { type: "string", description: "Optional ast-grep language id, such as ts, rust, or python." },
        limit: { type: "integer", minimum: 1, maximum: MAX_MATCH_LIMIT, description: "Maximum matches to return." },
        timeout_ms: { type: "integer", minimum: 100, maximum: MAX_TIMEOUT_MS, description: "Maximum ast-grep runtime in milliseconds." },
      },
      required: ["pattern"],
    },
    metadata: {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        riskLevel: "low",
      },
      resources: [{ kind: "workspace", mode: "read", template: "workspace:{path:-.}", declared: true }],
    },
  },
  {
    name: "ast_rewrite",
    description: "Preview or apply an ast-grep structural rewrite inside the workspace. apply defaults to false.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "ast-grep structural pattern." },
        rewrite: { type: "string", description: "Replacement template using captured metavariables." },
        path: { type: "string", description: "Relative file or directory path; defaults to the workspace." },
        lang: { type: "string", description: "Optional ast-grep language id." },
        limit: { type: "integer", minimum: 1, maximum: MAX_MATCH_LIMIT, description: "Maximum proposals to return and the safety cap for apply mode." },
        timeout_ms: { type: "integer", minimum: 100, maximum: MAX_TIMEOUT_MS, description: "Maximum ast-grep runtime in milliseconds." },
        apply: { type: "boolean", description: "Apply rewrites only when the proposal count does not exceed limit." },
      },
      required: ["pattern", "rewrite"],
    },
    metadata: {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        riskLevel: "high",
        requiresConfirmation: true,
        reason: "Structural rewrites modify every matching syntax node in the selected path.",
      },
      resources: [{ kind: "workspace", mode: "write", template: "workspace:{path:-.}", declared: true }],
    },
  },
];

export function createAstToolRegistry(options: AstToolRegistryOptions = {}): ToolRegistry {
  const executable = options.executable ?? (process.env.UNCLECODE_AST_GREP?.trim() || "ast-grep");
  const runner = options.run
    ?? ((args, cwd, signal, timeoutMs) => runAstGrep(
      executable,
      args,
      cwd,
      signal,
      timeoutMs,
      options.forceKillDelayMs,
    ));

  const astSearch: ToolHandler = async (input, cwd, handlerOptions = {}) => {
    const pattern = requiredString(input, "pattern");
    const target = resolveWorkspaceTarget(cwd, optionalPath(input));
    const lang = optionalLanguage(input);
    const limit = resolveLimit(input);
    const timeoutMs = resolveTimeout(input);
    const args = ["run", "--pattern", pattern, "--json"];
    if (lang) args.push("--lang", lang);
    args.push(target);
    const matches = parseMatches(await runner(args, cwd, handlerOptions.signal, timeoutMs));
    return {
      content: JSON.stringify({ matches: matches.slice(0, limit), count: matches.length, truncated: matches.length > limit }),
    };
  };

  const astRewrite: ToolHandler = async (input, cwd, handlerOptions = {}) => {
    const pattern = requiredString(input, "pattern");
    const rewrite = requiredString(input, "rewrite");
    const target = resolveWorkspaceTarget(cwd, optionalPath(input));
    const lang = optionalLanguage(input);
    const limit = resolveLimit(input);
    const timeoutMs = resolveTimeout(input);
    const apply = input.apply === true;
    const previewArgs = ["run", "--pattern", pattern, "--rewrite", rewrite, "--json"];
    if (lang) previewArgs.push("--lang", lang);
    previewArgs.push(target);
    const previewMatches = parseMatches(await runner(previewArgs, cwd, handlerOptions.signal, timeoutMs));
    if (!apply) {
      return {
        content: JSON.stringify({
          applied: false,
          matches: previewMatches.slice(0, limit),
          count: previewMatches.length,
          truncated: previewMatches.length > limit,
        }),
      };
    }
    if (previewMatches.length > limit) {
      throw new Error(`ast_rewrite found ${previewMatches.length} matches, exceeding the apply limit of ${limit}`);
    }
    if (previewMatches.length === 0) {
      return { content: JSON.stringify({ applied: true, matches: [], count: 0, truncated: false }) };
    }
    const applyArgs = ["run", "--pattern", pattern, "--rewrite", rewrite];
    if (lang) applyArgs.push("--lang", lang);
    applyArgs.push("--update-all", target);
    await runner(applyArgs, cwd, handlerOptions.signal, timeoutMs);
    return {
      content: JSON.stringify({
        applied: true,
        matches: previewMatches,
        count: previewMatches.length,
        truncated: false,
      }),
    };
  };

  return {
    definitions: astToolDefinitions,
    handlers: { ast_search: astSearch, ast_rewrite: astRewrite },
  };
}
