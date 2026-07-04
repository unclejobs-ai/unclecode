import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type CursorRuleSource = {
  readonly path: string;
  readonly name: string;
  readonly content: string;
  readonly summary: string;
};

function summarizeRuleContent(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(
      (entry) =>
        entry.length > 0 &&
        !entry.startsWith("#") &&
        !entry.startsWith("<!--") &&
        !entry.startsWith("-->") &&
        !entry.startsWith("---"),
    );

  if (!line) {
    return "cursor rule loaded";
  }

  return line.length > 88 ? `${line.slice(0, 85)}...` : line;
}

async function readRuleFile(filePath: string, name: string): Promise<CursorRuleSource | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return {
      path: filePath,
      name,
      content,
      summary: summarizeRuleContent(content),
    };
  } catch {
    return undefined;
  }
}

async function collectRuleFiles(directory: string, prefix: string): Promise<readonly CursorRuleSource[]> {
  const sources: CursorRuleSource[] = [];

  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        sources.push(...(await collectRuleFiles(entryPath, `${prefix}${entry.name}/`)));
        continue;
      }

      if (!/\.(?:mdc|md)$/i.test(entry.name)) {
        continue;
      }

      const source = await readRuleFile(entryPath, `rules/${prefix}${entry.name}`);
      if (source) {
        sources.push(source);
      }
    }
  } catch {
    // Missing rules directory is expected for many workspaces.
  }

  return sources;
}

export async function discoverCursorRules(cwd: string): Promise<readonly CursorRuleSource[]> {
  const sources: CursorRuleSource[] = [];
  sources.push(...(await collectRuleFiles(path.join(cwd, ".cursor", "rules"), "")));

  const cursorRulesFile = await readRuleFile(path.join(cwd, ".cursorrules"), ".cursorrules");
  if (cursorRulesFile) {
    sources.push(cursorRulesFile);
  }

  return sources;
}
