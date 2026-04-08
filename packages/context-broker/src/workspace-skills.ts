import type { SkillMetadata } from "@unclecode/contracts";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type WorkspaceSkillItem = {
  readonly name: string;
  readonly path: string;
  readonly scope: "project" | "user";
  readonly summary: string;
};

export type LoadedWorkspaceSkill = {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly attempts: readonly {
    path: string;
    ok: boolean;
    error?: string | undefined;
  }[];
};

export type WorkspaceSkillMetadata = SkillMetadata & {
  readonly path: string;
  readonly scope: "project" | "user";
};

const SKILL_SEARCH_LIMIT = 64;
const HOME_DIR = os.homedir();
const skillMetadataCache = new Map<string, readonly WorkspaceSkillMetadata[]>();

function getSkillCacheKey(cwd: string, homeDir: string): string {
  return `${path.resolve(cwd)}::${path.resolve(homeDir)}`;
}

export function clearWorkspaceSkillCache(cwd?: string, homeDir = HOME_DIR): void {
  if (!cwd) {
    skillMetadataCache.clear();
    return;
  }

  skillMetadataCache.delete(getSkillCacheKey(cwd, homeDir));
}

function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return {};
  }

  const body = match[1];
  if (!body) {
    return {};
  }

  const fields: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const fieldMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!fieldMatch) {
      continue;
    }

    const key = fieldMatch[1];
    const rawValue = fieldMatch[2];
    if (!key || rawValue === undefined) {
      continue;
    }

    const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
    fields[key] = value;
  }

  return fields;
}

function summarizeSkillContent(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(
      (entry) =>
        entry.length > 0 &&
        !entry.startsWith("#") &&
        !entry.startsWith("<!--") &&
        !entry.startsWith("-->") &&
        entry !== "-",
    );

  if (!line) {
    return "skill loaded";
  }

  return line.length > 88 ? `${line.slice(0, 85)}...` : line;
}

function candidateSkillPaths(
  name: string,
  cwd: string,
  homeDir: string,
): readonly string[] {
  return [
    path.join(cwd, ".codex", "skills", name, "SKILL.md"),
    path.join(homeDir, ".codex", "skills", name, "SKILL.md"),
    path.join(homeDir, ".agents", "skills", name, "SKILL.md"),
    path.join(homeDir, ".agents", "skills", "superpowers", name, "SKILL.md"),
  ];
}

async function collectSkillFiles(
  root: string,
  limit = SKILL_SEARCH_LIMIT,
): Promise<readonly string[]> {
  const found: string[] = [];
  const queue = [root];

  while (queue.length > 0 && found.length < limit) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(nextPath);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        found.push(nextPath);
        if (found.length >= limit) {
          break;
        }
      }
    }
  }

  return found;
}

export async function discoverSkillMetadata(
  cwd: string,
  homeDir = HOME_DIR,
): Promise<readonly WorkspaceSkillMetadata[]> {
  const cacheKey = getSkillCacheKey(cwd, homeDir);
  const cached = skillMetadataCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const projectFiles = await collectSkillFiles(path.join(cwd, ".codex", "skills"));
  const userCodexFiles = await collectSkillFiles(path.join(homeDir, ".codex", "skills"));
  const userAgentFiles = await collectSkillFiles(path.join(homeDir, ".agents", "skills"));

  const deduped = new Map<string, WorkspaceSkillMetadata>();
  for (const filePath of [...projectFiles, ...userCodexFiles, ...userAgentFiles]) {
    const inferredName = path.basename(path.dirname(filePath));
    if (!inferredName || deduped.has(inferredName)) {
      continue;
    }

    const content = await readFile(filePath, "utf8");
    const frontmatter = parseSkillFrontmatter(content);
    const name = frontmatter.name?.trim() || inferredName;
    if (deduped.has(name)) {
      continue;
    }

    deduped.set(name, {
      name,
      description: frontmatter.description?.trim() || summarizeSkillContent(content),
      source: "skills",
      commandType: "prompt",
      paths: [filePath],
      path: filePath,
      scope: filePath.startsWith(cwd) ? "project" : "user",
    });
  }

  const discovered = [...deduped.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  skillMetadataCache.set(cacheKey, discovered);
  return discovered;
}

export async function listAvailableSkills(
  cwd: string,
  homeDir = HOME_DIR,
): Promise<readonly WorkspaceSkillItem[]> {
  const discovered = await discoverSkillMetadata(cwd, homeDir);

  return discovered.map((skill) => ({
    name: skill.name,
    path: skill.path,
    scope: skill.scope,
    summary: skill.description,
  }));
}

export async function loadNamedSkill(
  name: string,
  cwd: string,
  homeDir = HOME_DIR,
): Promise<LoadedWorkspaceSkill> {
  const attempts: Array<{
    path: string;
    ok: boolean;
    error?: string | undefined;
  }> = [];

  for (const filePath of candidateSkillPaths(name, cwd, homeDir)) {
    try {
      const content = await readFile(filePath, "utf8");
      attempts.push({ path: filePath, ok: true });
      return { name, path: filePath, content, attempts };
    } catch (error) {
      attempts.push({
        path: filePath,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const discovered = await listAvailableSkills(cwd, homeDir);
  const discoveredMatch = discovered.find((skill) => skill.name === name);
  if (discoveredMatch) {
    const content = await readFile(discoveredMatch.path, "utf8");
    attempts.push({ path: discoveredMatch.path, ok: true });
    return { name, path: discoveredMatch.path, content, attempts };
  }

  throw new Error(`Skill not found: ${name}`);
}
