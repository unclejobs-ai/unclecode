import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { runRustCommand } from "./rust-command.js";

export const QUEUE_ATTACHMENT_SCHEMA = "unclecode.queue-attachment.v1";
export const QUEUE_ATTACHMENT_MAX_BYTES = 1024 * 1024;
export const QUEUE_ATTACHMENT_MAX_COUNT = 32;
const QUEUE_ATTACHMENT_CLEANUP_BATCH = 64;

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
  preflight?: (artifacts: readonly QueueAttachmentArtifact[]) => Promise<void>,
): Promise<readonly QueueAttachmentArtifact[]> {
  const relativeDirectory = path.join(
    ".unclecode",
    "artifacts",
    safeFilePart(sessionId),
    "queue-attachments",
  );
  const prepared = attachments.map((attachment, index) => {
    const filename = `${randomUUID()}-${index}.json`;
    const relative = path.join(relativeDirectory, filename).split(path.sep).join("/");
    const content = `${JSON.stringify(attachment)}\n`;
    return {
      content,
      artifact: {
        ref: relative,
        schema: QUEUE_ATTACHMENT_SCHEMA,
        sha256: digest(content),
        size: Buffer.byteLength(content, "utf8"),
      } satisfies QueueAttachmentArtifact,
    };
  });
  await preflight?.(prepared.map(({ artifact }) => artifact));
  if (prepared.length === 0) return [];

  const persisted: QueueAttachmentArtifact[] = [];
  try {
    for (const { artifact, content } of prepared) {
      await runRustCommand(
        ["rust", "aci", "write-atomic-no-symlinks", workspaceRelativeOwnedArtifact(workspaceRoot, artifact.ref)],
        workspaceRoot,
        content,
      );
      persisted.push(artifact);
    }
    return persisted;
  } catch (error) {
    await deleteQueuedAttachmentArtifacts(workspaceRoot, persisted.map((artifact) => artifact.ref));
    throw error;
  }
}

export async function restoreQueuedAttachments<Attachment>(
  workspaceRoot: string,
  artifacts: readonly QueueAttachmentArtifact[],
): Promise<readonly Attachment[]> {
  if (artifacts.length > QUEUE_ATTACHMENT_MAX_COUNT) {
    throw new Error(`Queue attachment count exceeds limit ${QUEUE_ATTACHMENT_MAX_COUNT}.`);
  }
  let expectedTotal = 0;
  for (const artifact of artifacts) {
    if (
      !Number.isSafeInteger(artifact.size)
      || artifact.size < 0
      || artifact.size > QUEUE_ATTACHMENT_MAX_BYTES
    ) {
      throw new Error(`Queue attachment bytes exceed hard limit ${QUEUE_ATTACHMENT_MAX_BYTES}.`);
    }
    expectedTotal += artifact.size;
    if (expectedTotal > QUEUE_ATTACHMENT_MAX_BYTES) {
      throw new Error(`Queue attachment bytes exceed hard limit ${QUEUE_ATTACHMENT_MAX_BYTES}.`);
    }
  }
  const attachments: Attachment[] = [];
  for (const artifact of artifacts) {
    if (artifact.schema !== QUEUE_ATTACHMENT_SCHEMA) {
      throw new Error(`Unsupported queue attachment schema: ${artifact.schema}`);
    }
    const content = await runRustCommand(
      [
        "rust",
        "aci",
        "read-bounded-no-symlinks",
        workspaceRelativeOwnedArtifact(workspaceRoot, artifact.ref),
        String(artifact.size),
        String(QUEUE_ATTACHMENT_MAX_BYTES),
      ],
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
      ["rust", "aci", "delete-no-symlinks-if-exists", workspaceRelativeOwnedArtifact(workspaceRoot, reference)],
      workspaceRoot,
    );
  }));
}

type QueueCleanupArtifact = {
  readonly ref: string;
  readonly size: number;
};

function parseQueueCleanupArtifacts(stdout: string): readonly QueueCleanupArtifact[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (
    !Array.isArray(parsed)
    || parsed.length > QUEUE_ATTACHMENT_CLEANUP_BATCH
    || !parsed.every((artifact) => {
      if (!artifact || typeof artifact !== "object") return false;
      const value = artifact as Record<string, unknown>;
      return typeof value.ref === "string"
        && value.ref.length > 0
        && typeof value.size === "number"
        && Number.isSafeInteger(value.size)
        && value.size >= 0
        && value.size <= QUEUE_ATTACHMENT_MAX_BYTES;
    })
  ) {
    throw new Error("Invalid Rust queue cleanup response.");
  }
  return parsed as QueueCleanupArtifact[];
}

/** Retry a bounded batch of durable post-queue attachment deletions. */
export async function sweepQueuedAttachmentArtifacts(
  workspaceRoot: string,
  sessionId: string,
): Promise<{ readonly attempted: number; readonly completed: number }> {
  const artifacts = parseQueueCleanupArtifacts(await runRustCommand(
    ["rust", "queue", "cleanup-list-json", sessionId, String(QUEUE_ATTACHMENT_CLEANUP_BATCH)],
    workspaceRoot,
  ));
  const settled = await Promise.allSettled(artifacts.map(async (artifact) => {
    await deleteQueuedAttachmentArtifacts(workspaceRoot, [artifact.ref]);
    return artifact.ref;
  }));
  const completed = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (completed.length > 0) {
    await runRustCommand(
      ["rust", "queue", "cleanup-complete-json", sessionId],
      workspaceRoot,
      JSON.stringify(completed),
    );
  }
  return { attempted: artifacts.length, completed: completed.length };
}
