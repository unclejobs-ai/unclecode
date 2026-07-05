import { readFile } from "node:fs/promises";
import path from "node:path";

const PINNED_SKILLS_FILE = path.join(".unclecode", "context", "pinned-skills.json");

export function getPinnedSkillsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, PINNED_SKILLS_FILE);
}

export async function loadPinnedSkillNames(workspaceRoot: string): Promise<readonly string[]> {
  try {
    const raw = await readFile(getPinnedSkillsPath(workspaceRoot), "utf8");
    const parsed = JSON.parse(raw) as { skills?: unknown };
    if (!Array.isArray(parsed.skills)) {
      return [];
    }

    return parsed.skills.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  } catch {
    return [];
  }
}
