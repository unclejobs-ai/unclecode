import type { UpsertContextSourceInput } from "@unclecode/contracts";

import {
  deriveSalience,
  estimateTokens,
  type ContextProvider,
} from "./crp-provider-utils.js";
import { loadCachedWorkspaceGuidance } from "./workspace-guidance.js";

const WORKSPACE_GUIDANCE_SAFE_PREVIEW =
  "Workspace guidance is active; raw guidance text stays out of the context view.";

function extractWorkspaceGuidanceSource(line: string): string | undefined {
  const sourceMatch = /^((?:AGENTS|CLAUDE|GEMINI|UNCLECODE)(?:\.local)?\.md|rules\/.+\.md):/i.exec(line);
  return sourceMatch?.[1];
}

function workspaceGuidancePacketText(line: string): { readonly label: string; readonly content: string } {
  const source = extractWorkspaceGuidanceSource(line);
  if (source === undefined) {
    return { label: line.slice(0, 120), content: line };
  }
  return {
    label: "Workspace guidance",
    content: `${source} — ${WORKSPACE_GUIDANCE_SAFE_PREVIEW}`,
  };
}

export function createWorkspaceGuidanceProvider(): ContextProvider {
  return {
    providerId: "workspace-guidance",
    categories: ["workspace-guidance", "workspace"],
    refresh: "on-change",
    trustTier: "builtin",
    async sync(input) {
      const touched: string[] = [];
      const guidance = await loadCachedWorkspaceGuidance({
        cwd: input.cwd,
        ...(input.userHomeDir !== undefined ? { userHomeDir: input.userHomeDir } : {}),
      });
      const lines = guidance.contextSummaryLines;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line === undefined) continue;
        const text = workspaceGuidancePacketText(line);
        const id = `workspace-guidance-${i + 1}`;
        const upsert: UpsertContextSourceInput = {
          id,
          projectId: input.projectId,
          category: "workspace-guidance",
          label: text.label,
          content: text.content,
          reason: "workspace guidance summary",
          salience: deriveSalience({ base: 0.7, length: text.content.length }),
          tokenEstimate: estimateTokens(`${text.label} ${text.content}`),
        };
        input.store.upsertContextSource(upsert);
        touched.push(id);
      }
      return touched;
    },
  };
}
