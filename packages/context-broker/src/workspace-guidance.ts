import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createInstrumentedLruCache } from "@unclecode/contracts";

import { runRustCommandSync } from "./rust-command.js";
import { loadPinnedSkillNames } from "./pinned-skills.js";
import { clearWorkspaceSkillCache, listAvailableSkills } from "./workspace-skills.js";

export type WorkspaceGuidanceSkill = {
  readonly name: string;
  readonly path: string;
  readonly scope: "project" | "user";
  readonly summary: string;
  readonly content: string;
};


export type WorkspaceGuidanceSourceMetadata = {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly authority: "mandatory" | "profile-eligible";
  readonly sha256: string;
};
export type WorkspaceGuidance = {
  readonly systemPromptAppendix: string;
  readonly contextSummaryLines: readonly string[];
  readonly sources: readonly string[];
  readonly guidanceSources: readonly WorkspaceGuidanceSourceMetadata[];
};

type WorkspaceGuidancePayload = Omit<WorkspaceGuidance, "guidanceSources"> & {
  readonly guidanceSources?: readonly WorkspaceGuidanceSourceMetadata[];
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
const WORKSPACE_GUIDANCE_CACHE_MAX_ENTRIES = 32;
const WORKSPACE_GUIDANCE_CACHE_MAX_RETAINED_BYTES = 4 * 1024 * 1024;
const workspaceGuidanceCache = createInstrumentedLruCache<string, WorkspaceGuidance>({
  name: "workspace-guidance",
  maxEntries: WORKSPACE_GUIDANCE_CACHE_MAX_ENTRIES,
  maxRetainedBytes: WORKSPACE_GUIDANCE_CACHE_MAX_RETAINED_BYTES,
  estimateEntryBytes(key, guidance) {
    const strings = [
      key,
      guidance.systemPromptAppendix,
      ...guidance.contextSummaryLines,
      ...guidance.sources,
      ...guidance.guidanceSources.flatMap((source) => [
        source.id,
        source.path,
        source.label,
        source.authority,
        source.sha256,
      ]),
    ];
    const stringBytes = strings.reduce(
      (total, value) => total + 32 + value.length * 2,
      0,
    );
    return 256 + stringBytes + guidance.guidanceSources.length * 128;
  },
});

export function getWorkspaceGuidanceCacheTelemetrySnapshot() {
  return workspaceGuidanceCache.snapshot();
}

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
  return JSON.stringify([
    path.resolve(cwd),
    path.resolve(userHomeDir ?? process.env.HOME ?? cwd),
  ]);
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
    const hash = runRustCommandSync(["rust", "sha256"], process.cwd(), source.content).trim();
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

  const rulesDir = path.join(cwd, ".sisyphus", "rules");
  try {
    const ruleFiles = await readdir(rulesDir);
    for (const file of ruleFiles.filter((f) => f.endsWith(".md")).sort()) {
      const source = await readGuidanceFile(path.join(rulesDir, file), `rules/${file}`);
      if (source) {
        candidates.push(source);
      }
    }
  } catch {
    // .sisyphus/rules/ may not exist — that's fine
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
  const raw = runRustCommandSync(
    ["rust", "context", "guidance", input.cwd, input.userHomeDir ?? "-"],
    process.cwd(),
    JSON.stringify(input.workspaceSkills ?? []),
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isWorkspaceGuidance(parsed)) {
    throw new Error("Rust workspace guidance command returned an invalid payload.");
  }
  return {
    ...parsed,
    guidanceSources: parsed.guidanceSources ?? [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspaceGuidanceSourceMetadata(value: unknown): value is WorkspaceGuidanceSourceMetadata {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.path === "string"
    && typeof value.label === "string"
    && (value.authority === "mandatory" || value.authority === "profile-eligible")
    && typeof value.sha256 === "string";
}

function isWorkspaceGuidance(value: unknown): value is WorkspaceGuidancePayload {
  return isRecord(value)
    && typeof value.systemPromptAppendix === "string"
    && Array.isArray(value.contextSummaryLines)
    && Array.isArray(value.sources)
    && value.contextSummaryLines.every((line) => typeof line === "string")
    && value.sources.every((source) => typeof source === "string")
    && (
      value.guidanceSources === undefined
      || (
        Array.isArray(value.guidanceSources)
        && value.guidanceSources.every(isWorkspaceGuidanceSourceMetadata)
      )
    );
}

export function clearCachedWorkspaceGuidance(cwd?: string, userHomeDir?: string): void {
  if (!cwd) {
    workspaceGuidanceCache.invalidateAll();
    clearWorkspaceSkillCache();
    return;
  }

  workspaceGuidanceCache.invalidate(getWorkspaceGuidanceCacheKey(cwd, userHomeDir));
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
  const cached = workspaceGuidanceCache.lookup(cacheKey);
  if (cached.hit) {
    return cached.value;
  }

  const skillHomeDir = input.userHomeDir ?? process.env.HOME;
  const pinnedNames = new Set(await loadPinnedSkillNames(input.cwd));
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
        content: pinnedNames.has(skill.name) ? await readFile(skill.path, "utf8") : "",
      })),
    ),
  });
  workspaceGuidanceCache.set(cacheKey, guidance);
  return guidance;
}
