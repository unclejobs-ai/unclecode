import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { runRustCommand } from "./rust-command.js";

export const QUEUE_ATTACHMENT_SCHEMA = "unclecode.queue-attachment.v1";

export type QueueAttachmentArtifact = {
  readonly ref: string;
  readonly schema: typeof QUEUE_ATTACHMENT_SCHEMA;
  readonly sha256: string;
  readonly size: number;
};

function safeFilePart(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "session";
}

function artifactRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, ".unclecode", "artifacts");
}

function resolveOwnedArtifact(workspaceRoot: string, reference: string): string {
  const root = artifactRoot(workspaceRoot);
  const absolute = path.resolve(workspaceRoot, reference);
  const relative = path.relative(root, absolute);
  if (
    reference.length === 0
    || path.isAbsolute(reference)
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`Queue attachment ref is outside UncleCode artifact ownership: ${reference}`);
  }
  return absolute;
}

function workspaceRelativeOwnedArtifact(workspaceRoot: string, reference: string): string {
  resolveOwnedArtifact(workspaceRoot, reference);
  return reference.split("/").join(path.sep);
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Persist the complete provider attachment payload before its queue envelope. */
export async function persistQueuedAttachments<Attachment>(
  workspaceRoot: string,
  sessionId: string,
  attachments: readonly Attachment[],
): Promise<readonly QueueAttachmentArtifact[]> {
  if (attachments.length === 0) return [];
  const relativeDirectory = path.join(
    ".unclecode",
    "artifacts",
    safeFilePart(sessionId),
    "queue-attachments",
  );
  const artifacts: QueueAttachmentArtifact[] = [];
  try {
    for (let index = 0; index < attachments.length; index += 1) {
      const filename = `${randomUUID()}-${index}.json`;
      const relative = path.join(relativeDirectory, filename).split(path.sep).join("/");
      const content = `${JSON.stringify(attachments[index])}\n`;
      await runRustCommand(
        ["rust", "aci", "write-atomic-no-symlinks", workspaceRelativeOwnedArtifact(workspaceRoot, relative)],
        workspaceRoot,
        content,
      );
      artifacts.push({
        ref: relative,
        schema: QUEUE_ATTACHMENT_SCHEMA,
        sha256: digest(content),
        size: Buffer.byteLength(content, "utf8"),
      });
    }
    return artifacts;
  } catch (error) {
    await deleteQueuedAttachmentArtifacts(workspaceRoot, artifacts.map((artifact) => artifact.ref));
    throw error;
  }
}

export async function restoreQueuedAttachments<Attachment>(
  workspaceRoot: string,
  artifacts: readonly QueueAttachmentArtifact[],
): Promise<readonly Attachment[]> {
  const attachments: Attachment[] = [];
  for (const artifact of artifacts) {
    if (artifact.schema !== QUEUE_ATTACHMENT_SCHEMA) {
      throw new Error(`Unsupported queue attachment schema: ${artifact.schema}`);
    }
    const content = await runRustCommand(
      ["rust", "aci", "read-no-symlinks", workspaceRelativeOwnedArtifact(workspaceRoot, artifact.ref)],
      workspaceRoot,
    );
    const actualSize = Buffer.byteLength(content, "utf8");
    const actualHash = digest(content);
    if (actualSize !== artifact.size || actualHash !== artifact.sha256) {
      throw new Error(
        `Queue attachment integrity mismatch for ${artifact.ref}: expected ${artifact.sha256}/${artifact.size}, got ${actualHash}/${actualSize}`,
      );
    }
    attachments.push(JSON.parse(content) as Attachment);
  }
  return attachments;
}

export async function deleteQueuedAttachmentArtifacts(
  workspaceRoot: string,
  refs: readonly string[],
): Promise<void> {
  await Promise.all(refs.map(async (reference) => {
    await runRustCommand(
      ["rust", "aci", "delete-no-symlinks", workspaceRelativeOwnedArtifact(workspaceRoot, reference)],
      workspaceRoot,
    );
  }));
}
