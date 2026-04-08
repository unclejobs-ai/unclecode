import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { clearWorkspaceSkillCache, listAvailableSkills } from "./workspace-skills.js";

export type WorkspaceGuidanceSkill = {
  readonly name: string;
  readonly path: string;
  readonly scope: "project" | "user";
  readonly summary: string;
  readonly content: string;
};

export type WorkspaceGuidance = {
  readonly systemPromptAppendix: string;
  readonly contextSummaryLines: readonly string[];
  readonly sources: readonly string[];
};

type WorkspaceGuidanceSource = {
  readonly path: string;
  readonly name: string;
  readonly content: string;
};

type WorkspaceGuidanceConflict = {
  readonly kind: "tests" | "approval";
  readonly winner: string;
  readonly loser: string;
};

const GUIDANCE_FILE_NAMES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "UNCLECODE.md"] as const;
const workspaceGuidanceCache = new Map<string, WorkspaceGuidance>();

function summarizeContent(content: string): string {
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
    return "guidance loaded";
  }

  return line.length > 88 ? `${line.slice(0, 85)}...` : line;
}

function listGuidanceDirectories(cwd: string): readonly string[] {
  const directories: string[] = [];
  let current = path.resolve(cwd);

  while (true) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return directories.reverse();
}

function getWorkspaceGuidanceCacheKey(cwd: string, userHomeDir?: string): string {
  return `${path.resolve(cwd)}::${path.resolve(userHomeDir ?? process.env.HOME ?? cwd)}`;
}

async function readGuidanceFile(filePath: string, name: string): Promise<WorkspaceGuidanceSource | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return { path: filePath, name, content };
  } catch {
    return undefined;
  }
}

function dedupeGuidanceSources(sources: readonly WorkspaceGuidanceSource[]): {
  readonly sources: readonly WorkspaceGuidanceSource[];
  readonly notes: readonly string[];
} {
  const latestIndexByHash = new Map<string, number>();
  const hashes = sources.map((source, index) => {
    const hash = createHash("sha256").update(source.content).digest("hex");
    latestIndexByHash.set(hash, index);
    return hash;
  });

  const notes: string[] = [];
  const deduped = sources.filter((source, index) => {
    const latestIndex = latestIndexByHash.get(hashes[index] ?? "");
    const keep = latestIndex === index;
    if (!keep && latestIndex !== undefined) {
      notes.push(
        `Deduped duplicate guidance: ${source.name} → ${sources[latestIndex]?.name ?? "higher priority source"}`,
      );
    }
    return keep;
  });

  return { sources: deduped, notes };
}

function detectGuidanceConflicts(sources: readonly WorkspaceGuidanceSource[]): readonly WorkspaceGuidanceConflict[] {
  const conflicts: WorkspaceGuidanceConflict[] = [];
  const directives = sources.flatMap((source) => {
    const content = source.content;
    const items: {
      kind: "tests" | "approval";
      stance: "required" | "optional" | "auto" | "ask";
      source: string;
    }[] = [];
    if (/tests? optional|optional tests?/i.test(content)) {
      items.push({ kind: "tests", stance: "optional", source: source.name });
    }
    if (/tdd required|tests? required|must run tests|test first/i.test(content)) {
      items.push({ kind: "tests", stance: "required", source: source.name });
    }
    if (/without waiting for approval|don't wait for approval|keep moving without waiting/i.test(content)) {
      items.push({ kind: "approval", stance: "auto", source: source.name });
    }
    if (/ask for approval|wait for approval|ask permission|confirm before/i.test(content)) {
      items.push({ kind: "approval", stance: "ask", source: source.name });
    }
    return items;
  });

  for (const kind of ["tests", "approval"] as const) {
    const matching = directives.filter((directive) => directive.kind === kind);
    const uniqueStances = [...new Set(matching.map((directive) => directive.stance))];
    if (uniqueStances.length < 2 || matching.length < 2) {
      continue;
    }
    const winner = matching.at(-1);
    const loser = matching.find((directive) => directive.stance !== winner?.stance);
    if (!winner || !loser) {
      continue;
    }
    conflicts.push({ kind, winner: winner.source, loser: loser.source });
  }

  return conflicts;
}

async function discoverGuidanceSources(cwd: string, userHomeDir?: string): Promise<{
  readonly sources: readonly WorkspaceGuidanceSource[];
  readonly dedupNotes: readonly string[];
  readonly conflicts: readonly WorkspaceGuidanceConflict[];
}> {
  const candidates: WorkspaceGuidanceSource[] = [];

  if (userHomeDir) {
    const homeGuidance = await readGuidanceFile(
      path.join(userHomeDir, ".unclecode", "UNCLECODE.md"),
      "UNCLECODE.md",
    );
    if (homeGuidance) {
      candidates.push(homeGuidance);
    }
  }

  for (const directory of listGuidanceDirectories(cwd)) {
    for (const name of GUIDANCE_FILE_NAMES) {
      const source = await readGuidanceFile(path.join(directory, name), name);
      if (source) {
        candidates.push(source);
      }
    }
    for (const name of GUIDANCE_FILE_NAMES) {
      const localName = name.replace(/\.md$/i, ".local.md");
      const source = await readGuidanceFile(path.join(directory, localName), localName);
      if (source) {
        candidates.push(source);
      }
    }
  }

  const { sources, notes } = dedupeGuidanceSources(candidates);
  return {
    sources,
    dedupNotes: notes,
    conflicts: detectGuidanceConflicts(sources),
  };
}

export async function loadWorkspaceGuidance(input: {
  readonly cwd: string;
  readonly userHomeDir?: string | undefined;
  readonly workspaceSkills?: readonly WorkspaceGuidanceSkill[];
}): Promise<WorkspaceGuidance> {
  const discovered = await discoverGuidanceSources(input.cwd, input.userHomeDir);
  const sources = discovered.sources;
  const workspaceSkills = (input.workspaceSkills ?? []).filter((skill) => skill.scope === "project");

  if (sources.length === 0 && workspaceSkills.length === 0) {
    return {
      systemPromptAppendix: "",
      contextSummaryLines: [
        "No AGENTS.md, CLAUDE.md, GEMINI.md, UNCLECODE.md, or project skills found.",
        "Use /context after adding one to reload context.",
      ],
      sources: [],
    };
  }

  const appendixBlocks = [
    ...sources.map((source) => `## ${source.name} (${source.path})\n${source.content.trim()}`),
    ...workspaceSkills.map((skill) => `## SKILL ${skill.name} (${skill.path})\n${skill.content.trim()}`),
  ];
  const skillSummaryLines =
    workspaceSkills.length === 0
      ? []
      : [
          `Loaded skills: ${workspaceSkills.slice(0, 6).map((skill) => skill.name).join(", ")}`,
          ...workspaceSkills
            .slice(0, 2)
            .map((skill) => `Skill ${skill.name}: ${skill.summary}`),
        ];

  return {
    systemPromptAppendix: `Workspace guidance:\n\n${appendixBlocks.join("\n\n")}`,
    contextSummaryLines: [
      ...(sources.length > 0
        ? [`Loaded guidance: ${sources.map((source) => source.name).join(", ")}`]
        : []),
      ...sources.slice(0, 4).map((source) => `${source.name}: ${summarizeContent(source.content)}`),
      ...discovered.dedupNotes.slice(0, 2),
      ...discovered.conflicts.map(
        (conflict) =>
          `Conflict: ${conflict.kind} guidance differs → ${conflict.winner} wins over ${conflict.loser}`,
      ),
      ...skillSummaryLines,
      "/context · /help · /sessions · /reasoning · /skills",
    ],
    sources: [
      ...sources.map((source) => source.path),
      ...workspaceSkills.map((skill) => skill.path),
    ],
  };
}

export function clearCachedWorkspaceGuidance(cwd?: string, userHomeDir?: string): void {
  if (!cwd) {
    workspaceGuidanceCache.clear();
    clearWorkspaceSkillCache();
    return;
  }

  workspaceGuidanceCache.delete(getWorkspaceGuidanceCacheKey(cwd, userHomeDir));
  const skillHomeDir = userHomeDir ?? process.env.HOME;
  if (skillHomeDir) {
    clearWorkspaceSkillCache(cwd, skillHomeDir);
    return;
  }
  clearWorkspaceSkillCache(cwd);
}

export async function loadCachedWorkspaceGuidance(input: {
  readonly cwd: string;
  readonly userHomeDir?: string | undefined;
}): Promise<WorkspaceGuidance> {
  const cacheKey = getWorkspaceGuidanceCacheKey(input.cwd, input.userHomeDir);
  const cached = workspaceGuidanceCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const skillHomeDir = input.userHomeDir ?? process.env.HOME;
  const workspaceSkills = (
    skillHomeDir
      ? await listAvailableSkills(input.cwd, skillHomeDir)
      : await listAvailableSkills(input.cwd)
  ).filter((skill) => skill.scope === "project");

  const guidance = await loadWorkspaceGuidance({
    cwd: input.cwd,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
    workspaceSkills: await Promise.all(
      workspaceSkills.map(async (skill) => ({
        name: skill.name,
        path: skill.path,
        scope: skill.scope,
        summary: skill.summary,
        content: await readFile(skill.path, "utf8"),
      })),
    ),
  });
  workspaceGuidanceCache.set(cacheKey, guidance);
  return guidance;
}
