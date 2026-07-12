import type {
  AskUserQuestion,
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from "@unclecode/contracts";

export type WorkShellDecisionReply =
  | { readonly kind: "answered"; readonly result: AskUserQuestionResult }
  | { readonly kind: "cancelled" }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * Resolves a compact composer reply without giving free-form input a second
 * route into the tool protocol. One question accepts `1` or an option label.
 * Multiple questions require `question-id: 1,2; other-question: 2`.
 */
export function resolveWorkShellDecisionReply(input: {
  readonly request: AskUserQuestionRequest;
  readonly value: string;
}): WorkShellDecisionReply {
  const value = input.value.trim();
  if (value === "/cancel") {
    return { kind: "cancelled" };
  }
  if (value.length === 0) {
    return { kind: "invalid", message: "Choose an option or enter /cancel." };
  }

  const answerTexts = input.request.questions.length === 1
    ? new Map([[input.request.questions[0]?.id ?? "", value]])
    : parseMultipleQuestionReplies(value, input.request.questions);
  if (!answerTexts) {
    return {
      kind: "invalid",
      message: "Answer each question as question-id: option-number; then separate answers with ;.",
    };
  }

  const answers: AskUserQuestionAnswer[] = [];
  for (const question of input.request.questions) {
    const answerText = answerTexts.get(question.id);
    if (!answerText) {
      return { kind: "invalid", message: `Choose an option for ${question.id}.` };
    }
    const answer = parseQuestionAnswer(question, answerText);
    if (!answer) {
      const countHint = question.multi ? "one or more comma-separated options" : "one option";
      return { kind: "invalid", message: `Choose ${countHint} for ${question.id}.` };
    }
    answers.push(answer);
  }

  return { kind: "answered", result: { status: "answered", answers } };
}

export function formatWorkShellDecisionLines(request: AskUserQuestionRequest): readonly string[] {
  const header = request.title?.trim() || "Decision required";
  const lines = [header];
  for (const question of request.questions) {
    lines.push(`Question · ${question.id}: ${question.question}`);
    lines.push(...question.options.map((option, index) => {
      const detail = option.description ? ` — ${option.description}` : "";
      const recommended = question.recommended === index ? " (recommended)" : "";
      return `${index + 1}. ${option.label}${detail}${recommended}`;
    }));
  }
  lines.push(
    request.questions.length === 1
      ? "Reply with an option number or label · /cancel cancels"
      : "Reply question-id: option-number; question-id: option-number · /cancel cancels",
  );
  return lines;
}

function parseMultipleQuestionReplies(
  value: string,
  questions: readonly AskUserQuestion[],
): Map<string, string> | undefined {
  const answers = new Map<string, string>();
  for (const segment of value.split(";")) {
    const separator = segment.indexOf(":");
    if (separator === -1) {
      return undefined;
    }
    const questionId = segment.slice(0, separator).trim();
    const answer = segment.slice(separator + 1).trim();
    if (!questions.some((question) => question.id === questionId) || answer.length === 0 || answers.has(questionId)) {
      return undefined;
    }
    answers.set(questionId, answer);
  }
  return answers;
}

function parseQuestionAnswer(
  question: AskUserQuestion,
  value: string,
): AskUserQuestionAnswer | undefined {
  const rawSelections = question.multi ? value.split(",") : [value];
  if (!question.multi && rawSelections.length !== 1) {
    return undefined;
  }

  const selectedOptions: string[] = [];
  for (const rawSelection of rawSelections) {
    const selection = rawSelection.trim();
    const numericIndex = Number(selection);
    const option = Number.isSafeInteger(numericIndex) && numericIndex >= 1
      ? question.options[numericIndex - 1]
      : question.options.find((candidate) => candidate.label.toLowerCase() === selection.toLowerCase());
    if (!option || selectedOptions.includes(option.label)) {
      return undefined;
    }
    selectedOptions.push(option.label);
  }

  return selectedOptions.length > 0
    ? { id: question.id, selectedOptions }
    : undefined;
}
