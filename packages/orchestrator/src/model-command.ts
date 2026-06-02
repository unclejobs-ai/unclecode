import type { ProviderId } from "@unclecode/providers";

import type { WorkShellPanel } from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";
import { runRustCommandSync } from "./rust-command.js";

export function resolveModelCommand<Reasoning extends WorkShellReasoningConfig>(
  input: string,
  state: {
    provider: ProviderId;
    currentModel: string;
    currentReasoning: Reasoning;
    modeDefaultReasoning: Reasoning;
  },
): {
  nextModel: string;
  nextReasoning: Reasoning;
  message: string;
  panel: WorkShellPanel;
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "model-command"],
      process.cwd(),
      JSON.stringify({
        input,
        provider: state.provider,
        currentModel: state.currentModel,
        currentReasoning: state.currentReasoning,
        modeDefaultReasoning: state.modeDefaultReasoning,
      }),
    ),
  ) as unknown;
  if (!isModelCommandResult(parsed)) {
    throw new Error("Rust model command returned an invalid payload.");
  }
  return {
    nextModel: parsed.nextModel,
    nextReasoning: parsed.nextReasoning as Reasoning,
    message: parsed.message,
    panel: parsed.panel,
  };
}

function isModelCommandResult(value: unknown): value is {
  nextModel: string;
  nextReasoning: WorkShellReasoningConfig;
  message: string;
  panel: WorkShellPanel;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    nextModel?: unknown;
    nextReasoning?: unknown;
    message?: unknown;
    panel?: unknown;
  };
  return (
    typeof candidate.nextModel === "string" &&
    typeof candidate.message === "string" &&
    isReasoningConfig(candidate.nextReasoning) &&
    isWorkShellPanel(candidate.panel)
  );
}

function isReasoningConfig(value: unknown): value is WorkShellReasoningConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { effort?: unknown; source?: unknown; support?: unknown };
  return typeof candidate.effort === "string" && typeof candidate.source === "string" && typeof candidate.support === "object" && candidate.support !== null;
}

function isWorkShellPanel(value: unknown): value is WorkShellPanel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { title?: unknown; lines?: unknown };
  return typeof candidate.title === "string" && Array.isArray(candidate.lines) && candidate.lines.every((line) => typeof line === "string");
}
