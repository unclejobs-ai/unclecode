import type { ClipboardImageAttachment } from "@unclecode/contracts";
import { runRustCommandSync } from "@unclecode/orchestrator";

/**
 * The TUI image attachment payload is structurally identical to the
 * canonical ClipboardImageAttachment exported from @unclecode/contracts.
 * Aliased so the TUI keeps its existing type name while the underlying
 * shape stays single-sourced for providers and the orchestrator clipboard
 * capture utility.
 */
export type WorkShellImageAttachment = ClipboardImageAttachment;

const attachmentPreviewCache = new Map<string, readonly string[]>();
const inlineSupportCache = new Map<string, string>();

function runRustUxText(operation: string, stdin?: string, env: NodeJS.ProcessEnv = process.env): string {
  return runRustCommandSync(["rust", "ux", "text", operation], process.cwd(), stdin, env).trimEnd();
}

function envCacheKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify({
    TERM: env.TERM,
    TERM_PROGRAM: env.TERM_PROGRAM,
    KITTY_WINDOW_ID: env.KITTY_WINDOW_ID,
  });
}

function terminalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    TERM: env.TERM ?? "",
    TERM_PROGRAM: env.TERM_PROGRAM ?? "",
    KITTY_WINDOW_ID: env.KITTY_WINDOW_ID ?? "",
  };
}

export function formatAttachmentBadgeLine(attachments: readonly WorkShellImageAttachment[]): string {
  return buildAttachmentPreviewLines(attachments)[0] ?? "Attachments 0 · ";
}

export function buildAttachmentPreviewLines(attachments: readonly WorkShellImageAttachment[]): readonly string[] {
  const key = JSON.stringify(attachments);
  const cached = attachmentPreviewCache.get(key);
  if (cached) {
    return cached;
  }
  const lines = JSON.parse(runRustUxText("attachment-preview", key)) as readonly string[];
  attachmentPreviewCache.set(key, lines);
  return lines;
}

export function formatInlineImageSupportLine(env: NodeJS.ProcessEnv = process.env): string {
  const key = envCacheKey(env);
  const cached = inlineSupportCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const line = runRustUxText("inline-image-support", undefined, terminalEnv(env));
  inlineSupportCache.set(key, line);
  return line;
}

export function buildTerminalInlineImageSequence(
  attachment: WorkShellImageAttachment,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const sequence = runRustUxText("inline-image-sequence", JSON.stringify(attachment), terminalEnv(env));
  return sequence.length > 0 ? sequence : undefined;
}
