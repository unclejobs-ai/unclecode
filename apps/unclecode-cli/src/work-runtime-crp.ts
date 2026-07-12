import { createHash } from "node:crypto";
import { basename, join } from "node:path";

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
  ContextPacketViewAction,
  ContextPacketViewActionReceipt,
  ContextPacketViewItem,
  ContextPacketViewSourceState,
  ContextPacketViewWarning,
  ContextSourceCategory,
  WorkGraph,
} from "@unclecode/contracts";

import {
  buildContextSummaryItems,
  buildWorkGraphContextItems,
  estimateTokens,
} from "./work-runtime-context-items.js";

export type WorkShellContextPacketResolver = (input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly contextSummaryLines: readonly string[];
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly traceLines: readonly string[];
  readonly workGraph?: WorkGraph | undefined;
}) => Promise<ContextPacketView>;

type WorkShellCrpConfig = {
  readonly enabled: boolean;
  readonly tokenBudget: number;
  readonly modelWindow: number;
};

type ContextSourceMutationKind = "pin" | "unpin" | "forget" | "hold-back" | "include";

type ContextSourceMutation = {
  readonly kind: ContextSourceMutationKind;
  readonly id: string;
};

type ContextSourceUndoEntry = {
  readonly action: ContextPacketViewAction;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly before: ContextPacketViewSourceState;
  readonly after: ContextPacketViewSourceState;
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
    readonly storeHome?: string;
  },
): WorkShellContextPacketResolver {
  const crp = createCrpRuntime(legacy, bootstrap);
  return crp.resolveContextPacket;
}

function resolveStoreHome(bootstrap: {
  readonly userHomeDir?: string;
  readonly storeHome?: string;
}): string | undefined {
  if (bootstrap.storeHome !== undefined) {
    return bootstrap.storeHome;
  }
  return bootstrap.userHomeDir === undefined
    ? undefined
    : join(bootstrap.userHomeDir, ".unclecode", "agentops");
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
    readonly storeHome?: string;
  },
): {
  readonly resolveContextPacket: WorkShellContextPacketResolver;
  readonly mutateContextSource: (action: ContextSourceMutation) => ContextPacketViewActionReceipt | undefined;
  readonly undoLastContextSourceAction: () => ContextPacketViewActionReceipt | undefined;
  readonly listContextSourceActionReceipts: () => readonly ContextPacketViewActionReceipt[];
} {
  let crpState: {
    readonly store: ReturnType<typeof createAgentOpsStore>;
    readonly registry: ReturnType<typeof createBuiltinProviderRegistry>;
    readonly projectId: string;
    turnIndex: number;
  } | undefined;
  const actionReceipts: ContextPacketViewActionReceipt[] = [];
  const undoStack: ContextSourceUndoEntry[] = [];

  const resolveContextPacket: WorkShellContextPacketResolver = async (input) => {
    if (!bootstrap.crpConfig.enabled) {
      return legacy(input);
    }

    if (crpState === undefined) {
      const storeHome = resolveStoreHome(bootstrap);
      const store = storeHome === undefined ? createAgentOpsStore() : createAgentOpsStore({ home: storeHome });
      const projectId = createHash("sha256").update(input.cwd).digest("hex").slice(0, 16);
      store.addProject({ id: projectId, name: basename(input.cwd) || "workspace", repoPath: input.cwd });
      const registry = createBuiltinProviderRegistry(store, projectId, listScopedMemoryLines);
      crpState = { store, registry, projectId, turnIndex: 0 };
    }

    try {
      crpState.turnIndex += 1;

      for (const line of input.traceLines) {
        crpState.registry.runtime.pushTraceLine(line);
        crpState.registry.condensedHistory.pushTraceLine(line);
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
        items: buildWorkGraphContextItems(input.workGraph),
        salience: 0.93,
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

  const pushReceipt = (receipt: ContextPacketViewActionReceipt): ContextPacketViewActionReceipt => {
    actionReceipts.push(receipt);
    return receipt;
  };

  const resolveSourceState = (
    state: NonNullable<typeof crpState>,
    sourceId: string,
  ): ContextPacketViewSourceState | undefined => {
    const selection = state.store.selectContextSources({
      projectId: state.projectId,
      tokenBudget: Number.MAX_SAFE_INTEGER,
      turnIndex: state.turnIndex,
    });
    const source = [...selection.selected, ...selection.heldBack].find((item) => item.id === sourceId);
    if (source === undefined) {
      return undefined;
    }
    return {
      category: source.category,
      label: source.label,
      includedInModel: source.includedInModel,
      salience: source.salience,
      tokenEstimate: source.tokenEstimate,
    };
  };

  const normalizeAction = (kind: ContextSourceMutationKind): ContextPacketViewAction => {
    switch (kind) {
      case "pin":
      case "unpin":
      case "include":
        return kind;
      case "forget":
      case "hold-back":
        return "hold-back";
    }
  };

  const formatReceiptMessage = (input: {
    readonly action: ContextPacketViewAction;
    readonly sourceLabel: string;
    readonly before: ContextPacketViewSourceState;
    readonly after: ContextPacketViewSourceState;
  }): string => {
    const beforeModel = input.before.includedInModel ? "model on" : "model off";
    const afterModel = input.after.includedInModel ? "model on" : "model off";
    return `${input.action} ${input.sourceLabel} · ${beforeModel} -> ${afterModel}`;
  };

  const mutateContextSource = (action: ContextSourceMutation): ContextPacketViewActionReceipt | undefined => {
    if (!crpState) {
      return undefined;
    }
    const before = resolveSourceState(crpState, action.id);
    if (before === undefined) {
      return undefined;
    }
    const receiptAction = normalizeAction(action.kind);
    switch (action.kind) {
      case "pin":
        crpState.store.pinContextSource(crpState.projectId, action.id);
        break;
      case "unpin":
        crpState.store.unpinContextSource(crpState.projectId, action.id);
        break;
      case "forget":
      case "hold-back":
        crpState.store.forgetContextSource(crpState.projectId, action.id);
        break;
      case "include":
        crpState.store.includeContextSource(crpState.projectId, action.id);
        break;
    }
    const after = resolveSourceState(crpState, action.id);
    if (after === undefined) {
      return undefined;
    }
    undoStack.push({
      action: receiptAction,
      sourceId: action.id,
      sourceLabel: before.label,
      before,
      after,
    });
    return pushReceipt({
      id: `context-action-${actionReceipts.length + 1}`,
      action: receiptAction,
      sourceId: action.id,
      sourceLabel: before.label,
      message: formatReceiptMessage({
        action: receiptAction,
        sourceLabel: before.label,
        before,
        after,
      }),
      canUndo: true,
      before,
      after,
    });
  };

  const undoLastContextSourceAction = (): ContextPacketViewActionReceipt | undefined => {
    if (!crpState) {
      return undefined;
    }
    const entry = undoStack.pop();
    if (entry === undefined) {
      return undefined;
    }
    const beforeUndo = resolveSourceState(crpState, entry.sourceId) ?? entry.after;
    crpState.store.restoreContextSourceState({
      projectId: crpState.projectId,
      id: entry.sourceId,
      salience: entry.before.salience,
      includedInModel: entry.before.includedInModel,
    });
    const afterUndo = resolveSourceState(crpState, entry.sourceId);
    if (afterUndo === undefined) {
      return undefined;
    }
    return pushReceipt({
      id: `context-action-${actionReceipts.length + 1}`,
      action: "undo",
      sourceId: entry.sourceId,
      sourceLabel: entry.sourceLabel,
      message: formatReceiptMessage({
        action: "undo",
        sourceLabel: entry.sourceLabel,
        before: beforeUndo,
        after: afterUndo,
      }),
      canUndo: undoStack.length > 0,
      before: beforeUndo,
      after: afterUndo,
    });
  };

  const listContextSourceActionReceipts = (): readonly ContextPacketViewActionReceipt[] => [...actionReceipts];

  return {
    resolveContextPacket,
    mutateContextSource,
    undoLastContextSourceAction,
    listContextSourceActionReceipts,
  };
}
