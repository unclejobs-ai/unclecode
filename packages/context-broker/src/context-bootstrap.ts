import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { writeScopedMemory } from "./context-memory.js";
import { createContextPacketView } from "./context-packet-view.js";
import { discoverCursorRules } from "./cursor-rules.js";
import { prefetchScopedMemory } from "./memory-prefetch.js";
import { loadPinnedSkillNames } from "./pinned-skills.js";
import { runRustCommandSync } from "./rust-command.js";
import { loadCachedWorkspaceGuidance } from "./workspace-guidance.js";
import { discoverSkillMetadata } from "./workspace-skills.js";
import type { ContextPacketView, ContextPacketViewItem, ContextPacketViewWarning } from "@unclecode/contracts";

export type BootstrapSourceKind =
  | "guidance"
  | "cursor-rule"
  | "skill"
  | "mcp"
  | "memory";

export type BootstrapSourceRecord = {
  readonly id: string;
  readonly kind: BootstrapSourceKind;
  readonly path: string;
  readonly scope: "project" | "user" | "workspace";
  readonly sha256: string;
  readonly bytes: number;
  readonly summary: string;
  readonly includedInModel: boolean;
  readonly includedInView: boolean;
  readonly reason: string;
};

export type BootstrapSnapshot = {
  readonly version: 1;
  readonly sessionId?: string;
  readonly workspaceRoot: string;
  readonly generatedAt: string;
  readonly sources: readonly BootstrapSourceRecord[];
  readonly warnings: readonly string[];
  readonly conflicts: readonly string[];
  readonly memoryPrefetch: {
    readonly status: "ok" | "empty" | "degraded";
    readonly reason?: string;
  };
};

export type IngestWorkspaceBootstrapContextInput = {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionId?: string;
  readonly userHomeDir?: string;
  readonly persistMemoryFacts?: boolean;
};

export type IngestWorkspaceBootstrapContextResult = {
  readonly snapshot: BootstrapSnapshot;
  readonly snapshotPath: string;
  readonly summaryLines: readonly string[];
  readonly packetItems: readonly ContextPacketViewItem[];
  readonly packetWarnings: readonly ContextPacketViewWarning[];
};

const BOOTSTRAP_DIR = path.join(".unclecode", "context");
const BOOTSTRAP_FILE = "bootstrap.json";

function sha256Content(content: string): string {
  return runRustCommandSync(["rust", "sha256"], process.cwd(), content).trim();
}

function getBootstrapSnapshotPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, BOOTSTRAP_DIR, BOOTSTRAP_FILE);
}

function readMcpServerRecords(input: {
  readonly filePath: string;
  readonly scope: "project" | "user";
}): readonly BootstrapSourceRecord[] {
  if (!existsSync(input.filePath)) {
    return [];
  }

  try {
    const raw = readFileSync(input.filePath, "utf8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { type?: string }> };
    const servers = parsed.mcpServers ?? {};

    return Object.entries(servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, config]) => {
        const transport = typeof config?.type === "string" ? config.type : "unknown";
        const summary = `${name} · ${transport} · ${input.scope} config`;
        return {
          id: `mcp:${input.scope}:${name}`,
          kind: "mcp" as const,
          path: input.filePath,
          scope: input.scope,
          sha256: sha256Content(summary),
          bytes: summary.length,
          summary,
          includedInModel: false,
          includedInView: true,
          reason: "MCP registry metadata only; raw config stays local",
        };
      });
  } catch {
    return [];
  }
}

async function readOptionalUtf8(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function discoverMcpSources(input: {
  readonly cwd: string;
  readonly userHomeDir?: string;
}): readonly BootstrapSourceRecord[] {
  const homeDir = input.userHomeDir ?? process.env.HOME;
  const sources: BootstrapSourceRecord[] = [
    ...readMcpServerRecords({
      filePath: path.join(input.cwd, ".mcp.json"),
      scope: "project",
    }),
  ];

  if (homeDir) {
    sources.push(
      ...readMcpServerRecords({
        filePath: path.join(homeDir, ".unclecode", "mcp.json"),
        scope: "user",
      }),
    );
  }

  return sources;
}

function extractGuidanceConflicts(summaryLines: readonly string[]): readonly string[] {
  return summaryLines.filter((line) => /^Conflict:/i.test(line));
}

function extractGuidanceWarnings(summaryLines: readonly string[]): readonly string[] {
  return summaryLines.filter((line) => /^(Deduped duplicate guidance|Conflict):/i.test(line));
}

function sourceDisplayName(sourcePath: string): string {
  const basename = path.basename(sourcePath);
  if (sourcePath.includes(`${path.sep}.sisyphus${path.sep}rules${path.sep}`)) {
    return `rules/${basename}`;
  }
  return basename;
}

function buildGuidanceSourceRecords(input: {
  readonly cwd: string;
  readonly guidanceSources: readonly string[];
  readonly guidanceSummaryLines: readonly string[];
}): readonly BootstrapSourceRecord[] {
  const summaryByName = new Map<string, string>();

  for (const line of input.guidanceSummaryLines) {
    const match = /^([^:]+): (.+)$/i.exec(line);
    if (match?.[1] && match[2] && !/^Loaded /i.test(match[1])) {
      summaryByName.set(match[1].trim(), match[2].trim());
    }
  }

  return input.guidanceSources
    .filter((sourcePath) => !/SKILL\.md$/i.test(sourcePath))
    .map((sourcePath, index) => {
      const displayName = sourceDisplayName(sourcePath);
      const summary = summaryByName.get(displayName) ?? "guidance loaded";
      const scope = sourcePath.includes(`${path.sep}.unclecode${path.sep}`) ? "user" : "workspace";

      return {
        id: `guidance:${index + 1}:${displayName}`,
        kind: "guidance",
        path: sourcePath,
        scope,
        sha256: sha256Content(`${sourcePath}:${summary}`),
        bytes: summary.length,
        summary,
        includedInModel: true,
        includedInView: true,
        reason: "workspace guidance summary; raw text withheld from packet view",
      };
    });
}

function buildCursorRuleSourceRecords(
  rules: readonly { readonly path: string; readonly name: string; readonly summary: string; readonly content: string }[],
): readonly BootstrapSourceRecord[] {
  return rules.map((rule, index) => ({
    id: `cursor-rule:${index + 1}:${rule.name}`,
    kind: "cursor-rule",
    path: rule.path,
    scope: "project",
    sha256: sha256Content(rule.content),
    bytes: rule.content.length,
    summary: rule.summary,
    includedInModel: false,
    includedInView: true,
    reason: "cursor rule summary; raw rule text withheld from packet view",
  }));
}

function buildSkillSourceRecords(
  skills: readonly { readonly name: string; readonly path: string; readonly scope: "project" | "user"; readonly description: string }[],
  pinnedNames: ReadonlySet<string>,
): readonly BootstrapSourceRecord[] {
  return skills.map((skill) => ({
    id: `skill:${skill.scope}:${skill.name}`,
    kind: "skill",
    path: skill.path,
    scope: skill.scope,
    sha256: sha256Content(`${skill.name}:${skill.description}`),
    bytes: skill.description.length,
    summary: skill.description.trim().length > 0 ? skill.description.trim() : `${skill.name} skill`,
    includedInModel: pinnedNames.has(skill.name),
    includedInView: true,
    reason: pinnedNames.has(skill.name)
      ? "pinned skill injected into model context"
      : skill.scope === "project"
        ? "project skill catalog entry; full SKILL.md stays on demand"
        : "user skill catalog entry; load on /skill",
  }));
}

function buildBootstrapSummaryLines(snapshot: BootstrapSnapshot): readonly string[] {
  const guidanceCount = snapshot.sources.filter((source) => source.kind === "guidance").length;
  const cursorRuleCount = snapshot.sources.filter((source) => source.kind === "cursor-rule").length;
  const skillCount = snapshot.sources.filter((source) => source.kind === "skill").length;
  const mcpCount = snapshot.sources.filter((source) => source.kind === "mcp").length;

  const lines = [
    `Bootstrap context · ${snapshot.generatedAt}`,
    `Loaded guidance: ${guidanceCount} source${guidanceCount === 1 ? "" : "s"}`,
  ];

  if (cursorRuleCount > 0) {
    lines.push(`Loaded cursor rules: ${cursorRuleCount}`);
  }

  if (skillCount > 0) {
    lines.push(`Loaded skills: ${skillCount}`);
  }

  if (mcpCount > 0) {
    lines.push(`Loaded MCP servers: ${mcpCount}`);
  } else {
    lines.push("Loaded MCP servers: none");
  }

  for (const warning of snapshot.warnings) {
    lines.push(warning);
  }

  for (const conflict of snapshot.conflicts) {
    lines.push(conflict);
  }

  if (snapshot.memoryPrefetch.status === "degraded") {
    lines.push(
      `Memory prefetch degraded${snapshot.memoryPrefetch.reason ? ` · ${snapshot.memoryPrefetch.reason}` : ""}`,
    );
  }

  return lines;
}

export function buildBootstrapContextPacketSupplement(
  snapshot: BootstrapSnapshot,
): {
  readonly included: readonly ContextPacketViewItem[];
  readonly excluded: readonly ContextPacketViewItem[];
  readonly warnings: readonly ContextPacketViewWarning[];
} {
  const included: ContextPacketViewItem[] = [
    {
      id: "bootstrap-context-stamp",
      category: "workspace",
      label: "Bootstrap context snapshot",
      reason: "persistent shared context manifest",
      preview: `${snapshot.sources.length} sources · ${snapshot.generatedAt}`,
      sourceCount: snapshot.sources.length,
    },
  ];

  const guidanceSources = snapshot.sources.filter((source) => source.kind === "guidance");
  if (guidanceSources.length > 0) {
    included.push({
      id: "bootstrap-guidance-catalog",
      category: "workspace-guidance",
      label: "Workspace guidance catalog",
      reason: "bootstrap guidance sources",
      preview: guidanceSources.map((source) => path.basename(source.path)).join(", "),
      sourceCount: guidanceSources.length,
    });
  }

  const cursorRules = snapshot.sources.filter((source) => source.kind === "cursor-rule");
  if (cursorRules.length > 0) {
    included.push({
      id: "bootstrap-cursor-rules",
      category: "workspace-guidance",
      label: "Cursor rules catalog",
      reason: "bootstrap cursor rule summaries",
      preview: cursorRules.map((source) => path.basename(source.path)).join(", "),
      sourceCount: cursorRules.length,
    });
  }

  const skills = snapshot.sources.filter((source) => source.kind === "skill");
  if (skills.length > 0) {
    included.push({
      id: "bootstrap-skill-catalog",
      category: "workspace",
      label: "Skill catalog",
      reason: "bootstrap skill manifests",
      preview: skills.map((source) => path.basename(path.dirname(source.path))).join(", "),
      sourceCount: skills.length,
    });
  }

  const mcpServers = snapshot.sources.filter((source) => source.kind === "mcp");
  if (mcpServers.length > 0) {
    included.push({
      id: "bootstrap-mcp-registry",
      category: "workspace",
      label: "MCP server registry",
      reason: "bootstrap MCP metadata",
      preview: mcpServers.map((source) => source.summary).join(" · "),
      sourceCount: mcpServers.length,
    });
  }

  const excluded: ContextPacketViewItem[] = snapshot.sources
    .filter((source) => !source.includedInModel)
    .map((source, index) => ({
      id: `bootstrap-excluded-${index + 1}`,
      category: source.kind === "cursor-rule" ? "workspace-guidance" : "workspace",
      label: path.basename(source.path),
      reason: source.reason,
      preview: source.path,
    }));

  const warnings: ContextPacketViewWarning[] = snapshot.warnings.map((message, index) => ({
    code: `bootstrap.warning.${index + 1}`,
    message,
    severity: "warning",
  }));

  if (snapshot.memoryPrefetch.status === "degraded") {
    warnings.push({
      code: "bootstrap.memory-prefetch.degraded",
      message: snapshot.memoryPrefetch.reason ?? "Scoped memory prefetch timed out during bootstrap.",
      severity: "warning",
    });
  }

  return { included, excluded, warnings };
}

export async function writeBootstrapSnapshot(input: {
  readonly workspaceRoot: string;
  readonly snapshot: BootstrapSnapshot;
}): Promise<string> {
  const snapshotPath = getBootstrapSnapshotPath(input.workspaceRoot);
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(input.snapshot, null, 2)}\n`, "utf8");
  return snapshotPath;
}

export async function loadBootstrapSnapshot(workspaceRoot: string): Promise<BootstrapSnapshot | undefined> {
  const snapshotPath = getBootstrapSnapshotPath(workspaceRoot);
  const raw = await readOptionalUtf8(snapshotPath);
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as BootstrapSnapshot;
  if (parsed.version !== 1 || !Array.isArray(parsed.sources)) {
    return undefined;
  }

  return parsed;
}

async function persistBootstrapMemoryFacts(input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly snapshot: BootstrapSnapshot;
}): Promise<void> {
  const guidanceCount = input.snapshot.sources.filter((source) => source.kind === "guidance").length;
  const skillCount = input.snapshot.sources.filter((source) => source.kind === "skill").length;
  const mcpCount = input.snapshot.sources.filter((source) => source.kind === "mcp").length;
  const cursorRuleCount = input.snapshot.sources.filter((source) => source.kind === "cursor-rule").length;

  await writeScopedMemory({
    scope: "project",
    cwd: input.cwd,
    ...(input.env ? { env: input.env } : {}),
    summary: `Bootstrap context: ${guidanceCount} guidance, ${cursorRuleCount} cursor rules, ${skillCount} skills, ${mcpCount} MCP servers.`,
  });
}

export async function ingestWorkspaceBootstrapContext(
  input: IngestWorkspaceBootstrapContextInput,
): Promise<IngestWorkspaceBootstrapContextResult> {
  const generatedAt = new Date().toISOString();
  const userHomeDir = input.userHomeDir ?? input.env?.HOME ?? process.env.HOME;

  const [guidance, skills, cursorRules, memoryPrefetch, pinnedNames] = await Promise.all([
    loadCachedWorkspaceGuidance({
      cwd: input.cwd,
      ...(userHomeDir ? { userHomeDir } : {}),
    }),
    discoverSkillMetadata(input.cwd, userHomeDir ?? undefined),
    discoverCursorRules(input.cwd),
    prefetchScopedMemory({
      cwd: input.cwd,
      ...(input.env ? { env: input.env } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      agentId: "work-shell",
    }),
    loadPinnedSkillNames(input.cwd),
  ]);

  const warnings = extractGuidanceWarnings(guidance.contextSummaryLines);
  const conflicts = extractGuidanceConflicts(guidance.contextSummaryLines);
  const sources: BootstrapSourceRecord[] = [
    ...buildGuidanceSourceRecords({
      cwd: input.cwd,
      guidanceSources: guidance.sources,
      guidanceSummaryLines: guidance.contextSummaryLines,
    }),
    ...buildCursorRuleSourceRecords(cursorRules),
    ...buildSkillSourceRecords(skills, new Set(pinnedNames)),
    ...discoverMcpSources({
      cwd: input.cwd,
      ...(userHomeDir ? { userHomeDir } : {}),
    }),
  ];

  const snapshot: BootstrapSnapshot = {
    version: 1,
    workspaceRoot: input.cwd,
    generatedAt,
    sources,
    warnings,
    conflicts,
    memoryPrefetch: {
      status: memoryPrefetch.status,
      ...(memoryPrefetch.reason ? { reason: memoryPrefetch.reason } : {}),
    },
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };

  const snapshotPath = await writeBootstrapSnapshot({
    workspaceRoot: input.cwd,
    snapshot,
  });

  if (input.persistMemoryFacts !== false) {
    await persistBootstrapMemoryFacts({
      cwd: input.cwd,
      snapshot,
      ...(input.env ? { env: input.env } : {}),
    });
  }

  const supplement = buildBootstrapContextPacketSupplement(snapshot);

  return {
    snapshot,
    snapshotPath,
    summaryLines: buildBootstrapSummaryLines(snapshot),
    packetItems: supplement.included,
    packetWarnings: supplement.warnings,
  };
}

export function augmentContextPacketViewInput(input: {
  readonly base: {
    readonly id: string;
    readonly generatedAt: string;
    readonly title?: string;
    readonly included: readonly ContextPacketViewItem[];
    readonly excluded: readonly ContextPacketViewItem[];
    readonly warnings: readonly ContextPacketViewWarning[];
    readonly preview: readonly string[];
  };
  readonly bootstrap?: BootstrapSnapshot | undefined;
  readonly bootstrapSupplement?: ReturnType<typeof buildBootstrapContextPacketSupplement> | undefined;
}): ReturnType<typeof createContextPacketView> {
  const supplement =
    input.bootstrapSupplement ??
    (input.bootstrap ? buildBootstrapContextPacketSupplement(input.bootstrap) : undefined);

  if (!supplement) {
    return createContextPacketView(input.base);
  }

  return createContextPacketView({
    ...input.base,
    included: [...input.base.included, ...supplement.included],
    excluded: [...input.base.excluded, ...supplement.excluded],
    warnings: [...input.base.warnings, ...supplement.warnings],
  });
}

export function createBootstrapPacketId(snapshot: BootstrapSnapshot): string {
  const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 12);
  return `bootstrap-${hash}`;
}
