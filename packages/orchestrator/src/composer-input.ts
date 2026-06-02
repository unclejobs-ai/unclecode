import type { ClipboardImageAttachment } from "@unclecode/contracts";

import { runRustCommand } from "./rust-command.js";
import type { WorkShellComposerResolution } from "./work-shell-engine.js";

/**
 * Composer-side image attachment payload. Aliased to the canonical
 * ClipboardImageAttachment from @unclecode/contracts so that the
 * composer text-path resolver, the clipboard capture utility, and the
 * provider adapters all consume the identical shape.
 */
export type WorkShellComposerImageAttachment = ClipboardImageAttachment;

function isImageAttachment(value: unknown): value is WorkShellComposerImageAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<WorkShellComposerImageAttachment>;
  return candidate.type === "image"
    && typeof candidate.mimeType === "string"
    && typeof candidate.dataUrl === "string"
    && typeof candidate.path === "string"
    && typeof candidate.displayName === "string";
}

function parseComposerResolution(raw: string): WorkShellComposerResolution<WorkShellComposerImageAttachment> {
  const parsed = JSON.parse(raw) as Partial<WorkShellComposerResolution<unknown>>;
  if (
    typeof parsed.prompt !== "string"
    || !Array.isArray(parsed.attachments)
    || !parsed.attachments.every(isImageAttachment)
    || typeof parsed.transcriptText !== "string"
  ) {
    throw new Error("Rust composer resolver returned an invalid payload");
  }

  return {
    prompt: parsed.prompt,
    attachments: parsed.attachments,
    transcriptText: parsed.transcriptText,
  };
}

export async function resolveComposerInput(
  value: string,
  cwd: string,
): Promise<WorkShellComposerResolution<WorkShellComposerImageAttachment>> {
  const raw = await runRustCommand(["rust", "composer", "resolve", cwd], cwd, value);
  return parseComposerResolution(raw);
}
