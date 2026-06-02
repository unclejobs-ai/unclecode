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
