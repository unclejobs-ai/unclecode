import type {
  ExecutionPolicyEvaluation,
  ExecutionPolicyCapability,
  ExecutionPolicyProfile,
  ExecutionPolicyRule,
  MiniLoopAction,
  MiniLoopMessage,
  MiniLoopObservation,
  PersonaId,
  PolicyDeniedTraceEvent,
} from "@unclecode/contracts";
import type {
  LlmProvider,
  ProviderQueryMessage,
  ToolDefinition,
} from "@unclecode/providers";

import { MiniLoopAgent, type MiniLoopModelClient } from "./mini-loop-agent.js";
import { getPersonaConfig } from "./personas/index.js";
import type { TeamBinding } from "./team-binding.js";
import { runShell } from "./aci/run-shell.js";
import { runRustCommand } from "./rust-command.js";

export type TeamMiniLoopExecutor = {
  execute(
    action: MiniLoopAction,
    cwd: string,
  ): Promise<MiniLoopObservation>;
};

type TeamMiniLoopPolicyRequestBase = {
  readonly cwd: string;
  readonly runtimeMode: string;
};

export type TeamMiniLoopPolicyRequest =
  | (TeamMiniLoopPolicyRequestBase & {
      readonly capability: "shell.run";
      readonly tool: "run_shell";
      readonly command: string;
    })
  | (TeamMiniLoopPolicyRequestBase & {
      readonly capability: "filesystem.read";
      readonly tool: "read_file";
      readonly path: string;
    })
  | (TeamMiniLoopPolicyRequestBase & {
      readonly capability: "filesystem.read";
      readonly tool: "search_text";
      readonly path: string;
      readonly query: string;
    })
  | (TeamMiniLoopPolicyRequestBase & {
      readonly capability: "filesystem.read";
      readonly tool: "list_files";
      readonly pattern: string;
    })
  | (TeamMiniLoopPolicyRequestBase & {
      readonly capability: "filesystem.write";
      readonly tool: "write_file";
      readonly path: string;
    })
  | (TeamMiniLoopPolicyRequestBase & {
      readonly capability: "filesystem.write";
      readonly tool: "apply_patch";
      readonly patchLength: number;
    });

export type TeamMiniLoopPolicyEvaluator = (
  request: TeamMiniLoopPolicyRequest,
) => ExecutionPolicyEvaluation | undefined;

export type TeamMiniLoopExecutorOptions = {
  readonly runtimeMode?: string;
  readonly evaluatePolicy?: TeamMiniLoopPolicyEvaluator;
  readonly onPolicyDenied?: (event: PolicyDeniedTraceEvent) => void;
};

export const TEAM_LOCAL_AUDIT_EXECUTION_POLICY_PROFILE: ExecutionPolicyProfile = {
  id: "team.local.audit",
  mode: "audit",
  defaultEffect: "allow",
  rules: [],
};

export function createTeamRuntimeExecutionPolicyProfile(
  runtimeMode: string,
): ExecutionPolicyProfile {
  if (runtimeMode === "local") {
    return TEAM_LOCAL_AUDIT_EXECUTION_POLICY_PROFILE;
  }
  return {
    id: `team.${runtimeMode}.default-deny`,
    mode: "enforce",
    defaultEffect: "deny",
    rules: [],
  };
}

export function createTeamMiniLoopPolicyEvaluator(
  profile: ExecutionPolicyProfile,
): TeamMiniLoopPolicyEvaluator {
  return (request) => evaluateTeamMiniLoopPolicy(profile, request);
}

function evaluateTeamMiniLoopPolicy(
  profile: ExecutionPolicyProfile,
  request: TeamMiniLoopPolicyRequest,
): ExecutionPolicyEvaluation {
  const matchedRule = profile.rules.find((rule) => ruleMatchesTeamMiniLoopRequest(rule, request));
  const rawEffect = matchedRule?.effect ?? profile.defaultEffect;
  const auditOnly = profile.mode === "audit" && rawEffect !== "allow";
  return {
    capability: request.capability,
    effect: profile.mode === "audit" ? "allow" : rawEffect,
    source: matchedRule?.match?.runtimeMode ? "runtime" : "base",
    reason: auditOnly
      ? `Audit only: ${matchedRule?.reason ?? `Default ${rawEffect} for ${request.capability}.`}`
      : matchedRule?.reason ?? `Default ${rawEffect} for ${request.capability}.`,
    matchedRule: matchedRule?.id ?? `${profile.id}.${request.capability}.default`,
    auditOnly,
  };
}

function ruleMatchesTeamMiniLoopRequest(
  rule: ExecutionPolicyRule,
  request: TeamMiniLoopPolicyRequest,
): boolean {
  if (rule.capability !== request.capability) {
    return false;
  }
  const match = rule.match;
  if (!match) {
    return true;
  }
  if (match.runtimeMode !== undefined && match.runtimeMode !== request.runtimeMode) {
    return false;
  }
  if (match.pathPrefix !== undefined) {
    const path = getPolicyRequestPath(request);
    if (path === undefined || !pathMatchesPrefix(path, match.pathPrefix)) {
      return false;
    }
  }
  if (match.commandPrefix !== undefined) {
    if (request.tool !== "run_shell" || !commandMatchesPrefix(request.command, match.commandPrefix)) {
      return false;
    }
  }
  return true;
}

function getPolicyRequestPath(request: TeamMiniLoopPolicyRequest): string | undefined {
  switch (request.tool) {
    case "read_file":
    case "search_text":
    case "write_file":
      return request.path;
    case "list_files":
      return request.pattern;
    case "run_shell":
    case "apply_patch":
      return undefined;
  }
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  const normalizedPath = normalizePolicyPath(path);
  const normalizedPrefix = normalizePolicyPath(prefix);
  if (normalizedPath === undefined || normalizedPrefix === undefined) {
    return false;
  }
  if (normalizedPrefix === "" || normalizedPrefix === ".") {
    return true;
  }
  return normalizedPath === normalizedPrefix
    || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function commandMatchesPrefix(command: string, prefix: string): boolean {
  const normalizedCommand = command.trimStart();
  const normalizedPrefix = prefix.trim();
  if (normalizedPrefix === "") {
    return true;
  }
  if (normalizedCommand === normalizedPrefix) {
    return true;
  }
  return normalizedCommand.startsWith(`${normalizedPrefix} `)
    || normalizedCommand.startsWith(`${normalizedPrefix}\t`);
}

function normalizePolicyPath(value: string): string | undefined {
  const parts: string[] = [];
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (parts.length === 0) {
        return undefined;
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

export function createTeamMiniLoopExecutor(
  options: TeamMiniLoopExecutorOptions = {},
): TeamMiniLoopExecutor {
  const runtimeMode = options.runtimeMode ?? "local";
  const normalizedOptions: TeamMiniLoopExecutorOptions = {
    ...options,
    runtimeMode,
    evaluatePolicy: options.evaluatePolicy
      ?? createTeamMiniLoopPolicyEvaluator(createTeamRuntimeExecutionPolicyProfile(runtimeMode)),
  };
  return {
    async execute(action, cwd) {
      try {
        switch (action.tool) {
          case "run_shell":
            return await dispatchRunShell(action, cwd, normalizedOptions);
          case "read_file":
            return await dispatchReadFile(action, cwd, normalizedOptions);
          case "write_file":
            return await dispatchWriteFile(action, cwd, normalizedOptions);
          case "search_text":
            return await dispatchSearchText(action, cwd, normalizedOptions);
          case "list_files":
            return await dispatchListFiles(action, cwd, normalizedOptions);
          case "apply_patch":
            return await dispatchApplyPatch(action, cwd, normalizedOptions);
          default:
            return errorObservation(`Unknown tool: ${action.tool}`);
        }
      } catch (error) {
        return errorObservation(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

function emitPolicyDenied(
  options: TeamMiniLoopExecutorOptions,
  input: {
    readonly capability: ExecutionPolicyCapability;
    readonly effect: ExecutionPolicyEvaluation["effect"];
    readonly runtimeMode: string;
    readonly toolName: string;
    readonly reason: string;
    readonly matchedRule: string;
    readonly source: ExecutionPolicyEvaluation["source"];
  },
): void {
  options.onPolicyDenied?.({
    type: "policy.denied",
    level: "high-signal",
    capability: input.capability,
    effect: input.effect,
    runtimeMode: input.runtimeMode,
    toolName: input.toolName,
    reason: input.reason,
    matchedRule: input.matchedRule,
    source: input.source,
    startedAt: Date.now(),
  });
}

function blockedByPolicyObservation(
  options: TeamMiniLoopExecutorOptions,
  input: {
    readonly capability: ExecutionPolicyCapability;
    readonly runtimeMode: string;
    readonly toolName: string;
    readonly decision: ExecutionPolicyEvaluation;
  },
): MiniLoopObservation {
  emitPolicyDenied(options, {
    capability: input.capability,
    effect: input.decision.effect,
    runtimeMode: input.runtimeMode,
    toolName: input.toolName,
    reason: input.decision.reason,
    matchedRule: input.decision.matchedRule,
    source: input.decision.source,
  });
  return errorObservation(`policy denied ${input.capability}: ${input.decision.reason}`);
}

function errorObservation(message: string): MiniLoopObservation {
  return { stdout: "", stderr: message, exitCode: -1, truncated: false };
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

async function runRustAci(args: readonly string[], cwd: string, stdin?: string): Promise<string> {
  return await runRustCommand(["rust", "aci", ...args], cwd, stdin);
}

async function dispatchRunShell(
  action: MiniLoopAction,
  cwd: string,
  options: TeamMiniLoopExecutorOptions,
): Promise<MiniLoopObservation> {
  const command = readString(action.input, "command");
  const runtimeMode = options.runtimeMode ?? "local";
  const policyDecision = options.evaluatePolicy?.({
    capability: "shell.run",
    tool: "run_shell",
    command,
    cwd,
    runtimeMode,
  });
  if (policyDecision !== undefined && policyDecision.effect !== "allow") {
    return blockedByPolicyObservation(options, {
      capability: "shell.run",
      runtimeMode,
      toolName: "run_shell",
      decision: policyDecision,
    });
  }
  const result = await runShell({ command, cwd });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    truncated: result.truncated,
  };
}

async function dispatchReadFile(
  action: MiniLoopAction,
  cwd: string,
  options: TeamMiniLoopExecutorOptions,
): Promise<MiniLoopObservation> {
  const path = readString(action.input, "path");
  if (path.length === 0) {
    return errorObservation("read_file: missing path");
  }
  const runtimeMode = options.runtimeMode ?? "local";
  const policyDecision = options.evaluatePolicy?.({
    capability: "filesystem.read",
    tool: "read_file",
    path,
    cwd,
    runtimeMode,
  });
  if (policyDecision !== undefined && policyDecision.effect !== "allow") {
    return blockedByPolicyObservation(options, {
      capability: "filesystem.read",
      runtimeMode,
      toolName: "read_file",
      decision: policyDecision,
    });
  }
  const windowRaw = action.input.window;
  const windowSize = typeof windowRaw === "number" && windowRaw > 0
    ? Math.floor(windowRaw)
    : undefined;
  const stdout = await runRustAci(
    windowSize !== undefined ? ["view", path, String(windowSize)] : ["view", path],
    cwd,
  );
  const totalMatch = stdout.match(/^\[Total\] (\d+) lines$/m);
  const windowMatch = stdout.match(/^\[Window\] lines \d+-(\d+) /m);
  const totalLines = Number.parseInt(totalMatch?.[1] ?? "0", 10);
  const windowEnd = Number.parseInt(windowMatch?.[1] ?? "0", 10);
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    truncated: totalLines > windowEnd,
  };
}

async function dispatchWriteFile(
  action: MiniLoopAction,
  cwd: string,
  options: TeamMiniLoopExecutorOptions,
): Promise<MiniLoopObservation> {
  const path = readString(action.input, "path");
  if (path.length === 0) {
    return errorObservation("write_file: missing path");
  }
  const runtimeMode = options.runtimeMode ?? "local";
  const policyDecision = options.evaluatePolicy?.({
    capability: "filesystem.write",
    tool: "write_file",
    path,
    cwd,
    runtimeMode,
  });
  if (policyDecision !== undefined && policyDecision.effect !== "allow") {
    return blockedByPolicyObservation(options, {
      capability: "filesystem.write",
      runtimeMode,
      toolName: "write_file",
      decision: policyDecision,
    });
  }
  const contents = readString(action.input, "contents");
  await runRustAci(["write", path], cwd, contents);
  return {
    stdout: `wrote ${contents.length} bytes to ${path}`,
    stderr: "",
    exitCode: 0,
    truncated: false,
  };
}

async function dispatchSearchText(
  action: MiniLoopAction,
  cwd: string,
  options: TeamMiniLoopExecutorOptions,
): Promise<MiniLoopObservation> {
  const query = readString(action.input, "query");
  if (query.length === 0) {
    return errorObservation("search_text: missing query");
  }
  const path = readString(action.input, "path");
  const runtimeMode = options.runtimeMode ?? "local";
  const policyDecision = options.evaluatePolicy?.({
    capability: "filesystem.read",
    tool: "search_text",
    path: path.length > 0 ? path : ".",
    query,
    cwd,
    runtimeMode,
  });
  if (policyDecision !== undefined && policyDecision.effect !== "allow") {
    return blockedByPolicyObservation(options, {
      capability: "filesystem.read",
      runtimeMode,
      toolName: "search_text",
      decision: policyDecision,
    });
  }
  const stdout = await runRustAci(path.length > 0 ? ["search", query, path] : ["search", query], cwd);
  return {
    stdout: stdout.trimEnd(),
    stderr: "",
    exitCode: 0,
    truncated: stdout.includes(" total hits; refine query"),
  };
}

async function dispatchListFiles(
  action: MiniLoopAction,
  cwd: string,
  options: TeamMiniLoopExecutorOptions,
): Promise<MiniLoopObservation> {
  const pattern = readString(action.input, "pattern") || "**/*";
  const runtimeMode = options.runtimeMode ?? "local";
  const policyDecision = options.evaluatePolicy?.({
    capability: "filesystem.read",
    tool: "list_files",
    pattern,
    cwd,
    runtimeMode,
  });
  if (policyDecision !== undefined && policyDecision.effect !== "allow") {
    return blockedByPolicyObservation(options, {
      capability: "filesystem.read",
      runtimeMode,
      toolName: "list_files",
      decision: policyDecision,
    });
  }
  const stdout = await runRustAci(["glob", pattern], cwd);
  return {
    stdout: stdout.trimEnd(),
    stderr: "",
    exitCode: 0,
    truncated: stdout.includes(" total hits; tighten pattern"),
  };
}

type RustApplyPatchResult = {
  readonly applied: readonly { readonly path: string; readonly hunkCount: number }[];
  readonly rejected: readonly { readonly path: string; readonly hunkIndex: number; readonly reason: string }[];
};

async function dispatchApplyPatch(
  action: MiniLoopAction,
  cwd: string,
  options: TeamMiniLoopExecutorOptions,
): Promise<MiniLoopObservation> {
  const patch = readString(action.input, "patch");
  if (patch.length === 0) {
    return errorObservation("apply_patch: missing patch");
  }
  const runtimeMode = options.runtimeMode ?? "local";
  const policyDecision = options.evaluatePolicy?.({
    capability: "filesystem.write",
    tool: "apply_patch",
    patchLength: patch.length,
    cwd,
    runtimeMode,
  });
  if (policyDecision !== undefined && policyDecision.effect !== "allow") {
    return blockedByPolicyObservation(options, {
      capability: "filesystem.write",
      runtimeMode,
      toolName: "apply_patch",
      decision: policyDecision,
    });
  }
  const parsed = JSON.parse(await runRustAci(["apply-patch"], cwd, patch)) as unknown;
  if (!isRustApplyPatchResult(parsed)) {
    return errorObservation("apply_patch: invalid Rust result");
  }
  const result = parsed;
  const appliedSummary = result.applied
    .map((entry) => `${entry.path} (${entry.hunkCount} hunks)`)
    .join("\n");
  const rejectedSummary = result.rejected
    .map(
      (entry) => `${entry.path}@hunk${entry.hunkIndex}: ${entry.reason}`,
    )
    .join("\n");
  return {
    stdout: appliedSummary,
    stderr: rejectedSummary,
    exitCode: result.rejected.length === 0 ? 0 : 1,
    truncated: false,
  };
}

function isRustApplyPatchResult(value: unknown): value is RustApplyPatchResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { applied?: unknown; rejected?: unknown };
  return Array.isArray(candidate.applied)
    && Array.isArray(candidate.rejected)
    && candidate.applied.every((entry) => {
      const item = entry as { path?: unknown; hunkCount?: unknown };
      return typeof item.path === "string" && typeof item.hunkCount === "number";
    })
    && candidate.rejected.every((entry) => {
      const item = entry as { path?: unknown; hunkIndex?: unknown; reason?: unknown };
      return typeof item.path === "string"
        && typeof item.hunkIndex === "number"
        && typeof item.reason === "string";
    });
}

export function miniLoopMessagesToProviderQuery(
  messages: ReadonlyArray<MiniLoopMessage>,
): ProviderQueryMessage[] {
  const out: ProviderQueryMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (!message) {
      i += 1;
      continue;
    }
    if (message.role === "exit") {
      i += 1;
      continue;
    }
    if (message.role === "system" || message.role === "user") {
      out.push({ role: message.role, content: message.content });
      i += 1;
      continue;
    }
    if (message.role === "assistant") {
      const toolMessages: Array<{ message: MiniLoopMessage; index: number }> = [];
      let scan = i + 1;
      while (scan < messages.length) {
        const next = messages[scan];
        if (!next) {
          break;
        }
        if (next.role !== "tool") {
          break;
        }
        if (
          message.stepIndex !== undefined
          && next.stepIndex !== undefined
          && next.stepIndex !== message.stepIndex
        ) {
          break;
        }
        toolMessages.push({ message: next, index: toolMessages.length });
        scan += 1;
      }
      const stepIdx = message.stepIndex ?? out.length;
      const toolCalls = toolMessages
        .filter((entry) => entry.message.action !== undefined)
        .map((entry) => {
          const action = entry.message.action!;
          return {
            callId: `step_${stepIdx}_${entry.index}`,
            name: action.tool,
            argumentsJson: JSON.stringify(action.input ?? {}),
          };
        });
      if (toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: message.content,
          toolCalls,
        });
        for (const entry of toolMessages) {
          out.push({
            role: "tool",
            content: entry.message.content,
            callId: `step_${stepIdx}_${entry.index}`,
          });
        }
        i = scan;
      } else {
        out.push({ role: "assistant", content: message.content });
        i += 1;
      }
      continue;
    }
    if (message.role === "tool") {
      // Orphan tool message (no preceding assistant). Render as user
      // observation so the model sees the data.
      out.push({
        role: "user",
        content: message.content,
      });
      i += 1;
      continue;
    }
    i += 1;
  }
  return out;
}

export const TEAM_RUN_SHELL_TOOL: ToolDefinition = {
  name: "run_shell",
  description:
    "Run a shell command in the worker workspace. Returns combined stdout/stderr and the exit code.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute via /bin/sh -c.",
      },
    },
    required: ["command"],
  },
};

export const TEAM_READ_FILE_TOOL: ToolDefinition = {
  name: "read_file",
  description:
    "Open a workspace-relative file and return a numbered window of lines.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative file path.",
      },
      window: {
        type: "number",
        description: "Visible line window size (default 100).",
      },
    },
    required: ["path"],
  },
};

export const TEAM_WRITE_FILE_TOOL: ToolDefinition = {
  name: "write_file",
  description:
    "Overwrite (or create) a workspace-relative file with the given contents.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative file path.",
      },
      contents: {
        type: "string",
        description: "Full file contents to write (UTF-8).",
      },
    },
    required: ["path", "contents"],
  },
};

export const TEAM_SEARCH_TEXT_TOOL: ToolDefinition = {
  name: "search_text",
  description:
    "Search the workspace for a pattern with ripgrep; returns at most 50 path:line:text hits.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Regex or fixed string to search for." },
      path: {
        type: "string",
        description: "Workspace-relative subdirectory to scope the search (optional).",
      },
    },
    required: ["query"],
  },
};

export const TEAM_LIST_FILES_TOOL: ToolDefinition = {
  name: "list_files",
  description:
    "List workspace files matching the given glob pattern (default '**/*').",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern (e.g. 'src/**/*.ts').",
      },
    },
  },
};

export const TEAM_APPLY_PATCH_TOOL: ToolDefinition = {
  name: "apply_patch",
  description:
    "Apply a unified diff to the workspace. Reports applied and rejected hunks.",
  input_schema: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description: "Unified diff (multi-file) to apply.",
      },
    },
    required: ["patch"],
  },
};

export const TEAM_DEFAULT_TOOLS: ReadonlyArray<ToolDefinition> = [
  TEAM_RUN_SHELL_TOOL,
  TEAM_READ_FILE_TOOL,
  TEAM_WRITE_FILE_TOOL,
  TEAM_SEARCH_TEXT_TOOL,
  TEAM_LIST_FILES_TOOL,
  TEAM_APPLY_PATCH_TOOL,
];

export type RunTeamMiniLoopArgs = {
  readonly workerId: string;
  readonly persona: PersonaId;
  readonly task: string;
  readonly binding: TeamBinding;
  readonly provider: LlmProvider;
  readonly cwd: string;
  readonly runtimeMode?: string;
  readonly executionPolicyProfile?: ExecutionPolicyProfile;
  readonly onPolicyDenied?: (event: PolicyDeniedTraceEvent) => void;
  readonly tools?: readonly ToolDefinition[];
};

export type RunTeamMiniLoopResult = {
  readonly status: "submitted" | "limits_exceeded" | "halted" | "errored";
  readonly submission: string;
  readonly steps: number;
  readonly costUsd: number;
};

/**
 * Drive a MiniLoopAgent against the given LlmProvider, publishing one
 * `team_step` per executed action. Pure wiring — no env, no process I/O —
 * so tests and the CLI entrypoint can both call it.
 */
export async function runTeamMiniLoop(
  args: RunTeamMiniLoopArgs,
): Promise<RunTeamMiniLoopResult> {
  if (typeof args.provider.query !== "function") {
    throw new Error(
      "team worker: provider does not implement the stateless query() contract",
    );
  }
  const config = getPersonaConfig(args.persona);
  const runtimeMode = args.runtimeMode ?? "local";
  const executionPolicyProfile = args.executionPolicyProfile
    ?? createTeamRuntimeExecutionPolicyProfile(runtimeMode);
  const deniedPolicyEvents: PolicyDeniedTraceEvent[] = [];
  const executor = createTeamMiniLoopExecutor({
    runtimeMode,
    evaluatePolicy: createTeamMiniLoopPolicyEvaluator(executionPolicyProfile),
    onPolicyDenied(event) {
      deniedPolicyEvents.push(event);
      args.onPolicyDenied?.(event);
    },
  });
  const tools = args.tools ?? TEAM_DEFAULT_TOOLS;
  const query = args.provider.query.bind(args.provider);

  const modelClient: MiniLoopModelClient = {
    async query(messages: ReadonlyArray<MiniLoopMessage>) {
      const wireMessages = miniLoopMessagesToProviderQuery(messages);
      const response = await query(wireMessages, { tools });
      return {
        content: response.content,
        actions: response.actions.map((action) => ({
          tool: action.tool,
          input: action.input,
        })),
        costUsd: response.costUsd,
      };
    },
  };

  const agent = new MiniLoopAgent({
    config,
    executor,
    model: modelClient,
    cwd: args.cwd,
    hooks: {
      onAfterStep: async (ctx, action, observation) => {
        const argHash = await rustSha256(JSON.stringify(action.input ?? {}), args.cwd);
        const observationHash = await rustSha256(`${observation.stdout}${observation.stderr}`, args.cwd);
        const policyDenied = deniedPolicyEvents.shift();
        args.binding.publish({
          type: "team_step",
          runId: args.binding.runId,
          workerId: args.workerId,
          stepIndex: ctx.stepIndex,
          action: { tool: action.tool, argHash },
          ...(policyDenied
            ? {
                policy: {
                  capability: policyDenied.capability,
                  effect: policyDenied.effect,
                  source: policyDenied.source,
                  reason: policyDenied.reason,
                  matchedRule: policyDenied.matchedRule,
                  runtimeMode: policyDenied.runtimeMode,
                  ...(policyDenied.toolName !== undefined ? { toolName: policyDenied.toolName } : {}),
                },
              }
            : {}),
          observationHash,
          timestamp: new Date().toISOString(),
        });
        return { kind: "continue" };
      },
    },
  });

  const result = await agent.run(args.task);
  return {
    status: result.status,
    submission: result.submission,
    steps: result.steps,
    costUsd: result.costUsd,
  };
}

async function rustSha256(input: string, cwd: string): Promise<string> {
  return (await runRustCommand(["rust", "sha256"], cwd, input)).trim();
}
