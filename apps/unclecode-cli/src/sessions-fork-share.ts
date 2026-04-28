/**
 * `unclecode sessions fork` and `sessions share` — small follow-ups to the
 * existing `sessions` listing. Fork copies a session's stored artifacts
 * under a new sessionId so the operator can branch from any point. Share
 * packs the (optionally compacted) transcript into a shareable directory
 * with a generated slug.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { getSessionStoreRoot } from "@unclecode/session-store";

const SESSIONS_DIRNAME = "sessions";
const PROJECTS_DIRNAME = "projects";
const SHARES_DIRNAME = ".unclecode/shares";

type ForkOptions = { readonly at?: string };
type ShareOptions = { readonly out?: string };

function locateSessionFiles(sessionId: string): {
  readonly projectDir: string;
  readonly sessionDir: string;
  readonly files: ReadonlyArray<string>;
} | null {
  const root = getSessionStoreRoot(process.env);
  const projectsDir = join(root, PROJECTS_DIRNAME);
  if (!existsSync(projectsDir)) return null;
  for (const project of readdirSync(projectsDir)) {
    const sessionDir = join(projectsDir, project, SESSIONS_DIRNAME);
    if (!existsSync(sessionDir)) continue;
    const matches = readdirSync(sessionDir).filter((name) => name.includes(sessionId));
    if (matches.length > 0) {
      return {
        projectDir: join(projectsDir, project),
        sessionDir,
        files: matches,
      };
    }
  }
  return null;
}

function generateForkId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function generateShareSlug(sessionId: string): string {
  const stamp = Date.now().toString(36);
  const fingerprint = createHash("sha256").update(`${sessionId}:${stamp}`).digest("hex").slice(0, 8);
  return `share-${stamp}-${fingerprint}`;
}

export async function handleSessionFork(sessionId: string, options: ForkOptions): Promise<void> {
  const located = locateSessionFiles(sessionId);
  if (!located) {
    process.stderr.write(`Session not found: ${sessionId}\n`);
    process.exitCode = 1;
    return;
  }
  const forkId = generateForkId();
  const truncateAt = options.at ? Number.parseInt(options.at, 10) : undefined;
  if (options.at && !Number.isFinite(truncateAt)) {
    process.stderr.write(`--at expects an integer turn index\n`);
    process.exitCode = 2;
    return;
  }
  for (const filename of located.files) {
    const src = join(located.sessionDir, filename);
    const dest = src.replace(sessionId, forkId);
    if (filename.endsWith(".jsonl") && truncateAt !== undefined) {
      const lines = readFileSync(src, "utf8").split("\n");
      const truncated = lines.slice(0, truncateAt + 1).join("\n");
      writeFileSync(dest, truncated);
    } else {
      copyFileSync(src, dest);
    }
  }
  process.stdout.write(`forked ${sessionId} → ${forkId}\n`);
  process.stdout.write(`session-dir ${located.sessionDir}\n`);
}

export async function handleSessionShare(sessionId: string, options: ShareOptions): Promise<void> {
  const located = locateSessionFiles(sessionId);
  if (!located) {
    process.stderr.write(`Session not found: ${sessionId}\n`);
    process.exitCode = 1;
    return;
  }
  const slug = generateShareSlug(sessionId);
  const outDir = options.out?.trim() || join(process.cwd(), SHARES_DIRNAME);
  const sharePath = join(outDir, slug);
  mkdirSync(sharePath, { recursive: true });
  for (const filename of located.files) {
    const src = join(located.sessionDir, filename);
    copyFileSync(src, join(sharePath, filename));
  }
  const manifest = {
    slug,
    sessionId,
    sourceDir: located.sessionDir,
    sharedAt: new Date().toISOString(),
    files: located.files,
  };
  writeFileSync(join(sharePath, "share.json"), JSON.stringify(manifest, null, 2));
  process.stdout.write(`SHARE_SLUG=${slug}\n`);
  process.stdout.write(`SHARE_PATH=${sharePath}\n`);
}
