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
  const engine = createWorkShellEngine(input);
  const slashOptions = {
    workspaceRoot: input.options.cwd,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
    ...(
      input.options.provider === "openai"
      || input.options.provider === "anthropic"
      || input.options.provider === "gemini"
      || input.options.provider === "deepseek"
        ? {
            provider: input.options.provider as "openai" | "anthropic" | "gemini" | "deepseek",
          }
        : {}
    ),
  };
  const slashOptionsWithCurrentModel = () => ({
    ...slashOptions,
    currentModel: engine.getState().model,
  });

  getWorkShellSlashSuggestions("/", slashOptionsWithCurrentModel());
  getWorkShellSlashSuggestions("/model", slashOptionsWithCurrentModel());

  return {
    engine,
    browserOAuthAvailable: Boolean(input.browserOAuthAvailable),
    getSuggestions: (value) =>
      getWorkShellSlashSuggestions(value, slashOptionsWithCurrentModel()),
    shouldBlockSlashSubmit: (line) =>
      shouldBlockSlashSubmit(line, slashOptionsWithCurrentModel()),
  };
}
