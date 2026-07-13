import { basename } from "node:path";

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
      const canonicalSources = guidance.guidanceSources.map((source) => ({
        id: source.id,
        label: "Workspace guidance",
        content: `${basename(source.path)} — ${WORKSPACE_GUIDANCE_SAFE_PREVIEW}`,
        sha256: source.sha256,
      }));
      const sources = canonicalSources.length > 0
        ? canonicalSources
        : guidance.contextSummaryLines.map((line, index) => {
            const text = workspaceGuidancePacketText(line);
            return {
              id: `workspace-guidance-${index + 1}`,
              label: text.label,
              content: text.content,
              sha256: undefined,
            };
          });

      for (const source of sources) {
        const upsert: UpsertContextSourceInput = {
          id: source.id,
          projectId: input.projectId,
          category: "workspace-guidance",
          label: source.label,
          content: source.content,
          reason: "workspace guidance summary",
          salience: deriveSalience({ base: 0.7, length: source.content.length }),
          tokenEstimate: estimateTokens(`${source.label} ${source.content}`),
          ...(source.sha256 === undefined ? {} : { sha256: source.sha256 }),
        };
        input.store.upsertContextSource(upsert);
        touched.push(source.id);
      }
      return touched;
    },
  };
}
