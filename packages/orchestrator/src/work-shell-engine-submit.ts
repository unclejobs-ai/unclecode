import {
  resolvePromptSlashCommand,
  resolveWorkShellBuiltinCommand,
  resolveWorkShellLocalCommand,
} from "./work-shell-engine-commands.js";
import type {
  ResolvedWorkShellBuiltinCommand,
  ResolvedWorkShellLocalCommand,
} from "./work-shell-engine-commands.js";
import type { WorkShellComposerMode } from "./work-shell-engine.js";
import type { WorkShellPromptCommand } from "./work-shell-engine-turns.js";

export type WorkShellSubmitRoute =
  | { readonly kind: "secure-api-key-entry"; readonly line: string }
  | { readonly kind: "builtin"; readonly line: string; readonly command: ResolvedWorkShellBuiltinCommand }
  | { readonly kind: "prompt-command"; readonly line: string; readonly promptCommand: WorkShellPromptCommand }
  | { readonly kind: "inline-command"; readonly line: string; readonly slashCommand: readonly string[] }
  | { readonly kind: "local-command"; readonly line: string; readonly localCommand: ResolvedWorkShellLocalCommand }
  | { readonly kind: "chat"; readonly line: string };

export function resolveWorkShellSubmitRoute(input: {
  value: string;
  isBusy: boolean;
  composerMode: WorkShellComposerMode;
  resolveWorkShellSlashCommand: (input: string) => readonly string[] | undefined;
  hasInlineCommandRunner: boolean;
}): WorkShellSubmitRoute | undefined {
  const line = input.value.trim();
  if (!line || input.isBusy) {
    return undefined;
  }

  if (input.composerMode === "api-key-entry") {
    return { kind: "secure-api-key-entry", line };
  }

  const builtinCommand = resolveWorkShellBuiltinCommand(line);
  if (builtinCommand) {
    return { kind: "builtin", line, command: builtinCommand };
  }

  const slashCommand = input.resolveWorkShellSlashCommand(line);
  const promptCommand = resolvePromptSlashCommand(slashCommand);
  if (promptCommand) {
    return { kind: "prompt-command", line, promptCommand };
  }
  if (slashCommand && input.hasInlineCommandRunner) {
    return { kind: "inline-command", line, slashCommand };
  }

  const localCommand = resolveWorkShellLocalCommand(line);
  if (localCommand) {
    return { kind: "local-command", line, localCommand };
  }

  return { kind: "chat", line };
}
