import {
  createWorkShellEngine,
  type CreateWorkShellEngineInput,
} from "./work-shell-engine-factory.js";
import {
  getWorkShellSlashSuggestions,
  shouldBlockSlashSubmit,
} from "./work-shell-slash.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";

export type WorkShellPaneRuntime<
  Attachment,
  Reasoning extends WorkShellReasoningConfig,
  TraceEvent extends { readonly type: string },
> = {
  readonly engine: ReturnType<
    typeof createWorkShellEngine<Attachment, Reasoning, TraceEvent>
  >;
  readonly browserOAuthAvailable: boolean;
  readonly getSuggestions: (
    value: string,
  ) => readonly { readonly command: string; readonly description: string }[];
  readonly shouldBlockSlashSubmit: (line: string) => boolean;
};

export function createWorkShellPaneRuntime<
  Attachment,
  Reasoning extends WorkShellReasoningConfig,
  TraceEvent extends { readonly type: string },
>(
  input: CreateWorkShellEngineInput<Attachment, Reasoning, TraceEvent>,
): WorkShellPaneRuntime<Attachment, Reasoning, TraceEvent> {
  const normalizedProvider = input.options.provider === "openai"
    ? "openai-api"
    : input.options.provider;

  const slashOptions = {
    workspaceRoot: input.options.cwd,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
    ...(
      normalizedProvider === "openai-api"
      || normalizedProvider === "openai-codex"
      || normalizedProvider === "anthropic"
      || normalizedProvider === "gemini"
        ? {
            provider: normalizedProvider as "openai-api" | "openai-codex" | "anthropic" | "gemini",
          }
        : {}
    ),
    currentModel: input.options.model,
  };

  return {
    engine: createWorkShellEngine(input),
    browserOAuthAvailable: Boolean(input.browserOAuthAvailable),
    getSuggestions: (value) =>
      getWorkShellSlashSuggestions(value, slashOptions),
    shouldBlockSlashSubmit: (line) =>
      shouldBlockSlashSubmit(line, slashOptions),
  };
}
