import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { WorkShellComposerResolution } from "./work-shell-engine.js";

export type WorkShellComposerImageAttachment = {
  readonly type: "image";
  readonly mimeType: string;
  readonly dataUrl: string;
  readonly path: string;
  readonly displayName: string;
};

const IMAGE_EXTENSION_TO_MIME = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
]);

const IMAGE_PATH_PATTERN = /(?:"([^"\n]+\.(?:png|jpe?g|gif|webp|bmp))"|(\S+\.(?:png|jpe?g|gif|webp|bmp)))/gi;
const REFERENCE_PATH_PATTERN = /(?:^|\s)@(?:"([^"\n]+)"|(\S+))/g;
const MAX_TEXT_REFERENCE_CHARS = 2_000;
const MAX_DIRECTORY_ENTRIES = 12;

async function toImageAttachment(
  candidatePath: string,
  cwd: string,
): Promise<WorkShellComposerImageAttachment | undefined> {
  const mimeType = IMAGE_EXTENSION_TO_MIME.get(path.extname(candidatePath).toLowerCase());
  if (!mimeType) {
    return undefined;
  }

  const resolvedPath = path.isAbsolute(candidatePath) ? candidatePath : path.resolve(cwd, candidatePath);
  try {
    const buffer = await readFile(resolvedPath);
    return {
      type: "image",
      mimeType,
      dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
      path: resolvedPath,
      displayName: path.basename(resolvedPath),
    };
  } catch {
    return undefined;
  }
}

async function toPathReference(
  candidatePath: string,
  cwd: string,
): Promise<
  | { readonly kind: "image"; readonly attachment: WorkShellComposerImageAttachment }
  | { readonly kind: "file"; readonly promptBlock: string; readonly transcriptLine: string }
  | { readonly kind: "directory"; readonly promptBlock: string; readonly transcriptLine: string }
  | undefined
> {
  const resolvedPath = path.isAbsolute(candidatePath) ? candidatePath : path.resolve(cwd, candidatePath);

  try {
    const pathStat = await stat(resolvedPath);
    if (pathStat.isDirectory()) {
      const entries = (await readdir(resolvedPath)).sort((left, right) => left.localeCompare(right)).slice(0, MAX_DIRECTORY_ENTRIES);
      return {
        kind: "directory",
        promptBlock: [
          `Referenced directory: ${path.basename(resolvedPath)}`,
          ...(entries.length > 0 ? entries.map((entry) => `- ${entry}`) : ["(empty directory)"]),
        ].join("\n"),
        transcriptLine: `Referenced directory: ${path.basename(resolvedPath)}`,
      };
    }

    const imageAttachment = await toImageAttachment(resolvedPath, cwd);
    if (imageAttachment) {
      return {
        kind: "image",
        attachment: imageAttachment,
      };
    }

    const buffer = await readFile(resolvedPath);
    const text = buffer.toString("utf8");
    const visibleText = text.includes("\u0000")
      ? "(binary file omitted)"
      : text.trim().slice(0, MAX_TEXT_REFERENCE_CHARS) || "(empty file)";

    return {
      kind: "file",
      promptBlock: [
        `Referenced file: ${path.basename(resolvedPath)}`,
        visibleText,
      ].join("\n"),
      transcriptLine: `Referenced file: ${path.basename(resolvedPath)}`,
    };
  } catch {
    return undefined;
  }
}

export async function resolveComposerInput(
  value: string,
  cwd: string,
): Promise<WorkShellComposerResolution<WorkShellComposerImageAttachment>> {
  const raw = value.trim();
  const referenceMatches = Array.from(raw.matchAll(REFERENCE_PATH_PATTERN));
  const resolvedReferences = await Promise.all(
    referenceMatches.map(async (match) => {
      const candidatePath = match[1] ?? match[2];
      if (!candidatePath) {
        return undefined;
      }

      const reference = await toPathReference(candidatePath, cwd);
      if (!reference) {
        return undefined;
      }

      return { rawMatch: match[0], reference };
    }),
  );
  const validReferences = resolvedReferences.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  const imageMatches = Array.from(raw.matchAll(IMAGE_PATH_PATTERN));
  const resolvedImages = await Promise.all(
    imageMatches.map(async (match) => {
      const candidatePath = match[1] ?? match[2];
      if (!candidatePath) {
        return undefined;
      }

      const attachment = await toImageAttachment(candidatePath, cwd);
      if (!attachment) {
        return undefined;
      }

      return { rawMatch: match[0], attachment };
    }),
  );
  const validImages = resolvedImages.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  const imageReferences = validReferences.filter(
    (
      entry,
    ): entry is {
      rawMatch: string;
      reference: { readonly kind: "image"; readonly attachment: WorkShellComposerImageAttachment };
    } => entry.reference.kind === "image",
  );
  const textReferences = validReferences.filter(
    (
      entry,
    ): entry is {
      rawMatch: string;
      reference:
        | { readonly kind: "file"; readonly promptBlock: string; readonly transcriptLine: string }
        | { readonly kind: "directory"; readonly promptBlock: string; readonly transcriptLine: string };
    } => entry.reference.kind !== "image",
  );

  const referencedImagePaths = new Set(imageReferences.map((entry) => entry.reference.attachment.path));
  const attachments = [
    ...imageReferences.map((entry) => entry.reference.attachment),
    ...validImages
      .map((entry) => entry.attachment)
      .filter((attachment) => !referencedImagePaths.has(attachment.path)),
  ];

  let prompt = raw;
  for (const entry of validReferences) {
    prompt = prompt.replace(entry.rawMatch, " ");
  }
  for (const entry of validImages) {
    prompt = prompt.replace(entry.rawMatch, " ");
  }
  prompt = prompt.replace(/\s+/g, " ").trim();

  const promptBlocks = textReferences.map((entry) => entry.reference.promptBlock);
  if (!prompt && attachments.length > 0 && promptBlocks.length === 0) {
    prompt = attachments.length === 1 ? "Please inspect the attached image." : "Please inspect the attached images.";
  }
  if (promptBlocks.length > 0) {
    prompt = [prompt, ...promptBlocks].filter((line) => line.length > 0).join("\n\n");
  }

  const transcriptLines = [prompt];
  if (attachments.length > 0) {
    transcriptLines.push(
      attachments.length === 1
        ? `Attached image: ${attachments[0]?.displayName ?? "image"}`
        : `Attached images: ${attachments.map((attachment) => attachment.displayName).join(", ")}`,
    );
  }
  transcriptLines.push(...textReferences.map((entry) => entry.reference.transcriptLine));

  return {
    prompt,
    attachments,
    transcriptText: transcriptLines.filter((line) => line.length > 0).join("\n"),
  };
}
