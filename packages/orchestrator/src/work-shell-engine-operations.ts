import {
  buildAuthProgressPanelLines,
  resolveVisibleInlineCommand,
} from "./work-shell-engine-commands.js";

export async function resolveSecureApiKeyEntrySubmission(input: {
  line: string;
  currentAuthLabel: string;
  saveApiKeyAuth?: ((raw: string) => Promise<readonly string[]>) | undefined;
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  extractAuthLabel?: ((lines: readonly string[]) => string | undefined) | undefined;
  applyAuthIssueLines: (authIssueLines?: readonly string[]) => void;
  formatWorkShellError: (message: string) => string;
}): Promise<
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "success";
      readonly resultLines: readonly string[];
      readonly nextAuthLabel: string;
    }
  | { readonly kind: "error"; readonly message: string }
> {
  if (!input.saveApiKeyAuth) {
    return { kind: "unavailable" };
  }

  try {
    const resultLines = await input.saveApiKeyAuth(input.line);
    let nextAuthLabel = input.extractAuthLabel?.(resultLines) ?? input.currentAuthLabel;
    if (input.refreshAuthState) {
      try {
        const refreshed = await input.refreshAuthState();
        nextAuthLabel = refreshed.authLabel;
        input.applyAuthIssueLines(refreshed.authIssueLines);
      } catch {
        nextAuthLabel = input.extractAuthLabel?.(resultLines) ?? input.currentAuthLabel;
      }
    }

    return {
      kind: "success",
      resultLines,
      nextAuthLabel,
    };
  } catch (error) {
    return {
      kind: "error",
      message: input.formatWorkShellError(error instanceof Error ? error.message : String(error)),
    };
  }
}

export async function resolveInlineOperationalCommandResult(input: {
  line: string;
  slashCommand: readonly string[];
  currentAuthLabel: string;
  resolveWorkShellInlineCommand: (
    args: readonly string[],
    runInlineCommand: (
      args: readonly string[],
      onProgress?: ((line: string) => void) | undefined,
    ) => Promise<readonly string[]>,
    onProgress?: ((line: string) => void) | undefined,
  ) => Promise<{ readonly lines: readonly string[]; readonly failed: boolean }>;
  runInlineCommand: (args: readonly string[]) => Promise<readonly string[]>;
  refineInlineCommandResultLines?: ((input: {
    args: readonly string[];
    lines: readonly string[];
    failed: boolean;
    authLabel: string;
  }) => readonly string[]) | undefined;
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  extractAuthLabel?: ((lines: readonly string[]) => string | undefined) | undefined;
  applyAuthIssueLines: (authIssueLines?: readonly string[]) => void;
  onAuthProgressLines?: ((lines: readonly string[]) => void) | undefined;
}): Promise<{
  readonly visibleLine: string;
  readonly visibleArgs: readonly string[];
  readonly resultLines: readonly string[];
  readonly completionLine: string;
  readonly nextAuthLabel: string;
  readonly isAuthCommand: boolean;
}> {
  const { visibleLine, visibleArgs, isAuthCommand, isAuthLogin } = resolveVisibleInlineCommand({
    line: input.line,
    slashCommand: input.slashCommand,
  });

  const authProgressLines: string[] = [];
  const commandResult = await input.resolveWorkShellInlineCommand(
    input.slashCommand,
    input.runInlineCommand,
    isAuthLogin
      ? (line) => {
          authProgressLines.push(line);
          input.onAuthProgressLines?.(buildAuthProgressPanelLines(authProgressLines));
        }
      : undefined,
  );
  const resultLines = input.refineInlineCommandResultLines
    ? input.refineInlineCommandResultLines({
        args: input.slashCommand,
        lines: commandResult.lines,
        failed: commandResult.failed,
        authLabel: input.currentAuthLabel,
      })
    : commandResult.lines;

  let nextAuthLabel = input.extractAuthLabel?.(resultLines) ?? input.currentAuthLabel;
  if (isAuthCommand && input.refreshAuthState) {
    try {
      const refreshed = await input.refreshAuthState();
      nextAuthLabel = refreshed.authLabel;
      input.applyAuthIssueLines(refreshed.authIssueLines);
    } catch {
      nextAuthLabel = input.extractAuthLabel?.(resultLines) ?? input.currentAuthLabel;
    }
  }

  return {
    visibleLine,
    visibleArgs,
    resultLines,
    completionLine: `${commandResult.failed ? "✖" : "✓"} ${visibleArgs.join(" ")}`,
    nextAuthLabel,
    isAuthCommand,
  };
}
