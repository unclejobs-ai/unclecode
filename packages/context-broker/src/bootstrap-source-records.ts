import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { runRustCommandSync } from "./rust-command.js";
import type { BootstrapSourceRecord } from "./context-bootstrap.js";

type CursorRuleBootstrapInput = {
  readonly path: string;
  readonly name: string;
  readonly summary: string;
  readonly content: string;
};

type SkillBootstrapInput = {
  readonly name: string;
  readonly path: string;
  readonly scope: "project" | "user";
  readonly description: string;
};

function sha256Content(content: string): string {
  return runRustCommandSync(["rust", "sha256"], process.cwd(), content).trim();
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

export function discoverMcpSources(input: {
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

export function extractGuidanceConflicts(summaryLines: readonly string[]): readonly string[] {
  return summaryLines.filter((line) => /^Conflict:/i.test(line));
}

export function extractGuidanceWarnings(summaryLines: readonly string[]): readonly string[] {
  return summaryLines.filter((line) => /^(Deduped duplicate guidance|Conflict):/i.test(line));
}

function sourceDisplayName(sourcePath: string): string {
  const basename = path.basename(sourcePath);
  if (sourcePath.includes(`${path.sep}.sisyphus${path.sep}rules${path.sep}`)) {
    return `rules/${basename}`;
  }
  return basename;
}

export function buildGuidanceSourceRecords(input: {
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

export function buildCursorRuleSourceRecords(
  rules: readonly CursorRuleBootstrapInput[],
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

export function buildSkillSourceRecords(
  skills: readonly SkillBootstrapInput[],
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
