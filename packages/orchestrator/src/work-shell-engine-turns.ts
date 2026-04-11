export type WorkShellPromptCommand = {
  readonly kind: "review" | "commit";
  readonly focus?: string;
};

export type WorkShellPromptTurnInput<Attachment> = {
  transcriptText: string;
  prompt: string;
  sessionSummary: string;
  failureSummary: string;
  attachments?: readonly Attachment[];
};

export function summarizeWorkShellPrompt(value: string): string {
  return value.length > 52 ? `${value.slice(0, 49)}...` : value;
}

export function summarizeWorkShellText(value: string): string {
  return value.length > 72 ? `${value.slice(0, 69)}...` : value;
}

export function createChatPromptTurnInput<Attachment>(input: {
  line: string;
  composer: {
    prompt: string;
    transcriptText: string;
    attachments: readonly Attachment[];
  };
}): WorkShellPromptTurnInput<Attachment> {
  return {
    transcriptText: input.composer.transcriptText,
    prompt: input.composer.prompt,
    attachments: input.composer.attachments,
    sessionSummary: `Chat: ${summarizeWorkShellPrompt(input.composer.prompt)}`,
    failureSummary: `Chat failed: ${summarizeWorkShellPrompt(input.line)}`,
  };
}

export function createPromptCommandTurnInput(input: {
  transcriptText: string;
  prompt: string;
  promptCommand: WorkShellPromptCommand;
}): WorkShellPromptTurnInput<never> {
  const label = input.promptCommand.kind === "review" ? "Review" : "Commit draft";
  const focus = input.promptCommand.focus ?? "current changes";
  return {
    transcriptText: input.transcriptText,
    prompt: input.prompt,
    sessionSummary: `${label}: ${summarizeWorkShellPrompt(focus)}`,
    failureSummary: `${label} failed: ${summarizeWorkShellPrompt(input.promptCommand.focus ?? input.transcriptText)}`,
  };
}

export function createConversationTurnSummary(input: {
  transcriptText: string;
  assistantText: string;
}): string {
  return summarizeWorkShellText(`Q: ${input.transcriptText} · A: ${input.assistantText}`);
}

const EDIT_INTENT_PATTERNS = [
  /\b(edit|modify|change|update|fix|patch|implement|add|remove|delete|refactor|rewrite|create)\b/i,
  /(수정|변경|고쳐|구현|추가|삭제|리팩터|리팩토|바꿔|만들어|넣어|보강)/,
];

export function detectEditIntent(text: string): boolean {
  const normalized = text.trim();
  return normalized.length > 0 && EDIT_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function resolveReadOnlyModeGuard(input: {
  mode: string;
  prompt: string;
}): string | undefined {
  if (input.mode === "search" && detectEditIntent(input.prompt)) {
    return "Search mode is read-only. Shift+Tab or run /mode set yolo, then resend the edit request.";
  }
  return undefined;
}

const PERMISSION_STALL_PATTERNS = [
  /^(?:if you want|if you'd like|if you want me to|if you'd like me to)\b/i,
  /^(?:let me know|tell me) if you (?:want|would like)\b/i,
  /^(?:i can|i could) (?:continue|keep going|also continue|also keep going|take another pass|handle the rest|do the rest|clean up the remaining)\b/i,
  /^happy to (?:continue|keep going|take another pass)\b/i,
  /(?:계속|진행|이어서).*(?:할까요|할게요|하겠습니다|해도 될까요)/,
  /(?:원하시면|원한다면|필요하시면).*(?:진행|계속|수정)/,
];

function splitReplyParagraphs(text: string): readonly string[] {
  return text
    .trim()
    .split(/\n\s*\n/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function splitReplySentences(text: string): readonly string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function isPermissionSeekingSegment(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length > 0 && PERMISSION_STALL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function detectPermissionSeekingStall(text: string): boolean {
  const paragraphs = splitReplyParagraphs(text);
  const lastParagraph = paragraphs.at(-1);
  if (!lastParagraph) {
    return false;
  }
  if (isPermissionSeekingSegment(lastParagraph)) {
    return true;
  }

  const sentences = splitReplySentences(lastParagraph);
  return sentences.length > 1 && isPermissionSeekingSegment(sentences.at(-1) ?? "");
}

export function stripPermissionSeekingStallOutro(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return normalized;
  }

  const paragraphs = splitReplyParagraphs(normalized);
  const lastParagraph = paragraphs.at(-1);
  if (!lastParagraph) {
    return normalized;
  }
  if (paragraphs.length > 1 && isPermissionSeekingSegment(lastParagraph)) {
    return paragraphs.slice(0, -1).join("\n\n").trim();
  }

  const sentences = splitReplySentences(lastParagraph);
  if (sentences.length > 1 && isPermissionSeekingSegment(sentences.at(-1) ?? "")) {
    const trimmedParagraph = sentences.slice(0, -1).join(" ").trim();
    return [...paragraphs.slice(0, -1), trimmedParagraph]
      .filter((segment) => segment.length > 0)
      .join("\n\n")
      .trim();
  }

  return normalized;
}

export function buildPermissionStallContinuePrompt(originalPrompt: string, previousAnswer: string): string {
  return [
    "Continue automatically without asking for permission.",
    'Do not say "if you want", "if you\'d like", or "let me know".',
    "Perform the next concrete pass now and report the completed work plus verification.",
    `Original request: ${originalPrompt}`,
    previousAnswer ? `Previous partial answer:\n${previousAnswer}` : "",
  ]
    .filter((segment) => segment.length > 0)
    .join("\n\n");
}

export async function finalizeWorkShellAssistantReply(input: {
  prompt: string;
  assistantText: string;
  autoContinueOnPermissionStall?: boolean | undefined;
  runTurn: (prompt: string) => Promise<{ text: string }>;
}): Promise<string> {
  const cleanedAssistantText = stripPermissionSeekingStallOutro(input.assistantText) || "(empty response)";
  if (!input.autoContinueOnPermissionStall || !detectPermissionSeekingStall(input.assistantText)) {
    return cleanedAssistantText;
  }

  const followUp = await input.runTurn(
    buildPermissionStallContinuePrompt(input.prompt, cleanedAssistantText),
  );
  const continuedText = stripPermissionSeekingStallOutro(followUp.text || "").trim();
  return continuedText || cleanedAssistantText;
}
