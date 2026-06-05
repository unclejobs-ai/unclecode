import { runRustCommandSync } from "./rust-command.js";

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
  return parseRustStringField(
    runPromptTurnRust("summary-prompt", { value }),
    "summary",
  );
}

export function summarizeWorkShellText(value: string): string {
  return parseRustStringField(
    runPromptTurnRust("summary-text", { value }),
    "summary",
  );
}

export function createChatPromptTurnInput<Attachment>(input: {
  line: string;
  composer: {
    prompt: string;
    transcriptText: string;
    attachments: readonly Attachment[];
  };
}): WorkShellPromptTurnInput<Attachment> {
  return parseRustPromptTurnInput<Attachment>(
    runPromptTurnRust("chat-input", input),
  );
}

export function createPromptCommandTurnInput(input: {
  transcriptText: string;
  prompt: string;
  promptCommand: WorkShellPromptCommand;
}): WorkShellPromptTurnInput<never> {
  return parseRustPromptTurnInput<never>(
    runPromptTurnRust("prompt-command-input", input),
  );
}

export function createConversationTurnSummary(input: {
  transcriptText: string;
  assistantText: string;
}): string {
  return parseRustStringField(
    runPromptTurnRust("conversation-summary", input),
    "summary",
  );
}

export function detectEditIntent(text: string): boolean {
  return parseRustBooleanField(runPromptTurnRust("edit-intent", { text }), "detected");
}

export function resolveReadOnlyModeGuard(input: {
  mode: string;
  prompt: string;
}): string | undefined {
  return parseRustOptionalStringField(
    runPromptTurnRust("read-only-guard", input),
    "message",
  );
}

export function detectPermissionSeekingStall(text: string): boolean {
  return parseRustBooleanField(runPromptTurnRust("permission-stall", { text }), "detected");
}

export function stripPermissionSeekingStallOutro(text: string): string {
  return parseRustStringField(runPromptTurnRust("permission-stall", { text }), "cleaned");
}

export function sanitizeWorkShellAssistantText(value: string): string {
  const withoutInternalPlan = stripLeadingInternalActionPlan(value);
  const withoutExactDuplicate = collapseExactAdjacentDuplicateText(withoutInternalPlan);
  return collapseRepeatedGreetingVariants(withoutExactDuplicate);
}

function stripLeadingInternalActionPlan(value: string): string {
  const leadingWhitespaceLength = value.length - value.trimStart().length;
  const trimmedStart = value.slice(leadingWhitespaceLength);
  const firstCharacter = trimmedStart.at(0);
  if (firstCharacter !== "[" && firstCharacter !== "{") {
    return value;
  }

  const jsonEndIndex = findBalancedJsonPrefixEnd(trimmedStart);
  if (jsonEndIndex === undefined) {
    return value;
  }

  const jsonPrefix = trimmedStart.slice(0, jsonEndIndex);
  try {
    const parsed = JSON.parse(jsonPrefix) as unknown;
    if (!looksLikeInternalActionPlan(parsed)) {
      return value;
    }
    const remainder = trimmedStart.slice(jsonEndIndex).trimStart();
    if (!looksLikeInternalPlanLeakRemainder(remainder)) {
      return value;
    }
    return remainder;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return value;
  }
}

function looksLikeInternalPlanLeakRemainder(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  return /^(?:Hi|Hello|Hey)[!.]?\s/i.test(value) || /^(?:안녕|반갑)/.test(value);
}

function findBalancedJsonPrefixEnd(value: string): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return undefined;
}

function looksLikeInternalActionPlan(value: unknown): boolean {
  const planItems = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.tasks)
      ? value.tasks
      : undefined;
  return Array.isArray(planItems) && planItems.length > 0 && planItems.every(looksLikeInternalActionPlanItem);
}

function looksLikeInternalActionPlanItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.summary === "string" &&
    typeof value.prompt === "string"
  );
}

function collapseExactAdjacentDuplicateText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length % 2 !== 0) {
    return value;
  }
  const midpoint = trimmed.length / 2;
  const firstHalf = trimmed.slice(0, midpoint);
  if (firstHalf === trimmed.slice(midpoint)) {
    return firstHalf;
  }
  return value;
}

function collapseRepeatedGreetingVariants(value: string): string {
  const hasStreamingCursor = value.endsWith("▌");
  const text = hasStreamingCursor ? value.slice(0, -1) : value;
  const greetingPattern = /(?:Hi|Hello|Hey)[!.]?\s+/g;
  const matches = [...text.matchAll(greetingPattern)];
  if (matches.length < 2 || text.length > 320) {
    return value;
  }
  const hasMalformedBoundary = matches.slice(1).some((match) => {
    const start = match.index ?? 0;
    const previous = text[start - 1] ?? "";
    return previous.length > 0 && !/[\s.!?。！？]/.test(previous);
  });
  if (!hasMalformedBoundary && !/next\?\s+i help/i.test(text)) {
    return value;
  }

  const candidates = matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    return text.slice(start, end).trim();
  }).filter((candidate) => candidate.length > 0);
  const bestCandidate = candidates
    .map((candidate) => ({ candidate, score: scoreGreetingCandidate(candidate) }))
    .sort((left, right) => right.score - left.score)[0]?.candidate;
  if (!bestCandidate) {
    return value;
  }

  const punctuated = /[.!?]$/.test(bestCandidate)
    ? bestCandidate
    : `${bestCandidate}?`;
  return hasStreamingCursor ? `${punctuated}▌` : punctuated;
}

function scoreGreetingCandidate(candidate: string): number {
  let score = 0;
  if (/what can i help/i.test(candidate)) score += 6;
  if (/how can i help/i.test(candidate)) score += 5;
  if (/what would you like help/i.test(candidate)) score += 5;
  if (/\bhelp\b/i.test(candidate)) score += 2;
  if (/[.!?]$/.test(candidate)) score += 1;
  if (/next\?\s+i help/i.test(candidate)) score -= 4;
  return score;
}


export function buildPermissionStallContinuePrompt(originalPrompt: string, previousAnswer: string): string {
  return parseRustStringField(
    runPromptTurnRust("continue-prompt", { originalPrompt, previousAnswer }),
    "prompt",
  );
}

export async function finalizeWorkShellAssistantReply(input: {
  prompt: string;
  assistantText: string;
  autoContinueOnPermissionStall?: boolean | undefined;
  runTurn: (prompt: string) => Promise<{ text: string }>;
}): Promise<string> {
  const sanitizedAssistantText = sanitizeWorkShellAssistantText(input.assistantText);
  const cleanedAssistantText = stripPermissionSeekingStallOutro(sanitizedAssistantText) || "(empty response)";
  if (!input.autoContinueOnPermissionStall || !detectPermissionSeekingStall(input.assistantText)) {
    return cleanedAssistantText;
  }

  const followUp = await input.runTurn(
    buildPermissionStallContinuePrompt(input.prompt, cleanedAssistantText),
  );
  const continuedText = stripPermissionSeekingStallOutro(
    sanitizeWorkShellAssistantText(followUp.text || ""),
  ).trim();
  return continuedText || cleanedAssistantText;
}

function runPromptTurnRust(operation: string, input: unknown): string {
  return runRustCommandSync(
    ["rust", "ux", "prompt-turn", operation],
    process.cwd(),
    JSON.stringify(input),
  );
}

function parseRustPromptTurnInput<Attachment>(raw: string): WorkShellPromptTurnInput<Attachment> {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed) ||
    typeof parsed.transcriptText !== "string" ||
    typeof parsed.prompt !== "string" ||
    typeof parsed.sessionSummary !== "string" ||
    typeof parsed.failureSummary !== "string"
  ) {
    throw new Error("Rust prompt turn command returned an invalid payload.");
  }
  const result: WorkShellPromptTurnInput<Attachment> = {
    transcriptText: parsed.transcriptText,
    prompt: parsed.prompt,
    sessionSummary: parsed.sessionSummary,
    failureSummary: parsed.failureSummary,
  };
  if (Array.isArray(parsed.attachments)) {
    return { ...result, attachments: parsed.attachments as readonly Attachment[] };
  }
  return result;
}

function parseRustStringField(raw: string, field: string): string {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed[field] !== "string") {
    throw new Error(`Rust prompt turn command returned an invalid ${field} payload.`);
  }
  return parsed[field];
}

function parseRustOptionalStringField(raw: string, field: string): string | undefined {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Rust prompt turn command returned an invalid ${field} payload.`);
  }
  const value = parsed[field];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Rust prompt turn command returned an invalid ${field} payload.`);
  }
  return value;
}

function parseRustBooleanField(raw: string, field: string): boolean {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed[field] !== "boolean") {
    throw new Error(`Rust prompt turn command returned an invalid ${field} payload.`);
  }
  return parsed[field];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
