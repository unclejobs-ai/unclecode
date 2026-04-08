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
  const [, rawCommand] = input.trim().split(/\s+/, 2);

  if (reasoning.support.status === "unsupported") {
    return {
      nextReasoning: reasoning,
      message: "Reasoning controls are visible, but this model does not support them.",
    };
  }

  if (!rawCommand) {
    return {
      nextReasoning: reasoning,
      message: `Reasoning is ${reasoning.effort}. Supported: ${reasoning.support.supportedEfforts.join(", ")}.`,
    };
  }

  if (rawCommand === "default") {
    return {
      nextReasoning: modeDefault,
      message: `Reasoning reset to ${modeDefault.effort}.`,
    };
  }

  if (!reasoning.support.supportedEfforts.includes(rawCommand)) {
    return {
      nextReasoning: reasoning,
      message: `Unsupported reasoning value: ${rawCommand}. Use one of ${reasoning.support.supportedEfforts.join(", ")} or default.`,
    };
  }

  return {
    nextReasoning: {
      ...reasoning,
      effort: rawCommand,
      source: "override",
    } as Reasoning,
    message: `Reasoning set to ${rawCommand}.`,
  };
}
