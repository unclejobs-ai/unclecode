/**
 * Team-worker glue between the stateless `LlmProvider.query` shape (in
 * `@unclecode/providers`) and the caller-managed MiniLoopAgent loop.
 *
 * - `teamMiniLoopExecutor` resolves a `MiniLoopAction` to its ACI
 *   helper (currently: run_shell only; file/patch/search tools land in
 *   later slices).
 * - `miniLoopMessagesToProviderQuery` translates the agent's message
 *   log into the provider's wire-bound shape, generating synthetic
 *   tool-call IDs so OpenAI accepts the assistant + tool message pair.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  MiniLoopAction,
  MiniLoopMessage,
  MiniLoopObservation,
  PersonaId,
} from "@unclecode/contracts";
import type {
  LlmProvider,
  ProviderQueryMessage,
  ToolDefinition,
} from "@unclecode/providers";

import { MiniLoopAgent, type MiniLoopModelClient } from "./mini-loop-agent.js";
import { getPersonaConfig } from "./personas/index.js";
import type { TeamBinding } from "./team-binding.js";
import { applyPatch } from "./aci/apply-patch.js";
import { openFile } from "./aci/file-viewer.js";
import {
  PathContainmentError,
  assertWithinWorkspace,
} from "./aci/path-containment.js";
import { glob } from "./aci/quick-tools.js";
import { runShell } from "./aci/run-shell.js";
import { searchDir } from "./aci/search.js";

export type TeamMiniLoopExecutor = {
  execute(
    action: MiniLoopAction,
    cwd: string,
  ): Promise<MiniLoopObservation>;
};

export function createTeamMiniLoopExecutor(): TeamMiniLoopExecutor {
  return {
    async execute(action, cwd) {
      try {
        switch (action.tool) {
          case "run_shell":
            return await dispatchRunShell(action, cwd);
          case "read_file":
            return dispatchReadFile(action, cwd);
          case "write_file":
            return dispatchWriteFile(action, cwd);
          case "search_text":
            return await dispatchSearchText(action, cwd);
          case "list_files":
            return await dispatchListFiles(action, cwd);
          case "apply_patch":
            return dispatchApplyPatch(action, cwd);
          default:
            return errorObservation(`Unknown tool: ${action.tool}`);
        }
      } catch (error) {
        if (error instanceof PathContainmentError) {
          return errorObservation(error.message);
        }
        return errorObservation(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

function errorObservation(message: string): MiniLoopObservation {
  return { stdout: "", stderr: message, exitCode: -1, truncated: false };
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

async function dispatchRunShell(
  action: MiniLoopAction,
  cwd: string,
): Promise<MiniLoopObservation> {
  const command = readString(action.input, "command");
  const result = await runShell({ command, cwd });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    truncated: result.truncated,
  };
}

function dispatchReadFile(
  action: MiniLoopAction,
  cwd: string,
): MiniLoopObservation {
  const path = readString(action.input, "path");
  if (path.length === 0) {
    return errorObservation("read_file: missing path");
  }
  const windowRaw = action.input.window;
  const windowSize = typeof windowRaw === "number" && windowRaw > 0
    ? Math.floor(windowRaw)
    : undefined;
  const result = openFile(
    windowSize !== undefined ? { cwd, path, window: windowSize } : { cwd, path },
  );
  return {
    stdout: result.content,
    stderr: "",
    exitCode: 0,
    truncated: result.state.totalLines > result.state.windowEnd,
  };
}

function dispatchWriteFile(
  action: MiniLoopAction,
  cwd: string,
): MiniLoopObservation {
  const path = readString(action.input, "path");
  if (path.length === 0) {
    return errorObservation("write_file: missing path");
  }
  const contents = readString(action.input, "contents");
  const absPath = assertWithinWorkspace(cwd, path, { allowMissing: true });
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents, "utf8");
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
): Promise<MiniLoopObservation> {
  const query = readString(action.input, "query");
  if (query.length === 0) {
    return errorObservation("search_text: missing query");
  }
  const path = readString(action.input, "path");
  const result = await searchDir({
    cwd,
    query,
    ...(path.length > 0 ? { path } : {}),
  });
  const lines = result.hits.map((hit) =>
    hit.line !== undefined && hit.text !== undefined
      ? `${hit.path}:${hit.line}:${hit.text}`
      : hit.path,
  );
  return {
    stdout: lines.join("\n"),
    stderr: "",
    exitCode: 0,
    truncated: result.truncated,
  };
}

async function dispatchListFiles(
  action: MiniLoopAction,
  cwd: string,
): Promise<MiniLoopObservation> {
  const pattern = readString(action.input, "pattern") || "**/*";
  const result = await glob({ cwd, pattern });
  return {
    stdout: result.hits.map((hit) => hit.path).join("\n"),
    stderr: "",
    exitCode: 0,
    truncated: result.truncated,
  };
}

function dispatchApplyPatch(
  action: MiniLoopAction,
  cwd: string,
): MiniLoopObservation {
  const patch = readString(action.input, "patch");
  if (patch.length === 0) {
    return errorObservation("apply_patch: missing patch");
  }
  const result = applyPatch({ cwd, patch });
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

/**
 * Convert MiniLoopAgent's message log into provider-wire messages.
 * - "exit" role messages (internal sentinels) are dropped.
 * - assistant messages followed by consecutive tool messages with the
 *   same `stepIndex` are paired into one `toolCalls[]`. Synthetic
 *   callIds derive from position so the same log always produces the
 *   same wire shape.
 */
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
  const executor = createTeamMiniLoopExecutor();
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
        const argHash = createHash("sha256")
          .update(JSON.stringify(action.input ?? {}))
          .digest("hex");
        const observationHash = createHash("sha256")
          .update(observation.stdout)
          .update(observation.stderr)
          .digest("hex");
        args.binding.publish({
          type: "team_step",
          runId: args.binding.runId,
          workerId: args.workerId,
          stepIndex: ctx.stepIndex,
          action: { tool: action.tool, argHash },
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
