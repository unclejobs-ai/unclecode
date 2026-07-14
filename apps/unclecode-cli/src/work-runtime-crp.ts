import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";

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
import {
  createContextLedgerRuntime,
  createMemoryLineageAdapter,
  type ContextLedgerRuntime,
} from "./work-runtime-context-ledger.js";

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

export type CrpPerformanceSample = {
  readonly label: string;
  readonly durationMs: number;
  readonly cpuMs: number;
};

type RecordCrpPerformanceSample =
  ((sample: CrpPerformanceSample) => void) | undefined;

function measureSynchronousCrpWork<T>(
  record: RecordCrpPerformanceSample,
  label: string,
  operation: () => T,
): T {
  if (record === undefined) return operation();
  const startedAt = performance.now();
  const startedCpu = process.cpuUsage();
  try {
    return operation();
  } finally {
    const cpu = process.cpuUsage(startedCpu);
    record({
      label,
      durationMs: performance.now() - startedAt,
      cpuMs: (cpu.user + cpu.system) / 1_000,
    });
  }
}

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

const CONTEXT_SOURCE_UPSERT_BATCH_SIZE = 4;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function upsertPacketItemsAsContextSources(input: {
  readonly store: ReturnType<typeof createAgentOpsStore>;
  readonly projectId: string;
  readonly items: readonly ContextPacketViewItem[];
  readonly salience: number;
  readonly recordPerformanceSample?: RecordCrpPerformanceSample;
}): Promise<void> {
  for (
    let batchStart = 0;
    batchStart < input.items.length;
    batchStart += CONTEXT_SOURCE_UPSERT_BATCH_SIZE
  ) {
    const batchEnd = Math.min(
      batchStart + CONTEXT_SOURCE_UPSERT_BATCH_SIZE,
      input.items.length,
    );
    measureSynchronousCrpWork(
      input.recordPerformanceSample,
      "source-upsert-batch",
      () => {
        const sources = [];
        for (let index = batchStart; index < batchEnd; index += 1) {
          const item = input.items[index];
          if (item === undefined) continue;
          const content = item.preview ?? item.label;
          sources.push({
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
        input.store.upsertContextSources(sources);
      },
    );
    if (batchEnd < input.items.length) {
      await yieldToEventLoop();
    }
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
    readonly workspaceRoot?: string;
    readonly recordPerformanceSample?: RecordCrpPerformanceSample;
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

function openContextLifecycleStore(
  cwd: string,
  bootstrap: {
    readonly userHomeDir?: string;
    readonly storeHome?: string;
  },
): {
  readonly store: ReturnType<typeof createAgentOpsStore>;
  readonly projectId: string;
} {
  const storeHome = resolveStoreHome(bootstrap);
  const store = storeHome === undefined
    ? createAgentOpsStore()
    : createAgentOpsStore({ home: storeHome });
  const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  store.addProject({ id: projectId, name: basename(cwd) || "workspace", repoPath: cwd });
  return { store, projectId };
}

export function reconcileResumedContextLifecycle(input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly lastSubmittedContextReceiptId?: string;
  readonly userHomeDir?: string;
  readonly storeHome?: string;
}): {
  readonly invalidatedPreviewCount: number;
  readonly invalidatedMemoryCount: number;
  readonly warningLines: readonly string[];
} {
  const { store, projectId } = openContextLifecycleStore(input.cwd, input);
  try {
    store.expireMemoryLineage();
    let invalidatedPreviewCount = 0;
    const activePreview = store.getActiveContextPacketPreview(projectId, input.sessionId);
    if (activePreview !== undefined) {
      store.invalidateContextPacketReceipt(projectId, activePreview.id);
      store.markContextPolicySuggestionsStale(activePreview.id);
      invalidatedPreviewCount = 1;
    }

    let invalidatedMemoryCount = 0;
    for (const lineage of store.listActiveMemoryLineage(projectId)) {
      const origin = store.getContextPacketReceipt(
        projectId,
        lineage.originPacketReceiptId,
      );
      if (origin?.state === "submitted") continue;
      store.supersedeMemoryLineage(lineage.memoryId);
      invalidatedMemoryCount += 1;
    }

    const savedReceipt = input.lastSubmittedContextReceiptId === undefined
      ? undefined
      : store.getContextPacketReceipt(
          projectId,
          input.lastSubmittedContextReceiptId,
        );
    const savedReceiptInvalid = input.lastSubmittedContextReceiptId !== undefined
      && (
        savedReceipt?.state !== "submitted"
        || savedReceipt.sessionId !== input.sessionId
      );
    return {
      invalidatedPreviewCount,
      invalidatedMemoryCount,
      warningLines: [
        ...(invalidatedPreviewCount > 0
          ? [
              `Context resume · invalidated ${invalidatedPreviewCount} stale packet preview`,
            ]
          : []),
        ...(invalidatedMemoryCount > 0
          ? [
              `Memory lineage degraded · excluded ${invalidatedMemoryCount} active memory entr${invalidatedMemoryCount === 1 ? "y" : "ies"} with non-submitted provenance`,
            ]
          : []),
        ...(savedReceiptInvalid
          ? [
              "Context resume provenance degraded · saved submitted receipt is unavailable",
            ]
          : []),
      ],
    };
  } finally {
    store.close();
  }
}

/**
 * Context Inspector and lifecycle-ledger runtime. Tests and legacy callers
 * retain lazy store creation; production may provide `workspaceRoot` so the
 * lineage adapter is ready before initial memory prefetch.
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
    readonly workspaceRoot?: string;
    readonly recordPerformanceSample?: RecordCrpPerformanceSample;
  },
): {
  readonly resolveContextPacket: WorkShellContextPacketResolver;
  readonly mutateContextSource: (action: ContextSourceMutation) => ContextPacketViewActionReceipt | undefined;
  readonly undoLastContextSourceAction: () => ContextPacketViewActionReceipt | undefined;
  readonly listContextSourceActionReceipts: () => readonly ContextPacketViewActionReceipt[];
  readonly contextLedger: ContextLedgerRuntime;
  readonly getProjectId: () => string | undefined;
  readonly refreshCondensedHistory: () => Promise<void>;
} {
  let crpState: {
    readonly store: ReturnType<typeof createAgentOpsStore>;
    readonly registry: ReturnType<typeof createBuiltinProviderRegistry>;
    readonly projectId: string;
    turnIndex: number;
  } | undefined;
  const actionReceipts: ContextPacketViewActionReceipt[] = [];
  const undoStack: ContextSourceUndoEntry[] = [];
  const createCrpState = (cwd: string): NonNullable<typeof crpState> => {
    const { store, projectId } = openContextLifecycleStore(cwd, bootstrap);
    const memoryLineage = createMemoryLineageAdapter(() => store);
    const registry = createBuiltinProviderRegistry(
      store,
      projectId,
      (input) => listScopedMemoryLines({ ...input, lineage: memoryLineage }),
    );
    return { store, registry, projectId, turnIndex: 0 };
  };
  const workspaceRoot = bootstrap.workspaceRoot;
  if (bootstrap.crpConfig.enabled && workspaceRoot !== undefined) {
    crpState = measureSynchronousCrpWork(
      bootstrap.recordPerformanceSample,
      "store-open",
      () => createCrpState(workspaceRoot),
    );
  }


  const resolveContextPacket: WorkShellContextPacketResolver = async (input) => {
    if (!bootstrap.crpConfig.enabled) {
      return legacy(input);
    }

    if (crpState === undefined) {
      crpState = measureSynchronousCrpWork(
        bootstrap.recordPerformanceSample,
        "store-open",
        () => createCrpState(input.cwd),
      );
      await yieldToEventLoop();
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
      await yieldToEventLoop();

      await upsertPacketItemsAsContextSources({
        store: crpState.store,
        projectId: crpState.projectId,
        items: bootstrap.sourceMetadata,
        salience: 0.95,
        ...(bootstrap.recordPerformanceSample !== undefined
          ? { recordPerformanceSample: bootstrap.recordPerformanceSample }
          : {}),
      });
      await upsertPacketItemsAsContextSources({
        store: crpState.store,
        projectId: crpState.projectId,
        items: buildContextSummaryItems(input.contextSummaryLines).filter(
          (item) => item.category !== "workspace-guidance",
        ),
        salience: 0.9,
        ...(bootstrap.recordPerformanceSample !== undefined
          ? { recordPerformanceSample: bootstrap.recordPerformanceSample }
          : {}),
      });
      await upsertPacketItemsAsContextSources({
        store: crpState.store,
        projectId: crpState.projectId,
        items: buildWorkGraphContextItems(input.workGraph),
        salience: 0.93,
        ...(bootstrap.recordPerformanceSample !== undefined
          ? { recordPerformanceSample: bootstrap.recordPerformanceSample }
          : {}),
      });
      await upsertPacketItemsAsContextSources({
        store: crpState.store,
        projectId: crpState.projectId,
        items: bootstrap.bootstrapPacketItems ?? [],
        salience: 0.8,
        ...(bootstrap.recordPerformanceSample !== undefined
          ? { recordPerformanceSample: bootstrap.recordPerformanceSample }
          : {}),
      });
      await yieldToEventLoop();

      const activeState = crpState;
      return measureSynchronousCrpWork(
        bootstrap.recordPerformanceSample,
        "packet-select",
        () => selectContextPacketFromStore({
          store: activeState.store,
          projectId: activeState.projectId,
          tokenBudget: bootstrap.crpConfig.tokenBudget,
          turnIndex: activeState.turnIndex,
          ...(bootstrap.bootstrapPacketWarnings !== undefined
            ? { warnings: bootstrap.bootstrapPacketWarnings }
            : {}),
        }),
      );
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

  const requireLedgerStore = () => {
    if (crpState === undefined) {
      throw new Error(
        "Context ledger is unavailable until a context packet has been resolved for this session.",
      );
    }
    return { store: crpState.store, projectId: crpState.projectId };
  };

  const contextLedger = createContextLedgerRuntime({
    requireStore: requireLedgerStore,
    listActionReceipts: listContextSourceActionReceipts,
  });

  const refreshCondensedHistory = (): Promise<void> => {
    if (crpState === undefined) {
      throw new Error("Context ledger is unavailable until a context packet has been resolved for this session.");
    }
    // The immediately following forced packet resolution pushes the current
    // trace exactly once and syncs every provider. Clearing here prevents the
    // old condensed buffer from being appended to itself during that refresh.
    crpState.registry.condensedHistory.clearTrace();
    return Promise.resolve();
  };

  const getProjectId = (): string | undefined => crpState?.projectId;

  return {
    resolveContextPacket,
    mutateContextSource,
    undoLastContextSourceAction,
    listContextSourceActionReceipts,
    contextLedger,
    getProjectId,
    refreshCondensedHistory,
  };
}
