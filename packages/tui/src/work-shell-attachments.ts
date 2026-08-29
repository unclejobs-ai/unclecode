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
const ATTACHMENT_PREVIEW_CACHE_MAX_ENTRIES = 32;
const INLINE_SUPPORT_CACHE_MAX_ENTRIES = 16;

function cacheSet<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value as K);
}

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
  // Preview rendering uses labels only. Never duplicate multi-megabyte data URLs
  // in a process-wide cache key or send them through the Rust display helper.
  const key = JSON.stringify(attachments.map(({ displayName, mimeType }) => ({ displayName, mimeType })));
  const cached = attachmentPreviewCache.get(key);
  if (cached) {
    return cached;
  }
  const lines = JSON.parse(runRustUxText("attachment-preview", key)) as readonly string[];
  cacheSet(attachmentPreviewCache, key, lines, ATTACHMENT_PREVIEW_CACHE_MAX_ENTRIES);
  return lines;
}

export function formatInlineImageSupportLine(env: NodeJS.ProcessEnv = process.env): string {
  const key = envCacheKey(env);
  const cached = inlineSupportCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const line = runRustUxText("inline-image-support", undefined, terminalEnv(env));
  cacheSet(inlineSupportCache, key, line, INLINE_SUPPORT_CACHE_MAX_ENTRIES);
  return line;
}

export function formatAttachmentErrorLine(reason: string): string {
  return `Warning · ${reason.trim() || "Attachment could not be added."}`;
}

export function buildTerminalInlineImageSequence(
  attachment: WorkShellImageAttachment,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const sequence = runRustUxText("inline-image-sequence", JSON.stringify(attachment), terminalEnv(env));
  return sequence.length > 0 ? sequence : undefined;
}
