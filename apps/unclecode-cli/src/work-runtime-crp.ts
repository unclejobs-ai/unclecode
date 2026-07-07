import { createHash } from "node:crypto";

import { createAgentOpsStore } from "@unclecode/agentops-db";
import type { UncleCodeConfigExplanation } from "@unclecode/config-core";
import {
  createBuiltinProviderRegistry,
  listScopedMemoryLines,
  selectContextPacketFromStore,
} from "@unclecode/context-broker";
import type {
  ContextPacketSourceCategory,
  ContextPacketView,
  ContextPacketViewItem,
  ContextPacketViewWarning,
  ContextSourceCategory,
} from "@unclecode/contracts";

import {
  buildContextSummaryItems,
  estimateTokens,
} from "./work-runtime-context-items.js";

export type WorkShellContextPacketResolver = (input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly contextSummaryLines: readonly string[];
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly traceLines: readonly string[];
}) => Promise<ContextPacketView>;

type WorkShellCrpConfig = {
  readonly enabled: boolean;
  readonly tokenBudget: number;
  readonly modelWindow: number;
};

export function resolveWorkShellCrpConfig(explanation: UncleCodeConfigExplanation): WorkShellCrpConfig {
  return {
    enabled: explanation.settings.crp.value,
    tokenBudget: explanation.settings.crpBudget.value,
    modelWindow: explanation.settings.modelWindow.value,
  };
}

function contextSourceCategoryForPacketCategory(category: ContextPacketSourceCategory): ContextSourceCategory {
  return category === "provider-system-prompt" || category === "user" ? "system" : category;
}

function upsertPacketItemsAsContextSources(input: {
  readonly store: ReturnType<typeof createAgentOpsStore>;
  readonly projectId: string;
  readonly items: readonly ContextPacketViewItem[];
  readonly salience: number;
}): void {
  for (const item of input.items) {
    const content = item.preview ?? item.label;
    input.store.upsertContextSource({
      id: item.id,
      projectId: input.projectId,
      category: contextSourceCategoryForPacketCategory(item.category),
      label: item.label.slice(0, 120),
      content,
      reason: item.reason,
      salience: input.salience,
      tokenEstimate: item.tokenEstimate ?? estimateTokens(`${item.label} ${content}`),
    });
  }
}

export function createCrpAwareContextPacketResolver(
  legacy: WorkShellContextPacketResolver,
  bootstrap: {
    readonly sourceMetadata: readonly ContextPacketViewItem[];
    readonly bootstrapPacketItems?: readonly ContextPacketViewItem[];
    readonly bootstrapPacketWarnings?: readonly ContextPacketViewWarning[];
    readonly crpConfig: WorkShellCrpConfig;
    readonly env?: NodeJS.ProcessEnv;
    readonly userHomeDir?: string;
  },
): WorkShellContextPacketResolver {
  const crp = createCrpRuntime(legacy, bootstrap);
  return crp.resolveContextPacket;
}

/**
 * Context Inspector (Sprint 2): the Context Runbook overlay mutates
 * context_sources (pin/unpin/forget/include) directly through the AgentOps
 * store. The store is created lazily inside the CRP resolver closure, so this
 * factory builds both the resolver and a mutator that share the same store
 * instance. The mutator resolves the store lazily — if the overlay is opened
 * before any turn has run, it no-ops (the store does not exist yet).
 */
export function createCrpRuntime(
  legacy: WorkShellContextPacketResolver,
  bootstrap: {
    readonly sourceMetadata: readonly ContextPacketViewItem[];
    readonly bootstrapPacketItems?: readonly ContextPacketViewItem[];
    readonly bootstrapPacketWarnings?: readonly ContextPacketViewWarning[];
    readonly crpConfig: WorkShellCrpConfig;
    readonly env?: NodeJS.ProcessEnv;
    readonly userHomeDir?: string;
  },
): {
  readonly resolveContextPacket: WorkShellContextPacketResolver;
  readonly mutateContextSource: (action: {
    readonly kind: "pin" | "unpin" | "forget" | "include";
    readonly id: string;
  }) => void;
} {
  let crpState: {
    readonly store: ReturnType<typeof createAgentOpsStore>;
    readonly registry: ReturnType<typeof createBuiltinProviderRegistry>;
    readonly projectId: string;
    turnIndex: number;
  } | undefined;

  const resolveContextPacket: WorkShellContextPacketResolver = async (input) => {
    if (!bootstrap.crpConfig.enabled) {
      return legacy(input);
    }

    if (crpState === undefined) {
      const store = createAgentOpsStore();
      const projectId = createHash("sha256").update(input.cwd).digest("hex").slice(0, 16);
      store.addProject({ id: projectId, name: input.cwd.split("/").pop() ?? "workspace", repoPath: input.cwd });
      const registry = createBuiltinProviderRegistry(store, projectId, listScopedMemoryLines);
      crpState = { store, registry, projectId, turnIndex: 0 };
    }

    try {
      crpState.turnIndex += 1;

      for (const line of input.traceLines) {
        crpState.registry.runtime.pushTraceLine(line);
      }

      await crpState.registry.syncAll({
        cwd: input.cwd,
        sessionId: input.sessionId,
        ...(bootstrap.env !== undefined ? { env: bootstrap.env } : {}),
        ...(bootstrap.userHomeDir !== undefined ? { userHomeDir: bootstrap.userHomeDir } : {}),
      });

      upsertPacketItemsAsContextSources({
        store: crpState.store,
        projectId: crpState.projectId,
        items: bootstrap.sourceMetadata,
        salience: 0.95,
      });
      upsertPacketItemsAsContextSources({
        store: crpState.store,
        projectId: crpState.projectId,
        items: buildContextSummaryItems(input.contextSummaryLines),
        salience: 0.9,
      });
      upsertPacketItemsAsContextSources({
        store: crpState.store,
        projectId: crpState.projectId,
        items: bootstrap.bootstrapPacketItems ?? [],
        salience: 0.8,
      });

      return selectContextPacketFromStore({
        store: crpState.store,
        projectId: crpState.projectId,
        tokenBudget: bootstrap.crpConfig.tokenBudget,
        turnIndex: crpState.turnIndex,
        ...(bootstrap.bootstrapPacketWarnings !== undefined
          ? { warnings: bootstrap.bootstrapPacketWarnings }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[crp] fallback to legacy resolver: ${message}\n`);
      return legacy(input);
    }
  };

  const mutateContextSource = (action: {
    readonly kind: "pin" | "unpin" | "forget" | "include";
    readonly id: string;
  }): void => {
    if (!crpState) {
      return;
    }
    switch (action.kind) {
      case "pin":
        crpState.store.pinContextSource(crpState.projectId, action.id);
        return;
      case "unpin":
        crpState.store.unpinContextSource(crpState.projectId, action.id);
        return;
      case "forget":
        crpState.store.forgetContextSource(crpState.projectId, action.id);
        return;
      case "include":
        crpState.store.includeContextSource(crpState.projectId, action.id);
        return;
    }
  };

  return { resolveContextPacket, mutateContextSource };
}
