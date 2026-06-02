import { runRustCommandSync } from "./rust-command.js";

export type WorkShellReasoningSupport =
  | {
      readonly status: "supported";
      readonly supportedEfforts: readonly string[];
    }
  | {
      readonly status: "unsupported";
      readonly supportedEfforts: readonly [];
    };

export type WorkShellReasoningConfig = {
  readonly effort: string;
  readonly source: string;
  readonly support: WorkShellReasoningSupport;
};

export function describeReasoning(reasoning: WorkShellReasoningConfig): string {
  if (reasoning.support.status === "unsupported") {
    return "unsupported";
  }

  return `${reasoning.effort} (${reasoning.source})`;
}

export function resolveReasoningCommand<Reasoning extends WorkShellReasoningConfig>(
  input: string,
  reasoning: Reasoning,
  modeDefault: Reasoning,
): { nextReasoning: Reasoning; message: string } {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "reasoning-command"],
      process.cwd(),
      JSON.stringify({
        input,
        currentReasoning: reasoning,
        modeDefaultReasoning: modeDefault,
      }),
    ),
  ) as unknown;
  if (!isReasoningCommandResult(parsed)) {
    throw new Error("Rust reasoning command returned an invalid payload.");
  }

  return {
    nextReasoning: parsed.nextReasoning as Reasoning,
    message: parsed.message,
  };
}

function isReasoningCommandResult(value: unknown): value is {
  nextReasoning: WorkShellReasoningConfig;
  message: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { nextReasoning?: unknown; message?: unknown };
  return typeof candidate.message === "string" && isReasoningConfig(candidate.nextReasoning);
}

function isReasoningConfig(value: unknown): value is WorkShellReasoningConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { effort?: unknown; source?: unknown; support?: unknown };
  return (
    typeof candidate.effort === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.support === "object" &&
    candidate.support !== null
  );
}
