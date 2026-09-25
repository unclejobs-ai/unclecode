/**
 * A pending decision (tool approval or a user question) as the pi shell shows
 * it. While one is pending the engine ignores ordinary submits; answers go
 * through `answerPendingDecisionByIndex` / `submitPendingDecisionText` /
 * `cancelPendingDecision` with the decision's id, as in the Ink decision bar.
 */
export type PiShellDecision = {
  readonly id: string;
  readonly kind: string;
  readonly title: string | undefined;
  readonly questions: readonly {
    readonly question: string;
    readonly options: readonly string[];
    readonly recommended: number | undefined;
  }[];
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

/** Reads `state.agentConsole.pendingDecision`; anything malformed is no decision. */
export function readPiShellDecision(agentConsole: unknown): PiShellDecision | undefined {
  const pending = isRecord(agentConsole) ? agentConsole.pendingDecision : undefined;
  if (!isRecord(pending) || typeof pending.id !== "string" || !Array.isArray(pending.questions)) return undefined;
  const questions = pending.questions.flatMap((question) => {
    if (!isRecord(question) || typeof question.question !== "string" || !Array.isArray(question.options)) return [];
    return [{
      question: question.question,
      options: question.options.flatMap((option) =>
        isRecord(option) && typeof option.label === "string" ? [option.label] : []),
      recommended: typeof question.recommended === "number" ? question.recommended : undefined,
    }];
  });
  if (questions.length === 0) return undefined;
  return {
    id: pending.id,
    kind: typeof pending.kind === "string" ? pending.kind : "user-decision",
    title: typeof pending.title === "string" ? pending.title : undefined,
    questions,
  };
}

/** One-key answers exist only for a single question, as the engine's index answer requires. */
export function piDecisionOptionCount(decision: PiShellDecision): number {
  return decision.questions.length === 1 ? decision.questions[0]?.options.length ?? 0 : 0;
}

export function formatPiDecisionRows(decision: PiShellDecision): readonly string[] {
  const oneKey = piDecisionOptionCount(decision) > 0;
  const rows: string[] = [];
  for (const question of decision.questions) {
    rows.push(question.question);
    question.options.forEach((label, index) => {
      const recommended = question.recommended === index ? "  (recommended)" : "";
      rows.push(`  ${oneKey ? `${index + 1}.` : "·"} ${label}${recommended}`);
    });
  }
  rows.push("", oneKey ? "1-9 choose · type an answer + Enter · Esc cancel" : "type an answer + Enter · Esc cancel");
  return rows;
}
