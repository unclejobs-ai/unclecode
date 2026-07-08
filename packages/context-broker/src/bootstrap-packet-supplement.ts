import path from "node:path";

import type { ContextPacketViewItem, ContextPacketViewWarning } from "@unclecode/contracts";

import type { BootstrapSnapshot } from "./context-bootstrap.js";

export function buildBootstrapSummaryLines(snapshot: BootstrapSnapshot): readonly string[] {
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
