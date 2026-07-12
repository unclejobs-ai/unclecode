/**
 * Codex CLI adapter — spawns `codex exec --json` and parses the NDJSON
 * event stream. Submission is the content of the last `agent_message`
 * event, falling back to raw stdout when no JSON events parse.
 *
 * Tests inject `executor` + `which`.
 */

import type { WorkerSpec } from "@unclecode/contracts";

import type { LaneAdapter, LanePreflight, LaneRunContext, LaneRunResult } from "./lane-adapter.js";
import { defaultCliExecutor, defaultWhich, type CliExecutor, type WhichFn } from "./cli-exec.js";
import { applySystemPrefix } from "./system-prefix.js";

const CODEX_LANE_ID = "codex" as const;
const CODEX_BINARY = "codex";
const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

export type CreateCodexCliAdapterArgs = {
  readonly executor?: CliExecutor;
  readonly which?: WhichFn;
  readonly binary?: string;
};

type CodexEvent = {
  readonly type?: string;
  readonly content?: string;
};

function parseLastAgentMessage(stdout: string): string | null {
  let lastAgentMessage: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as CodexEvent;
      if (parsed.type === "agent_message" && typeof parsed.content === "string") {
        lastAgentMessage = parsed.content;
      }
    } catch {
      // non-JSON line — skip; falls back to raw stdout below if nothing parsed
    }
  }
  return lastAgentMessage;
}

export function createCodexCliAdapter(args: CreateCodexCliAdapterArgs = {}): LaneAdapter {
  const executor = args.executor ?? defaultCliExecutor;
  const which = args.which ?? defaultWhich;
  const binary = args.binary ?? CODEX_BINARY;

  return {
    id: CODEX_LANE_ID,
    preflight(_env): LanePreflight {
      if (which(binary) === null) {
        return {
          status: "missing",
          reason: `codex lane requires \`${binary}\` on PATH (npm i -g @openai/codex or equivalent)`,
        };
      }
      return { status: "ok" };
    },
    async run(spec: WorkerSpec, ctx: LaneRunContext): Promise<LaneRunResult> {
      if (which(binary) === null) {
        throw new Error(
          `codex lane requires \`${binary}\` on PATH — refusing to dispatch worker ${spec.workerId}`,
        );
      }
      const model = spec.model?.trim() || CODEX_DEFAULT_MODEL;
      const prompt = applySystemPrefix(ctx.systemPrompt, spec.task);
      const cliArgs: string[] = ["exec", "--json", "--model", model, prompt];

      const execOptions: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number } = {
        cwd: ctx.cwd,
        env: ctx.env as NodeJS.ProcessEnv,
      };
      if (ctx.timeoutMs !== undefined) {
        execOptions.timeoutMs = ctx.timeoutMs;
      }
      const result = await executor(binary, cliArgs, execOptions);

      if (result.timedOut) {
        throw new Error(`codex lane worker ${spec.workerId} timed out after ${ctx.timeoutMs}ms`);
      }

      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
        return { ok: false, submission: detail };
      }

      const parsed = parseLastAgentMessage(result.stdout);
      const submission = parsed ?? result.stdout.trim();
      // exit=0 with empty stdout = false success: codex emitted no events.
      // Most plausible cause is misconfiguration (auth/model). Surface it.
      if (submission.length === 0) {
        return {
          ok: false,
          submission: `codex exec exited 0 but produced no output${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
        };
      }
      return { ok: true, submission };
    },
  };
}
